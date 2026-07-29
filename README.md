# WhatsApp AI Replier

Personal WhatsApp auto-replier powered by **Baileys** (most powerful unofficial WhatsApp Web library) and **Google Gemini**. Pairs with your phone number via a one-time code — no QR scan. Free-tier friendly on Render with UptimeRobot keeping it warm.

## Features

- 🔐 **Pairing-code auth** — link a device with a numeric code instead of a QR scan
- 🤖 **Gemini-powered replies** — `gemini-1.5-flash` by default (cheap + fast)
- 💬 **Conversation memory** — last N messages per chat sent to Gemini as context
- ⌨️ **Autotyping + autorecording** — show "typing…" or "recording…" while Gemini thinks
- 😍 **Autoreact** — react with random emoji to incoming messages
- 🛡️ **View-once capture** — automatically save view-once photos/videos (anti view-once)
- 📦 **Chat grabber** — `!grab 100` zips the last 100 messages + all media and sends it back
- 🎯 **Smart scoping** — `dm` / `groups` / `all`, plus group `@mention` requirement
- ⏱️ **Cooldowns** — per-chat cooldown to look human
- 📝 **Typing indicator** + human-like delay before replying
- 🧱 **Long-message chunking** — splits replies over 4000 chars automatically
- 🪪 **Allowlist + owner pinning** — owner-only commands
- 💓 **HTTP /health endpoint** — Render-friendly so the deploy stays "healthy"
- 🔁 **Free-tier resilient reconnect** — exponential backoff so the bot bounces back fast

## Repo layout

```
whatsapp-ai-replier/
├── src/
│   ├── index.js      # bot entry: pairing, socket, message loop, /health server, commands
│   ├── config.js     # env loading + defaults
│   ├── gemini.js     # Gemini client + prompt builder
│   └── grabber.js    # chat history + media download + zip builder
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
# edit .env and fill in GEMINI_API_KEY + PHONE_NUMBER + OWNER_JIDS
npm start
```

On first run you'll see a pairing code printed in the terminal. Open WhatsApp on your phone → **Settings → Linked Devices → Link a Device → Link with phone number instead** → enter the 8-character code.

Once paired, the `auth_info_baileys/` folder holds your session. Re-running the bot won't re-prompt you.

## 2. Deploy to Render (free tier with UptimeRobot)

### Step 1: Push to GitHub
Push this folder to a GitHub repo (private is fine).

### Step 2: Create the service
In Render → **New → Blueprint** → point it at the repo. Render reads `render.yaml` and creates a **Web Service** with health checks on `/health`.

**Why Web Service and not Worker?** Because Render's Web Service health checks keep the instance warm. UptimeRobot will hit `/health` every 5 minutes and prevent the 15-minute spin-down.

