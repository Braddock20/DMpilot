'use strict';

// Centralized config — reads from process.env (set on Render via the dashboard
// or via the .env file locally). Anything missing falls back to the defaults in
// .env.example so the bot still boots in a predictable way.

const fs = require('fs');
const path = require('path');

// Lightweight .env loader so we don't need an extra dependency.
function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

function bool(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function list(v) {
  if (!v) return [];
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const required = ['GEMINI_API_KEY', 'PHONE_NUMBER'];
for (const k of required) {
  if (!process.env[k]) {
    // We don't hard-crash here so that `node -e "require('./config')"` works
    // in tooling. The bot will throw on startup instead.
    // eslint-disable-next-line no-console
    console.warn(`[config] WARNING: missing required env var: ${k}`);
  }
}

const config = {
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
  },
  phoneNumber: (process.env.PHONE_NUMBER || '').replace(/\D/g, ''),
  systemPrompt:
    process.env.SYSTEM_PROMPT ||
    'You are a helpful, friendly WhatsApp assistant. Keep replies short, conversational, and natural. Use the same language the user writes in.',
  replyScope: (process.env.REPLY_SCOPE || 'dm').toLowerCase(), // dm | all | groups
  groupMentionOnly: bool(process.env.GROUP_MENTION_ONLY, true),
  cooldownMs: Math.max(0, Number(process.env.REPLY_COOLDOWN_SECONDS || 60) * 1000),
  maxReplyChars: Math.max(50, Number(process.env.MAX_REPLY_CHARS || 800)),
  contextWindow: Math.max(0, Number(process.env.CONTEXT_WINDOW || 6)),
  ownerJids: list(process.env.OWNER_JIDS),
  allowedJids: list(process.env.ALLOWED_JIDS),
};

module.exports = config;
