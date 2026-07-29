# WhatsApp AI Replier

Personal WhatsApp auto-replier powered by **Baileys** (most powerful unofficial WhatsApp Web library) and **Google Gemini**. Pairs with your phone number via a one-time code — no QR scan. Designed to run 24/7 on **Render** as a background worker.

## Features

- 🔐 **Pairing-code auth** — link a device with a numeric code instead of a QR scan
- 🤖 **Gemini-powered replies** — uses `gemini-1.5-flash` by default (cheap + fast)
- 💬 **Conversation memory** — last N messages per chat are sent to Gemini as context
- 🎯 **Smart scoping** — `dm` / `groups` / `all`, plus group `@mention` requirement
- ⏱️ **Cooldowns** — configurable per-chat cooldown to avoid spam flags
- 📝 **Typing indicator** + human-like delay before replying
- 🧱 **Long-message chunking** — splits replies over 4000 chars automatically
- 🪪 **Allowlist + owner pinning** — test safely before opening it up

## Repo layout

```
whatsapp-ai-replier/
├── src/
│   ├── index.js      # bot entry point: pairing, socket, message handling
│   ├── config.js     # env loading + defaults
│   └── gemini.js     # Gemini client + prompt builder
├── package.json
├── render.yaml       # one-click Render Blueprint
├── .env.example      # copy to .env for local dev
└── README.md
```

## 1. Local quick start

```bash
git clone <this repo>
cd whatsapp-ai-replier
npm install
cp .env.example .env
# edit .env and fill in GEMINI_API_KEY + PHONE_NUMBER
npm start
```

On first run you'll see a pairing code printed in the terminal. Open WhatsApp on your phone → **Settings → Linked Devices → Link a Device → Link with phone number instead** → enter the 8-character code.

Once paired, the `auth_info_baileys/` folder holds your session. Re-running the bot won't re-prompt you.

## 2. Deploy to Render (24/7 hosting)

### Option A — Blueprint (recommended)

1. Push this folder to a **GitHub repo**.
2. In Render → **New → Blueprint** → point it at the repo.
3. Render reads `render.yaml` and creates the worker.
4. After it deploys, open the service → **Environment** and set:
   - `GEMINI_API_KEY` — from [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
   - `PHONE_NUMBER` — your number, digits only, e.g. `15551234567`
5. **Manual Deploy → Deploy latest commit** to restart.
6. Open **Logs** — you'll see the pairing code. Use it in WhatsApp (Linked Devices → Link with phone number).
7. Done — the worker stays up 24/7.

### Option B — Manual setup

1. Render → **New → Background Worker**.
2. Connect your GitHub repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add the env vars from `render.yaml` + your `GEMINI_API_KEY` and `PHONE_NUMBER`.
6. Deploy, grab the pairing code from logs, link your device.

> **Note:** Render's free plan spins workers down after ~15 min of no activity. For a WhatsApp bot that needs to stay connected, use the **Starter plan ($7/mo)** or any paid plan. The free plan works for testing but expect reconnects.

## Configuration reference

All env vars are in [`.env.example`](.env.example). The important ones:

| Var | Default | What it does |
|---|---|---|
| `GEMINI_API_KEY` | — | Required. Google AI Studio key. |
| `PHONE_NUMBER` | — | Required. International format, digits only. |
| `GEMINI_MODEL` | `gemini-1.5-flash` | Any Gemini model name. |
| `SYSTEM_PROMPT` | friendly assistant | Personality injected into every reply. |
| `REPLY_SCOPE` | `dm` | `dm`, `groups`, or `all`. |
| `GROUP_MENTION_ONLY` | `true` | In groups, only reply when @mentioned. |
| `REPLY_COOLDOWN_SECONDS` | `60` | Per-chat cooldown to look human. |
| `MAX_REPLY_CHARS` | `800` | Hard cap on reply length. |
| `CONTEXT_WINDOW` | `6` | Recent messages fed to Gemini per chat. |
| `OWNER_JIDS` | empty | Comma-separated JIDs that always get a reply. |
| `ALLOWED_JIDS` | empty | Whitelist. Empty = respond to everyone in scope. |

## ⚠️ Risks & fair warning

This uses the **unofficial** WhatsApp Web protocol. Meta doesn't love it. Keep these in mind:

- Use a **secondary number** if you can — never your primary business line.
- Cooldowns and the DM-only default are there for a reason. Don't disable them.
- Never spam. If a chat is replying to itself in a loop, deploy with `ALLOWED_JIDS` set to just yourself to debug.
- If your number gets banned, it's on you. This is a personal-project risk, not an API guarantee.

## Troubleshooting

**Pairing code never appears** — check `PHONE_NUMBER` is digits only with country code (no `+`).

**"Conflict: device previously logged out"** — delete the `auth_info_baileys/` folder locally **and** on the Render instance (Manual Deploy → Clear cache & deploy), then re-pair.

**Replies are slow on Render free tier** — the free plan throttles CPU. Upgrade to a paid plan or move to a VPS.

**"429 Too Many Requests" from Gemini** — you've blown past the free-tier RPM. Either slow down with a longer `REPLY_COOLDOWN_SECONDS` or switch to a paid Gemini key.

**Bot disconnects every ~15 min** — that's the free-plan spin-down. Upgrade to the Starter plan or a VPS.

## License

MIT — do whatever, just don't blame me if Meta bans your number 😄
