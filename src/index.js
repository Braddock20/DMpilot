'use strict';

/**
 * WhatsApp AI Replier
 * --------------------------------------------------------------
 * - Library  : @whiskeysockets/baileys  (most powerful, pairing-code support)
 * - AI       : Google Gemini            (gemini-1.5-flash by default)
 * - Hosting  : Render (Web Service, free tier OK with UptimeRobot)
 *
 * Features:
 *   - Pairing-code auth (no QR scan)
 *   - Auto-typing / auto-recording presence
 *   - Auto-react to incoming messages
 *   - AI replies with conversation memory
 *   - Owner commands: !grab, !grabviewonce, !ping, !status
 *   - Free-tier resilient reconnect
 *   - HTTP /health endpoint for Render + UptimeRobot
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  DisconnectReason,
  isJidGroup,
  isJidBroadcast,
  areJidsSameUser,
} = require('@whiskeysockets/baileys');

const http = require('http');
const fs = require('fs');
const pino = require('pino');

const config = require('./config');
const { generateReply } = require('./gemini');
const { grabChat, grabViewOnce, unwrapMessage, recordIncoming } = require('./grabber');

// ---- shared state --------------------------------------------------------
const botState = {
  startedAt: Date.now(),
  connected: false,
  lastError: null,
  lastMessageAt: null,
  pairingCode: null,
  reconnectAttempts: 0,
  paired: false,
};

/** Map<jid, number(ms)> — last reply timestamp per chat (cooldowns) */
const lastReplyAt = new Map();
/** Map<jid, Array<{role, text, sender, ts}>> — rolling per-chat history */
const chatHistory = new Map();
/** Map<jid, 'typing'|'recording'> — per-chat presence flavor */
const chatPresence = new Map();

// ---- sanity checks -------------------------------------------------------
if (!config.phoneNumber) {
  throw new Error('PHONE_NUMBER is not set. Add it to your .env or Render env vars.');
}
if (!config.gemini.apiKey) {
  throw new Error('GEMINI_API_KEY is not set. Add it to your .env or Render env vars.');
}

// ---- helpers -------------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function humanDelay() {
  const ms = 700 + Math.floor(Math.random() * 1500);
  await sleep(ms);
}

function chunk(text, size = 4000) {
  if (text.length <= size) return [text];
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function pushHistory(jid, role, text, sender) {
  const list = chatHistory.get(jid) || [];
  list.push({ role, text, sender, ts: Date.now() });
  while (list.length > Math.max(2, config.contextWindow) * 2) list.shift();
  chatHistory.set(jid, list);
}

function getHistory(jid) {
  const list = chatHistory.get(jid) || [];
  return list.slice(-config.contextWindow);
}

function withinCooldown(jid) {
  const last = lastReplyAt.get(jid) || 0;
  return Date.now() - last < config.cooldownMs;
}

function markReplied(jid) {
  lastReplyAt.set(jid, Date.now());
}

function extractText(msg) {
  const m = msg.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ''
  );
}

function isOwner(jid) {
  if (!config.ownerJids.length) return false;
  return config.ownerJids.some((owner) => areJidsSameUser(owner, jid));
}

function isOwnerMessage(msg) {
  const senderJid = msg.key.participant || msg.key.remoteJid;
  return isOwner(senderJid);
}

function hasMedia(m) {
  if (!m) return false;
  return Boolean(
    m.imageMessage ||
      m.videoMessage ||
      m.audioMessage ||
      m.documentMessage ||
      m.stickerMessage,
  );
}

// ---- presence (autotyping / autorecording) -------------------------------
const REACT_EMOJIS = config.autoReactEmojis
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function pickPresenceFlavor(jid) {
  // Cache per chat so each chat always gets the same flavor (less spammy)
  if (chatPresence.has(jid)) return chatPresence.get(jid);
  let flavor;
  if (config.presenceMode === 'both') {
    flavor = Math.random() < 0.5 ? 'composing' : 'recording';
  } else if (config.presenceMode === 'recording') {
    flavor = 'recording';
  } else {
    flavor = 'composing';
  }
  chatPresence.set(jid, flavor);
  return flavor;
}

