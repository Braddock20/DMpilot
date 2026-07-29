'use strict';

/**
 * Chat grabber — pulls recent messages + media from a chat, downloads
 * any view-once media it can find, packages everything into a zip, and
 * returns the path so the caller can send it back over WhatsApp.
 *
 * Strategy:
 *   1. Try the in-memory ring buffer (populated by messages.upsert)
 *   2. If we need more, call fetchMessageHistory() to ask the server
 *      for older messages (works on DMs; groups may need additional
 *      participant context)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');

const config = require('./config');

fs.mkdirSync(config.grabTempDir, { recursive: true });

// ---- in-memory ring buffer (shared with index.js) -----------------------
// index.js calls `recordIncoming` for every message it processes.
const ringBuffer = new Map(); // chatJid -> Array<msg>
const RING_LIMIT = 500;

function recordIncoming(msg) {
  if (!msg?.key?.remoteJid) return;
  const jid = msg.key.remoteJid;
  const list = ringBuffer.get(jid) || [];
  list.push(msg);
  while (list.length > RING_LIMIT) list.shift();
  ringBuffer.set(jid, list);
}

function getBuffered(jid) {
  return (ringBuffer.get(jid) || []).slice();
}

// ---- message unwrapping -------------------------------------------------
function unwrapMessage(message) {
  if (!message) return { kind: null, media: null, text: null, isViewOnce: false };
  if (message.viewOnceMessage || message.viewOnceMessageV2) {
    const inner = unwrapMessage((message.viewOnceMessageV2 || message.viewOnceMessage).message);
    inner.isViewOnce = true;
    return inner;
  }
  if (message.ephemeralMessage) return unwrapMessage(message.ephemeralMessage.message);
  if (message.imageMessage) {
    return { kind: 'image', media: message.imageMessage, text: message.imageMessage.caption || null, isViewOnce: false };
  }
  if (message.videoMessage) {
    return { kind: 'video', media: message.videoMessage, text: message.videoMessage.caption || null, isViewOnce: false };
  }
  if (message.audioMessage) {
    return { kind: 'audio', media: message.audioMessage, text: null, isViewOnce: false };
  }
  if (message.documentMessage) {
    return { kind: 'document', media: message.documentMessage, text: message.documentMessage.caption || null, isViewOnce: false };
  }
  if (message.stickerMessage) {
    return { kind: 'sticker', media: message.stickerMessage, text: null, isViewOnce: false };
  }
  if (message.conversation) return { kind: 'text', media: null, text: message.conversation, isViewOnce: false };
  if (message.extendedTextMessage) {
    return { kind: 'text', media: null, text: message.extendedTextMessage.text, isViewOnce: false };
  }
  return { kind: 'unknown', media: null, text: null, isViewOnce: false };
}

const KINDS_TO_DOWNLOAD = new Set(['image', 'video', 'audio', 'document', 'sticker']);

// ---- media download -----------------------------------------------------
async function downloadMedia(sock, mediaNode, kind, outDir, baseName) {
  if (!KINDS_TO_DOWNLOAD.has(kind)) return null;
  let buffer;
  try {
    const stream = await sock.downloadMediaMessage(
      { message: { [kind + 'Message']: mediaNode } },
      'buffer',
    );
    if (Buffer.isBuffer(stream)) {
      buffer = stream;
    } else if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
      const chunks = [];
      for await (const c of stream) chunks.push(c);
      buffer = Buffer.concat(chunks);
    } else if (stream && typeof stream.then === 'function') {
      buffer = Buffer.from(await stream);
    } else {
      return null;
    }
  } catch (err) {
    console.warn('[grab] download failed for', kind, '-', err?.message || err);
    return null;
  }
  if (!buffer || !buffer.length) return null;
  const mime = (mediaNode.mimetype || 'application/octet-stream').split('/');
  const ext = mediaNode.fileName
    ? path.extname(mediaNode.fileName) || `.${mime[1] || 'bin'}`
    : `.${mime[1] || 'bin'}`;
  const safeName = baseName.replace(/[^\w.-]/g, '_') + ext;
  const full = path.join(outDir, safeName);
  fs.writeFileSync(full, buffer);
  return { filename: safeName, path: full, bytes: buffer.length, kind };
}

// ---- message history loader --------------------------------------------
async function loadRecentMessages(sock, chatJid, count) {
  const limit = Math.max(1, Math.min(500, count || 50));
  const messages = getBuffered(chatJid);

  // Need more? Try the network (only works when the chat is fully open to us)
  if (messages.length < limit && typeof sock.fetchMessageHistory === 'function') {
    try {
      // Find the oldest message we have so far in this chat, so the server
      // can paginate from there.
      let oldest = null;
      for (const m of messages) {
        if (!m.message) continue;
        if (!oldest || (m.messageTimestamp || 0) < (oldest.messageTimestamp || 0)) {
          oldest = m;
        }
      }
      const remaining = limit - messages.length;
      let fetched = [];
      if (oldest && oldest.key) {
        fetched = await sock.fetchMessageHistory(
          remaining,
          oldest.key,
          Number(oldest.messageTimestamp || 0) * 1000,
        );
      } else {
        // No local context; just ask for the last N
        fetched = await sock.fetchMessageHistory(remaining, { remoteJid: chatJid, fromMe: false }, 0);
      }
      if (Array.isArray(fetched) && fetched.length) {
        for (const m of fetched) {
          if (m?.message) messages.push(m);
        }
      }
    } catch (err) {
      console.warn('[grab] fetchMessageHistory failed:', err?.message || err);
    }
  }
  return messages;
}

// ---- materialization ---------------------------------------------------
async function materializeMessages(sock, messages, outDir) {
  const lines = [];
  const mediaFiles = [];
  let viewOnceCount = 0;

  const sorted = [...messages]
    .filter((m) => m && m.message)
    .sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));

  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
    const unwrapped = unwrapMessage(m.message);
    if (unwrapped.isViewOnce) viewOnceCount++;

    const ts = m.messageTimestamp
      ? new Date(Number(m.messageTimestamp) * 1000).toISOString()
      : 'unknown';
    const sender =
      m.pushName || m.participant || m.key?.participant || m.key?.remoteJid || 'unknown';

    if (unwrapped.kind === 'text') {
      lines.push(`[${ts}] ${sender}: ${unwrapped.text || ''}`);
    } else if (unwrapped.kind && KINDS_TO_DOWNLOAD.has(unwrapped.kind)) {
      const base = `msg-${String(i).padStart(4, '0')}-${unwrapped.kind}${unwrapped.isViewOnce ? '-viewonce' : ''}`;
      const saved = await downloadMedia(sock, unwrapped.media, unwrapped.kind, outDir, base);
      if (saved) {
        lines.push(
          `[${ts}] ${sender}: <${unwrapped.kind}${unwrapped.isViewOnce ? ' (view-once)' : ''}> -> ${saved.filename} (${saved.bytes} bytes)`,
        );
        mediaFiles.push(saved);
      } else {
        lines.push(`[${ts}] ${sender}: <${unwrapped.kind} - download failed>`);
      }
    } else {
      lines.push(`[${ts}] ${sender}: <${unwrapped.kind || 'unknown'}>`);
    }
  }

  const textPath = path.join(outDir, 'transcript.txt');
  fs.writeFileSync(textPath, lines.join('\n') + '\n', 'utf8');
  return { textPath, mediaFiles, viewOnceCount };
}

function zipDir(outDir) {
  return new Promise((resolve, reject) => {
    const zipPath = path.join(outDir, 'chat-export.zip');
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', () => resolve(zipPath));
    archive.on('warning', (err) => (err.code === 'ENOENT' ? console.warn(err) : reject(err)));
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(
      outDir,
      false,
      (entry) => (entry.name.endsWith('chat-export.zip') ? false : entry),
    );
    archive.finalize();
  });
}

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (_) {
    /* noop */
  }
}