### Step 3: Set env vars
In the service → **Environment**, set:
- `GEMINI_API_KEY` — from [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
- `PHONE_NUMBER` — your number, digits only, e.g. `15551234567`
- `OWNER_JIDS` — your JID like `15551234567@s.whatsapp.net` (only this JID can run commands and the bot will always reply to you, ignoring cooldowns)
- Optionally flip `AUTO_TYPING`, `AUTO_RECORDING`, `AUTO_REACT`, etc.

> **Get your owner JID:** Send a message to the bot, then look at the logs. The sender JID is printed in `[in ]` log lines.

### Step 4: Deploy
**Manual Deploy → Deploy latest commit**. Open **Logs** and watch for:
```
[http] health server listening on 0.0.0.0:10000
[wa] using Baileys v2.3000.xxxxx (latest=true)
[wa] connecting...
========================================
  WHATSAPP PAIRING CODE
  XXXX-XXXX
  WhatsApp > Linked Devices > Link a Device > Link with phone number
========================================
[wa] ✅ connected — bot is live.
```

### Step 5: Pair on your phone
WhatsApp → **Linked Devices** → **Link a Device** → **"Link with phone number instead"** → enter the code. The service will turn green in ~5 seconds.

### Step 6: Keep it warm with UptimeRobot (free tier fix)

1. Sign up free at [uptimerobot.com](https://uptimerobot.com)
2. **Add New Monitor** → **HTTP(s)**
3. Friendly name: `WhatsApp Bot`
4. URL: `https://<your-service-name>.onrender.com/health`
5. Monitoring interval: **5 minutes**
6. Click **Create Monitor**

UptimeRobot will now ping `/health` every 5 minutes. Render's free tier only spins down after 15 minutes of zero traffic, so this keeps the bot live 24/7 without paying.

> **Note:** Render's free plan still adds ~30s of cold-start time when the service is woken up after a long idle. UptimeRobot is the standard fix for this. If you want zero cold starts, upgrade to the Starter plan ($7/mo).

## Commands (owner only)

These only work from the JID you set in `OWNER_JIDS`:

| Command | What it does |
|---|---|
| `!ping` | Replies `pong` — sanity check the bot is alive |
| `!status` | Shows uptime, reconnects, model, scope, cooldown |
| `!grab 100` | Pulls the last 100 messages + downloads all media → zips and sends back as a document |
| `!grabviewonce` | Hunts the current chat for the most recent view-once media, extracts it, sends it back AND a zip |
| `!help` | Lists all commands |

`!grab` and `!grabviewonce` are hard-capped at `GRAB_MAX_MESSAGES` (default 100) to keep Render's RAM in check.

### View-once auto-capture

When a view-once photo or video arrives in **any chat you're in**, and the sender is you (the owner), the bot will:
1. Download the media
2. Send it back to you
3. So you can see it again even after the sender's "view once" timer runs out

This is gated on `isOwnerMessage` so it only fires for your own JID, not for every view-once photo in every group.

## Configuration reference

All env vars are in [`.env.example`](.env.example). The important ones:

| Var | Default | What it does |
|---|---|---|
| `GEMINI_API_KEY` | — | Required. Google AI Studio key. |
| `PHONE_NUMBER` | — | Required. International format, digits only. |
| `OWNER_JIDS` | empty | Comma-separated JIDs that always get a reply AND can run commands. |
| `HEALTH_PORT` | `10000` | HTTP port for `/health`. |
| `GEMINI_MODEL` | `gemini-1.5-flash` | Any Gemini model name. |
| `SYSTEM_PROMPT` | friendly assistant | Personality injected into every reply. |
| `REPLY_SCOPE` | `dm` | `dm`, `groups`, or `all`. |
| `GROUP_MENTION_ONLY` | `true` | In groups, only reply when @mentioned. |
| `REPLY_COOLDOWN_SECONDS` | `60` | Per-chat cooldown to look human. |
| `MAX_REPLY_CHARS` | `800` | Hard cap on reply length. |
| `CONTEXT_WINDOW` | `6` | Recent messages fed to Gemini per chat. |
| `ALLOWED_JIDS` | empty | Whitelist. Empty = respond to everyone in scope. |
| `AUTO_TYPING` | `true` | Show "typing…" presence. |
| `AUTO_RECORDING` | `false` | Show "recording audio…" presence. |
| `PRESENCE_MODE` | `typing` | `typing`, `recording`, or `both` (random per chat). |
| `AUTO_REACT` | `false` | React with emoji to incoming messages. |
| `AUTO_REACT_EMOJIS` | mixed list | Comma-separated emoji to randomly pick from. |
| `AUTO_REACT_ON_TEXT` | `true` | React to text messages. |
| `AUTO_REACT_ON_MEDIA` | `true` | React to media messages. |
| `GRAB_ENABLED` | `true` | Master switch for `!grab` / `!grabviewonce`. |
| `GRAB_MAX_MESSAGES` | `100` | Hard cap on how many messages `!grab` can pull. |
| `GRAB_TEMP_DIR` | `/tmp/wa-grabs` | Where temporary zips are built. |
| `RECONNECT_MIN_MS` | `1000` | Reconnect backoff — start. |
| `RECONNECT_MAX_MS` | `10000` | Reconnect backoff — cap. |

## ⚠️ Risks & fair warning

This uses the **unofficial** WhatsApp Web protocol. Meta doesn't love it. Keep these in mind:

- Use a **secondary number** if you can — never your primary business line.
- Cooldowns and the DM-only default are there for a reason. Don't disable them.
- View-once auto-capture is only triggered for the **owner's own messages** — not for every view-once in every group. Be respectful of others' privacy.
- `!grab` and `!grabviewonce` are **owner-only** by design. Don't share your number.
- If your number gets banned, it's on you. This is a personal-project risk, not an API guarantee.

## Troubleshooting

**Logs say "No open ports detected"** — You created the service manually as a Background Worker. Use a **Web Service** instead (this repo's `render.yaml` does that for you automatically). Render only checks for an open port on Web Services.

**Pairs but bot shows "not active" / disconnected in WhatsApp** — Render killed the service because no port was open. Deploy the fixed `render.yaml` and ensure the service is a Web Service.

**Bot disconnects every ~15 min on free tier** — Set up UptimeRobot hitting `/health` every 5 min. That keeps Render's free instance warm.

**Pairing code never appears** — check `PHONE_NUMBER` is digits only with country code (no `+`).

**"Conflict: device previously logged out"** — delete the `auth_info_baileys/` folder locally **and** on the Render instance (Manual Deploy → Clear cache & deploy), then re-pair.

**Replies are slow on Render free tier** — the free plan throttles CPU. Upgrade to a paid plan or move to a VPS.

**"429 Too Many Requests" from Gemini** — you've blown past the free-tier RPM. Either slow down with a longer `REPLY_COOLDOWN_SECONDS` or switch to a paid Gemini key.

**`!grab` returns no messages** — the bot only buffers messages received **after** the bot started. If you want a full history, run the bot for a while first, then trigger the command. Newer Baileys versions also support `fetchMessageHistory` which the grabber falls back to.

**View-once capture didn't fire** — only the owner's incoming view-once media triggers auto-capture. The `!grabviewonce` command works on any chat's recent history.

**Want to verify it's alive without WhatsApp?** — `curl https://<your-service>.onrender.com/health` returns `200 {"status":"ok",...}` when connected, `503` while connecting.

## License

MIT — do whatever, just don't blame me if Meta bans your number 😄