async function setPresence(sock, jid, kind) {
  try {
    if (kind === 'composing' && !config.autoTyping) return;
    if (kind === 'recording' && !config.autoRecording && config.presenceMode !== 'recording') return;
    // Map our internal kinds to Baileys presence codes:
    //   composing -> 'composing' (typing)
    //   recording -> 'recording' (voice note style)
    await sock.sendPresenceUpdate(kind, jid);
  } catch (_) {
    /* non-fatal */
  }
}

async function pausePresence(sock, jid) {
  try {
    await sock.sendPresenceUpdate('paused', jid);
  } catch (_) {
    /* non-fatal */
  }
}

// ---- autoreact -----------------------------------------------------------
async function maybeAutoReact(sock, msg) {
  if (!config.autoReact || !REACT_EMOJIS.length) return;
  const m = msg.message || {};
  const hasText = Boolean(extractText(msg).trim());
  const isMedia = hasMedia(m) || m.viewOnceMessage || m.viewOnceMessageV2;
  if (hasText && !config.autoReactOnText) return;
  if (isMedia && !config.autoReactOnMedia) return;
  if (!hasText && !isMedia) return;

  // Don't react to other reactions / protocol messages
  if (m.reactionMessage || m.protocolMessage) return;

  const emoji = REACT_EMOJIS[Math.floor(Math.random() * REACT_EMOJIS.length)];
  try {
    await sock.sendMessage(msg.key.remoteJid, {
      react: { text: emoji, key: msg.key },
    });
  } catch (err) {
    // Reactions are best-effort
    console.warn('[react] failed:', err?.message || err);
  }
}

// ---- reply policy --------------------------------------------------------
function shouldAIReply(msg, chatJid) {
  if (isJidBroadcast(chatJid)) return { ok: false, reason: 'broadcast' };
  const isGroup = isJidGroup(chatJid);
  const senderJid = msg.key.participant || msg.key.remoteJid;

  // Owner replies happen through the command layer; for the AI path we
  // also let them through here, but cooldowns still apply.
  if (config.ownerJids.length && isOwner(senderJid)) {
    return { ok: true, isGroup, senderJid, owner: true };
  }

  if (config.allowedJids.length && !config.allowedJids.includes(chatJid)) {
    return { ok: false, reason: 'not in ALLOWED_JIDS' };
  }

  if (config.replyScope === 'dm' && isGroup) {
    return { ok: false, reason: 'scope=dm, group ignored' };
  }
  if (config.replyScope === 'groups' && !isGroup) {
    return { ok: false, reason: 'scope=groups, dm ignored' };
  }

  if (isGroup && config.groupMentionOnly) {
    const mentioned =
      Array.isArray(msg.message?.extendedTextMessage?.contextInfo?.mentionedJid) &&
      msg.message.extendedTextMessage.contextInfo.mentionedJid.length > 0;
    if (!mentioned) return { ok: false, reason: 'group, not mentioned' };
  }

  return { ok: true, isGroup, senderJid, owner: false };
}

