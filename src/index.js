'use strict';

/**
 * WhatsApp AI Replier
 * --------------------------------------------------------------
 * - Library  : @whiskeysockets/baileys  (most powerful, pairing-code support)
 * - AI       : Google Gemini            (gemini-1.5-flash by default)
 * - Hosting  : Render                   (background worker, 24/7)
 *
 * Flow:
 *   1. Pair using PHONE_NUMBER (no QR scan needed)
 *   2. Listen for incoming messages
 *   3. Filter by REPLY_SCOPE (DM / groups / both) + cooldowns
 *   4. Hand the conversation to Gemini and send the reply
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
} = require('@whiskeysockets/baileys');

const http = require('http');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

const config = require('./config');
const { generateReply } = require('./gemini');

// ---- shared state used by the /health endpoint ---------------------------
const botState = {
  startedAt: Date.now(),
  connected: false,
  lastError: null,
  lastMessageAt: null,
  pairingCode: null,
};

// -------- sanity checks ---------------------------------------------------

if (!config.phoneNumber) {
  throw new Error('PHONE_NUMBER is not set. Add it to your .env or Render env vars.');
}
if (!config.gemini.apiKey) {
  throw new Error('GEMINI_API_KEY is not set. Add it to your .env or Render env vars.');
}

// -------- in-memory state -------------------------------------------------

/** Map<jid, number(ms)> — last reply timestamp per chat (cooldowns) */
const lastReplyAt = new Map();
/** Map<jid, Array<{role, text, sender, ts}>> — rolling per-chat history */
const chatHistory = new Map();

function pushHistory(jid, role, text, sender) {
  const list = chatHistory.get(jid) || [];
  list.push({ role, text, sender, ts: Date.now() });
  // Keep memory bounded
  while (list.length > Math.max(2, config.contextWindow) * 2) list.shift();
  chatHistory.set(jid, list);
}

function getHistory(jid) {
  const list = chatHistory.get(jid) || [];
  // Return only the last N exchanges
  return list.slice(-config.contextWindow);
}

// -------- helpers ---------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Human delay before replying — 700ms..2.2s */
async function humanDelay() {
  const ms = 700 + Math.floor(Math.random() * 1500);
  await sleep(ms);
}

/** Split a long string into WhatsApp-friendly chunks (under ~4000 chars). */
function chunk(text, size = 4000) {
  if (text.length <= size) return [text];
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** Should we reply in this chat? */
function shouldReply(msg, chatJid) {
  // Never reply to status updates or broadcasts
  if (isJidBroadcast(chatJid)) return { ok: false, reason: 'broadcast' };

  const isGroup = isJidGroup(chatJid);
  const senderJid = msg.key.participant || msg.key.remoteJid;
  const isFromMe = msg.key.fromMe;

  // Owner always gets replies (and inside groups from owner too)
  if (config.ownerJids.includes(senderJid)) return { ok: true, isGroup, senderJid };

  // Optional allowlist (useful while testing)
  if (config.allowedJids.length && !config.allowedJids.includes(chatJid)) {
    return { ok: false, reason: 'not in ALLOWED_JIDS' };
  }

  if (config.replyScope === 'dm' && isGroup) {
    return { ok: false, reason: 'scope=dm, group ignored' };
  }
  if (config.replyScope === 'groups' && !isGroup) {
    return { ok: false, reason: 'scope=groups, dm ignored' };
  }

  // In groups, only reply when the bot is mentioned (unless disabled)
  if (isGroup && config.groupMentionOnly) {
    const mentioned =
      Array.isArray(msg.message?.extendedTextMessage?.contextInfo?.mentionedJid) &&
      msg.message.extendedTextMessage.contextInfo.mentionedJid.length > 0;
    if (!mentioned) return { ok: false, reason: 'group, not mentioned' };
  }

  return { ok: true, isGroup, senderJid };
}

function withinCooldown(jid) {
  const last = lastReplyAt.get(jid) || 0;
  return Date.now() - last < config.cooldownMs;
}

function markReplied(jid) {
  lastReplyAt.set(jid, Date.now());
}

/** Extract plain text out of a Baileys message object. */
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

// -------- main ------------------------------------------------------------

/**
 * Tiny HTTP server so Render (which expects an open port for web services)
 * considers the deploy healthy. Exposes:
 *   GET /health   -> 200 if the bot is connected, 503 otherwise
 *   GET /         -> short status JSON
 *
 * On a Background Worker this is optional but harmless. On a Web Service
 * (which is what render.yaml now creates) it is required.
 */
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
      }),
    );
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`[http] health server listening on 0.0.0.0:${port}`);
  });
  // Don't let an HTTP error take the bot down
  server.on('error', (err) => {
    console.error('[http] server error:', err.message);
  });
  return server;
}

