# WhatsApp AI Replier

Personal WhatsApp auto-replier powered by **Baileys** (most powerful unofficial WhatsApp Web library) and **Google Gemini**. Pairs with your phone number via a one-time code — no QR scan. Designed to run 24/7 on **Render**.

## Features

- 🔐 **Pairing-code auth** — link a device with a numeric code instead of a QR scan
- 🤖 **Gemini-powered replies** — uses `gemini-1.5-flash` by default (cheap + fast)
- 💬 **Conversation memory** — last N messages per chat are sent to Gemini as context
- 🎯 **Smart scoping** — `dm` / `groups` / `all`, plus group `@mention` requirement
- ⏱️ **Cooldowns** — configurable per-chat cooldown to avoid spam flags
- 📝 **Typing indicator** + human-like delay before replying
- 🧱 **Long-message chunking** — splits replies over 4000 chars automatically
- 🪪 **Allowlist + owner pinning** — test safely before opening it up
- 💓 **HTTP /health endpoint** — Render-friendly so the deploy stays "healthy"

## Repo layout

```
whatsapp-ai-replier/
├── src/
│   ├── index.js      # bot entry: pairing, socket, message loop, /health server
│   ├── config.js     # env loading + defaults
│   └── gemini.js     # Gemini client + prompt builder
├── package.json
├── render.yaml       # one-click Render Blueprint (creates a Web Service)
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

### ⚠️ Use the Blueprint — DON'T click "New Web Service" manually

This is the most common reason "no open ports detected" shows up: if you create the service manually and pick the wrong options, Render doesn't know to expect a WebSocket connection. The Blueprint (`render.yaml`) is wired to do the right thing automatically.

**Steps:**

1. **Push this folder to a GitHub repo** (private is fine).
2. In Render → **New → Blueprint** → point it at the repo.
3. Render reads `render.yaml` and creates a **Web Service** with:
   - `healthCheckPath: /health` (so it monitors the bot)
   - `HEALTH_PORT=10000` (the port the bot listens on)
4. **Set the secrets** in the service → **Environment**:
   - `GEMINI_API_KEY` — from [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
   - `PHONE_NUMBER` — your number, digits only, e.g. `15551234567`
5. **Manual Deploy → Deploy latest commit** to restart with the env vars.
6. Open **Logs** — you'll see something like:
   ```
   [http] health server listening on 0.0.0.0:10000
   [wa] using Baileys v2.3000.xxxxx (latest=true)
   [wa] connecting...
   ========================================
     WHATSAPP PAIRING CODE
     XXXX-XXXX
     Open WhatsApp > Linked Devices > Link with phone number
   ========================================
   ```
7. On your phone: **WhatsApp → Linked Devices → Link a Device → "Link with phone number instead"** → enter the code.
8. Wait ~5 seconds. Logs will show `[wa] ✅ connected — bot is live.` and the service goes green.

> **Plan choice:** The Blueprint defaults to `starter` ($7/mo) because the free plan spins down after 15 min and the bot will disconnect. If you want to test on the free plan first, change `plan: starter` → `plan: free` in `render.yaml`, but expect disconnects every 15 min.

### Manual setup (only if Blueprint isn't an option)

If you must create the service by hand:

1. Render → **New → Web Service** (NOT background worker — this bot uses a Web Service + a health port so Render considers it alive).
2. Connect your GitHub repo.
3. **Environment**: `Node`
4. **Build Command**: `npm install`
5. **Start Command**: `npm start`
6. **Health Check Path**: `/health`
7. **Instance Type**: at least `Starter` for 24/7.
8. Add the env vars from `render.yaml` + your `GEMINI_API_KEY` and `PHONE_NUMBER`.
9. Add `HEALTH_PORT=10000`.
10. Deploy, grab the pairing code from logs, link your device.

## Configuration reference

All env vars are in [`.env.example`](.env.example). The important ones:

| Var | Default | What it does |
|---|---|---|
| `GEMINI_API_KEY` | — | Required. Google AI Studio key. |
| `PHONE_NUMBER` | — | Required. International format, digits only. |
| `HEALTH_PORT` | `10000` | HTTP port for `/health` (Render expects 10000). |
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

**Logs say "No open ports detected"** — You're running it as a Background Worker. Use a **Web Service** instead (this repo's `render.yaml` does that for you automatically). Render only checks for an open port on Web Services.

**Pairs but bot shows "not active" / disconnected in WhatsApp** — This is the same issue: Render killed the service because no port was open, so Baileys never got a chance to keep the WebSocket alive. After deploying the fixed `render.yaml`, the bot will stay connected.

**Pairing code never appears** — check `PHONE_NUMBER` is digits only with country code (no `+`).

**"Conflict: device previously logged out"** — delete the `auth_info_baileys/` folder locally **and** on the Render instance (Manual Deploy → Clear cache & deploy), then re-pair.

**Replies are slow on Render free tier** — the free plan throttles CPU. Upgrade to a paid plan or move to a VPS.

**"429 Too Many Requests" from Gemini** — you've blown past the free-tier RPM. Either slow down with a longer `REPLY_COOLDOWN_SECONDS` or switch to a paid Gemini key.

**Bot disconnects every ~15 min** — that's the free-plan spin-down. Upgrade to the Starter plan or a VPS.

**Want to verify it's alive without WhatsApp?** — `curl https://<your-service>.onrender.com/health` returns `200 {"status":"ok",...}` when connected, `503` while connecting.

## License

MIT — do whatever, just don't blame me if Meta bans your number 😄