// ---- command handling (owner only) --------------------------------------
const COMMANDS = {
  '!ping': async (sock, msg) => {
    await sock.sendMessage(msg.key.remoteJid, { text: 'pong 🏓' }, { quoted: msg });
  },

  '!status': async (sock, msg) => {
    const uptime = Math.floor((Date.now() - botState.startedAt) / 1000);
    const text =
      `🤖 *whatsapp-ai-replier*\n` +
      `connected: ${botState.connected}\n` +
      `uptime: ${uptime}s\n` +
      `reconnects: ${botState.reconnectAttempts}\n` +
      `last message: ${botState.lastMessageAt ? new Date(botState.lastMessageAt).toISOString() : 'never'}\n` +
      `model: ${config.gemini.model}\n` +
      `scope: ${config.replyScope}\n` +
      `cooldown: ${config.cooldownMs / 1000}s`;
    await sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
  },

  '!grab': async (sock, msg, args) => {
    const count = Math.max(1, Math.min(config.grabMaxMessages, parseInt(args[0] || '50', 10) || 50));
    await sock.sendMessage(msg.key.remoteJid, { text: `⏳ grabbing last ${count} messages...` }, { quoted: msg });
    try {
      const result = await grabChat(sock, msg.key.remoteJid, count);
      if (result.empty) {
        await sock.sendMessage(msg.key.remoteJid, { text: 'no messages found.' }, { quoted: msg });
        return;
      }
      const caption =
        `📦 chat export\n` +
        `${result.messageCount} messages, ${result.mediaCount} media files, ` +
        `${result.viewOnceCount} view-once — ${(result.bytes / 1024).toFixed(1)} KB`;
      await sock.sendMessage(
        msg.key.remoteJid,
        {
          document: fs.readFileSync(result.zipPath),
          mimetype: 'application/zip',
          fileName: `chat-export-${Date.now()}.zip`,
          caption,
        },
        { quoted: msg },
      );
      // Cleanup
      try { fs.rmSync(result.tempDir, { recursive: true, force: true }); } catch (_) { /* noop */ }
    } catch (err) {
      await sock.sendMessage(
        msg.key.remoteJid,
        { text: `grab failed: ${err?.message || err}` },
        { quoted: msg },
      );
    }
  },

  '!grabviewonce': async (sock, msg) => {
    await sock.sendMessage(msg.key.remoteJid, { text: '🔎 searching for view-once media...' }, { quoted: msg });
    try {
      const result = await grabViewOnce(sock, msg.key.remoteJid);
      if (!result.found) {
        await sock.sendMessage(
          msg.key.remoteJid,
          { text: 'no view-once media found in recent messages.' },
          { quoted: msg },
        );
        return;
      }
      // Send the extracted media first (so you can see it), then the zip
      const mediaBuffer = fs.readFileSync(result.mediaPath);
      const msgOptions = { quoted: msg };
      if (result.kind === 'image') {
        await sock.sendMessage(msg.key.remoteJid, { image: mediaBuffer, caption: '👀 view-once image' }, msgOptions);
      } else if (result.kind === 'video') {
        await sock.sendMessage(msg.key.remoteJid, { video: mediaBuffer, caption: '👀 view-once video' }, msgOptions);
      } else if (result.kind === 'audio') {
        await sock.sendMessage(msg.key.remoteJid, { audio: mediaBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: true }, msgOptions);
      } else {
        await sock.sendMessage(
          msg.key.remoteJid,
          { document: mediaBuffer, fileName: `viewonce.${result.kind}`, mimetype: 'application/octet-stream' },
          msgOptions,
        );
      }
      await sock.sendMessage(
        msg.key.remoteJid,
        { text: `✅ view-once ${result.kind} extracted. zip: ${(result.bytes / 1024).toFixed(1)} KB` },
        { quoted: msg },
      );
    } catch (err) {
      await sock.sendMessage(
        msg.key.remoteJid,
        { text: `grabviewonce failed: ${err?.message || err}` },
        { quoted: msg },
      );
    }
  },

  '!help': async (sock, msg) => {
    const help =
      `🤖 *commands*\n` +
      `!ping - check the bot is alive\n` +
      `!status - show uptime + config\n` +
      `!grab <N> - zip the last N messages (cap ${config.grabMaxMessages})\n` +
      `!grabviewonce - extract the most recent view-once media\n` +
      `!help - this message\n\n` +
      `auto-features: typing=${config.autoTyping}, recording=${config.autoRecording}, react=${config.autoReact}`;
    await sock.sendMessage(msg.key.remoteJid, { text: help }, { quoted: msg });
  },
};