async function start() {
  // Start the HTTP health server FIRST so Render sees an open port from the
  // very first second. Without this, Render's health checks will fail and
  // the service can be killed before Baileys finishes connecting.
  startHealthServer();

  // auth_info_baileys holds the signed-in credentials between restarts.
  // On Render, this is ephemeral storage — Render will keep the worker
  // running so the auth stays, but the FIRST deploy still needs pairing.
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[wa] using Baileys v${version.join('.')} (latest=${isLatest})`);

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false, // we use pairing codes instead
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    browser: Browsers.macOS('Chrome'),
    generateHighQualityLinkPreview: false,
  });

  // ---- credential persistence
  sock.ev.on('creds.update', saveCreds);

  // ---- connection lifecycle
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'connecting') {
      console.log('[wa] connecting...');
      botState.connected = false;
    }

    if (connection === 'open') {
      botState.connected = true;
      botState.lastError = null;
      console.log('[wa] ✅ connected — bot is live.');
    }

    if (connection === 'close') {
      botState.connected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      botState.lastError = `close code=${statusCode}`;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(
        `[wa] connection closed (code=${statusCode}). ${
          shouldReconnect ? 'reconnecting in 5s...' : 'logged out — re-pair required.'
        }`,
      );
      if (shouldReconnect) {
        await sleep(5000);
        start();
      } else {
        console.log('[wa] delete the auth_info_baileys/ folder and re-deploy to pair again.');
        process.exit(0);
      }
    }
  });

  // ---- pairing code (printed once, only when we don't have creds yet)
  if (!sock.authState.creds.registered) {
    try {
      // Wait briefly so the socket is ready, then request the code
      await sleep(2500);
      const code = await sock.requestPairingCode(config.phoneNumber);
      const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
      botState.pairingCode = formatted;
      console.log('\n========================================');
      console.log('  WHATSAPP PAIRING CODE');
      console.log('  ' + formatted);
      console.log('  Open WhatsApp > Linked Devices > Link with phone number');
      console.log('========================================\n');
    } catch (err) {
      console.error('[wa] failed to request pairing code:', err);
      botState.lastError = 'pairing-code request failed: ' + (err?.message || err);
    }
  }

  // ---- message handler
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

async function handleIncoming(sock, msg) {
  // Skip outgoing / non-message events
  if (!msg.message || msg.key.fromMe) return;

  const chatJid = msg.key.remoteJid;
  const text = extractText(msg);
  if (!text || !text.trim()) return;

  const decision = shouldReply(msg, chatJid);
  if (!decision.ok) {
    // Verbose log so you can see what got filtered and why
    console.log(`[skip] ${chatJid} -> ${decision.reason}`);
    return;
  }

  if (withinCooldown(chatJid)) {
    console.log(`[skip] ${chatJid} -> cooldown (${config.cooldownMs / 1000}s)`);
    return;
  }

  // Look up the chat name (group subject / contact push name)
  let chatName = '';
  try {
    if (isJidGroup(chatJid)) {
      const meta = await sock.groupMetadata(chatJid);
      chatName = meta?.subject || '';
    }
  } catch (_) {
    /* non-fatal */
  }

  // Remember this incoming message in the rolling history
  pushHistory(chatJid, 'user', text, decision.senderJid);
  botState.lastMessageAt = Date.now();

  console.log(`[in ] ${chatName || chatJid}: ${text.slice(0, 80)}`);

  // Typing indicator — looks more natural
  try {
    await sock.sendPresenceUpdate('composing', chatJid);
  } catch (_) {
    /* non-fatal */
  }

  let reply;
  try {
    reply = await generateReply(getHistory(chatJid), text, {
      chatName,
      isGroup: isJidGroup(chatJid),
      senderName: msg.pushName || '',
    });
  } catch (err) {
    console.error('[gemini] error:', err?.message || err);
    return;
  } finally {
    try {
      await sock.sendPresenceUpdate('paused', chatJid);
    } catch (_) {
      /* non-fatal */
    }
  }

  if (!reply) return;

  // Clamp to maxReplyChars just in case
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

// -------- boot ------------------------------------------------------------

start().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