// ---- public entry points -----------------------------------------------
async function grabChat(sock, chatJid, count) {
  const limit = Math.min(config.grabMaxMessages, Number(count) || 50);
  const jobId = crypto.randomBytes(4).toString('hex');
  const outDir = path.join(config.grabTempDir, `grab-${Date.now()}-${jobId}`);
  fs.mkdirSync(outDir, { recursive: true });
  const mediaDir = path.join(outDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  let messages;
  try {
    messages = await loadRecentMessages(sock, chatJid, limit);
  } catch (err) {
    safeRm(outDir);
    throw new Error('failed to load messages: ' + (err?.message || err));
  }

  if (!messages.length) {
    safeRm(outDir);
    return { empty: true };
  }

  const { textPath, mediaFiles, viewOnceCount } = await materializeMessages(sock, messages, mediaDir);
  fs.copyFileSync(textPath, path.join(outDir, 'transcript.txt'));
  const zipPath = await zipDir(outDir);
  const stats = fs.statSync(zipPath);
  return {
    empty: false,
    zipPath,
    bytes: stats.size,
    mediaCount: mediaFiles.length,
    viewOnceCount,
    messageCount: messages.length,
    tempDir: outDir,
  };
}

async function grabViewOnce(sock, chatJid) {
  const messages = await loadRecentMessages(sock, chatJid, config.grabMaxMessages);
  const sorted = [...messages]
    .filter((m) => m && m.message)
    .sort((a, b) => (b.messageTimestamp || 0) - (a.messageTimestamp || 0));
  for (const m of sorted) {
    const unwrapped = unwrapMessage(m.message);
    if (unwrapped.isViewOnce && KINDS_TO_DOWNLOAD.has(unwrapped.kind)) {
      const jobId = crypto.randomBytes(4).toString('hex');
      const outDir = path.join(config.grabTempDir, `viewonce-${Date.now()}-${jobId}`);
      fs.mkdirSync(outDir, { recursive: true });
      const base = `viewonce-${unwrapped.kind}`;
      try {
        const saved = await downloadMedia(sock, unwrapped.media, unwrapped.kind, outDir, base);
        if (saved) {
          // Send back the raw media path so the caller can post it directly,
          // and also build a zip for archival.
          const zipPath = await zipDir(outDir);
          return {
            found: true,
            kind: unwrapped.kind,
            mediaPath: saved.path,
            zipPath,
            bytes: fs.statSync(zipPath).size,
            tempDir: outDir,
          };
        }
      } finally {
        /* keep the files; caller cleans up */
      }
    }
  }
  return { found: false };
}

module.exports = {
  grabChat,
  grabViewOnce,
  unwrapMessage,
  recordIncoming,
  getBuffered,
};