async function maybeHandleCommand(sock, msg) {
  if (!isOwnerMessage(msg)) return false;
  const text = extractText(msg);
  if (!text || !text.startsWith('!')) return false;
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const handler = COMMANDS[cmd];
  if (!handler) return false;
  try {
    await handler(sock, msg, parts.slice(1));
  } catch (err) {
    console.error(`[cmd ${cmd}] error:`, err);
    try {
      await sock.sendMessage(msg.key.remoteJid, { text: `command failed: ${err?.message || err}` }, { quoted: msg });
    } catch (_) {
      /* noop */
    }
  }
  return true;
}

// ---- HTTP health server --------------------------------------------------
function startHealthServer() {
  const port = config.healthPort;
  const server = http.createServer((req, res) => {
    const uptime = Math.floor((Date.now() - botState.startedAt) / 1000);
    if (req.url === '/health' || req.url === '/healthz') {
      res.writeHead(botState.connected ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: botState.connected ? 'ok' : 'connecting',
          connected: botState.connected,
          uptimeSeconds: uptime,
          lastMessageAt: botState.lastMessageAt,
        }),
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        name: 'whatsapp-ai-replier',
        status: botState.connected ? 'connected' : 'connecting',
        uptimeSeconds: uptime,
        lastError: botState.lastError,
        paired: botState.paired,
      }),
    );
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`[http] health server listening on 0.0.0.0:${port}`);
  });
  server.on('error', (err) => {
    console.error('[http] server error:', err.message);
  });
  return server;
}

// ---- main socket lifecycle ----------------------------------------------
async function start() {
  // HTTP server FIRST so Render sees a port open immediately. This is what
  // keeps UptimeRobot pings happy on the free tier.
  startHealthServer();

  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  botState.paired = Boolean(state.creds?.registered);

  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[wa] using Baileys v${version.join('.')} (latest=${isLatest})`);

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    browser: Browsers.macOS('Chrome'),
    generateHighQualityLinkPreview: false,
    // Aggressive keepalive so Render's NAT doesn't kill the WS
    keepAliveIntervalMs: 15_000,
    syncFullHistory: false,
    markOnlineOnConnect: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'connecting') {
      botState.connected = false;
      console.log('[wa] connecting...');
    }

    if (connection === 'open') {
      botState.connected = true;
      botState.paired = true;
      botState.lastError = null;
      botState.reconnectAttempts = 0;
      console.log('[wa] ✅ connected — bot is live.');
    }

    if (connection === 'close') {
      botState.connected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      botState.lastError = `close code=${statusCode}`;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (!shouldReconnect) {
        console.log('[wa] logged out — re-pair required. delete auth_info_baileys/ and re-deploy.');
        process.exit(0);
      }

      botState.reconnectAttempts++;
      // Exponential backoff with a cap — important on the free tier so
      // we don't hammer the WA servers when Render keeps waking us up.
      const minMs = config.reconnectMinMs;
      const maxMs = config.reconnectMaxMs;
      const delay = Math.min(maxMs, minMs * Math.pow(1.4, Math.min(8, botState.reconnectAttempts - 1)));
      console.log(
        `[wa] connection closed (code=${statusCode}). reconnecting in ${Math.round(delay)}ms ` +
          `(attempt ${botState.reconnectAttempts})`,
      );
      await sleep(delay);
      start();
    }
  });

  // Pairing code (only when not yet registered)
  if (!sock.authState.creds.registered) {
    try {
      await sleep(2500);
      const code = await sock.requestPairingCode(config.phoneNumber);
      const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
      botState.pairingCode = formatted;
      console.log('\n========================================');
      console.log('  WHATSAPP PAIRING CODE');
      console.log('  ' + formatted);
      console.log('  WhatsApp > Linked Devices > Link a Device > Link with phone number');
      console.log('========================================\n');
    } catch (err) {
      console.error('[wa] failed to request pairing code:', err);
      botState.lastError = 'pairing-code request failed: ' + (err?.message || err);
    }
  }

  // Message handler
  sock.ev.on('messages.upsert', async (upsert) => {
    if (upsert.type !== 'notify') return;
    for (const msg of upsert.messages) {
      try {
        await handleIncoming(sock, msg);
      } catch (err) {
        console.error('[wa] message handler error:', err);
      }
    }
  });
}

// ---- per-message processing ---------------------------------------------
async function handleIncoming(sock, msg) {
  if (!msg.message || msg.key.fromMe) return;
  const chatJid = msg.key.remoteJid;
  botState.lastMessageAt = Date.now();

  // Buffer this message in the grabber's ring so !grab has something to pull
  recordIncoming(msg);

  // 1) autoreact — runs on every incoming message (config gated)
  maybeAutoReact(sock, msg);

  // 2) command handling — only owners can trigger these
  if (await maybeHandleCommand(sock, msg)) return;

  // 3) view-once auto-capture: if this message contains view-once media
  //    and the sender is the owner, grab it for safekeeping.
  if (isOwnerMessage(msg)) {
    const unwrapped = unwrapMessage(msg.message);
    if (unwrapped.isViewOnce) {
      try {
        // Reuse grabViewOnce on the most-recent matching media
        // (a single message rarely has many view-once entries)
        const result = await grabViewOnce(sock, chatJid);
        if (result.found) {
          const caption = `👀 view-once captured: ${result.kind}`;
          if (result.kind === 'image') {
            await sock.sendMessage(chatJid, { image: fs.readFileSync(result.mediaPath), caption }, { quoted: msg });
          } else if (result.kind === 'video') {
            await sock.sendMessage(chatJid, { video: fs.readFileSync(result.mediaPath), caption }, { quoted: msg });
          } else {
            await sock.sendMessage(chatJid, { document: fs.readFileSync(result.mediaPath), fileName: `viewonce.${result.kind}` }, { quoted: msg });
          }
        }
      } catch (err) {
        console.warn('[viewonce-auto] failed:', err?.message || err);
      }
    }
  }

  // 4) AI reply path
  const text = extractText(msg);
  if (!text || !text.trim()) return;

  const decision = shouldAIReply(msg, chatJid);
  if (!decision.ok) {
    console.log(`[skip] ${chatJid} -> ${decision.reason}`);
    return;
  }
  if (withinCooldown(chatJid)) {
    console.log(`[skip] ${chatJid} -> cooldown (${config.cooldownMs / 1000}s)`);
    return;
  }

  let chatName = '';
  try {
    if (isJidGroup(chatJid)) {
      const meta = await sock.groupMetadata(chatJid);
      chatName = meta?.subject || '';
    }
  } catch (_) {
    /* non-fatal */
  }

  pushHistory(chatJid, 'user', text, decision.senderJid);
  console.log(`[in ] ${chatName || chatJid}: ${text.slice(0, 80)}`);

  const flavor = pickPresenceFlavor(chatJid);
  await setPresence(sock, chatJid, flavor);

  let reply;
  try {
    reply = await generateReply(getHistory(chatJid), text, {
      chatName,
      isGroup: isJidGroup(chatJid),
      senderName: msg.pushName || '',
    });
  } catch (err) {
    console.error('[gemini] error:', err?.message || err);
    await pausePresence(sock, chatJid);
    return;
  }
  await pausePresence(sock, chatJid);

  if (!reply) return;
  if (reply.length > config.maxReplyChars) {
    reply = reply.slice(0, config.maxReplyChars - 3) + '...';
  }

  await humanDelay();
  for (const piece of chunk(reply)) {
    await sock.sendMessage(chatJid, { text: piece }, { quoted: msg });
    await sleep(300);
  }

  pushHistory(chatJid, 'model', reply);
  markReplied(chatJid);
  console.log(`[out] ${chatName || chatJid}: ${reply.slice(0, 80)}`);
}

// ---- boot ----------------------------------------------------------------
start().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
