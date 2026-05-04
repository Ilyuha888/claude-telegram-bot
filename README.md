# Claude Telegram Bot

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-1.3+-black.svg)](https://bun.sh/)

**Turn [Claude Code](https://claude.com/product/claude-code) into your personal assistant, accessible from anywhere via Telegram.**

Send text, voice, photos, documents, audio, and video. Get streaming responses and real-time tool status on your phone.

> **Claude Code only.** The bot runs on the Claude Code agent runtime — skills, hooks, MCP integrations, and the `canUseTool` permission bridge are all Claude Code-specific. Porting to Codex or Gemini would require replacing the entire agent runtime (not just swapping a model name). This is by design for v1.

---

## What it does

- 💬 **Text / Voice / Photos / Documents / Audio / Video** — every Telegram media type works
- 🔄 **Session persistence** — conversations continue across messages; `/resume` restores old sessions with a recap
- 📨 **Message queuing** — send multiple messages while Claude works; prefix with `!` to interrupt
- 🧠 **Extended thinking** — say "think" or "reason" to trigger Claude's reasoning mode
- 🔘 **Interactive buttons** — Claude presents choices as tappable inline keyboards via `ask_user` MCP
- 📎 **File delivery** — Claude sends files back via `send_file` MCP
- 📅 **Scheduled routines** — daily focus digest, weekly vault curation, monthly project audit, quarterly review (all configurable)
- 📝 **PKM skills** — `/scribe` captures notes to your vault, `/retriever` answers vault-grounded questions, `/curator` runs a vault health report
- 🔔 **Notifications** — delivered via inline keyboard with [Log outcome] flow for scribe reminders

---

## Three-repo layout

The full setup uses three repos cloned side by side:

```
~/repos/
├── claude-telegram-bot/   # This repo — bot code, Docker, skills, settings
├── ctb-vault/             # Knowledge base scaffold (PARA + V-A methodology)
└── bot-data/              # Runtime state (schedules, notifications)
```

Clone all three before starting:

```bash
git clone https://github.com/Ilyuha888/claude-telegram-bot ~/repos/claude-telegram-bot
git clone https://github.com/Ilyuha888/ctb-vault          ~/repos/ctb-vault
git clone https://github.com/Ilyuha888/bot-data            ~/repos/bot-data
```

**`ctb-vault`** ships with the PARA folder structure, the V-A methodology spec (`meta/va-contract.md`), and optional scheduler prompt templates. You populate it with your own notes.

**`bot-data`** ships with example schedules. The bot reads and writes it at runtime. `sessions.json` is gitignored and never committed — it contains conversation history.

---

## Quick start (Docker)

The recommended way to run the bot. No Bun or Node.js installation required on the host.

**1. Create your bot**

1. Open [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` → copy the token
3. Send `/setcommands` to BotFather:

```
start - Show status and user ID
new - Start a fresh session
resume - Pick from recent sessions to resume
stop - Interrupt current query
status - Check what Claude is doing
restart - Restart the bot
menu - Open control panel
```

**Finding your Telegram user ID:** message [@userinfobot](https://t.me/userinfobot).

**2. Configure**

```bash
cd ~/repos/claude-telegram-bot
cp .env.example .env
```

Edit `.env` — minimum required:

```bash
TELEGRAM_BOT_TOKEN=1234567890:ABC-DEF...
TELEGRAM_ALLOWED_USERS=123456789          # your Telegram user ID

# Paths (used by docker-compose as host-side mount sources)
BOT_DATA_DIR=../bot-data
CTB_VAULT_DIR=../ctb-vault
```

**3. Authenticate Claude**

The bot uses your Claude Code subscription (most cost-effective) or an API key:

```bash
# Option A — Claude Code CLI auth (recommended)
# Run once on the host; auth state is stored in ~/.claude/
claude

# Option B — API key (set in .env, billed per token)
ANTHROPIC_API_KEY=sk-ant-api03-...
```

**4. Start**

```bash
docker compose up -d
docker compose logs -f   # watch startup
```

The container mounts `~/bot-data`, `~/ctb-vault`, and `~/.claude` (read-only, for Claude auth + settings + skills).

---

## Alternative: native (Linux/macOS)

If you prefer running without Docker:

**Prerequisites:** Bun 1.3+, Claude Code CLI, `pdftotext` (`brew install poppler` / `apt install poppler-utils`).

```bash
cd ~/repos/claude-telegram-bot
bun install
cp .env.example .env   # edit with your credentials
bun run src/index.ts
```

**macOS service (auto-start on login):**

```bash
cp launchagent/com.claude-telegram-ts.plist.template \
   ~/Library/LaunchAgents/com.claude-telegram-ts.plist
# Edit the plist with your paths and env vars
launchctl load ~/Library/LaunchAgents/com.claude-telegram-ts.plist
```

**Linux systemd service:**

```bash
sudo systemctl restart claude-telegram-bot
```

---

## Configuration

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | From @BotFather |
| `TELEGRAM_ALLOWED_USERS` | ✅ | Comma-separated Telegram user IDs |
| `ANTHROPIC_API_KEY` | if no CLI auth | Claude API key |
| `OPENAI_API_KEY` | | Voice transcription (without it, voice messages won't work) |
| `CLAUDE_WORKING_DIR` | | Where Claude runs — loads CLAUDE.md, skills, MCP config |
| `CTB_VAULT_DIR` | | Path to your vault (scheduler prompts default to `~/repos/ctb-vault`) |
| `BOT_DATA_DIR` | | Path to bot-data dir (default: `~/bot-data`) |
| `ALLOWED_PATHS` | | Comma-separated dirs Claude can access (overrides defaults; include `~/.claude`) |
| `TZ` | | Timezone for scheduler (default: `Europe/Moscow`) |

### MCP servers (optional)

```bash
cp mcp-config.example.ts mcp-config.ts
# Edit mcp-config.ts with your MCP servers
```

Built-in MCP servers (always active):
- **`ask_user`** — presents options as Telegram inline keyboard buttons
- **`send_file`** — sends files back to the chat

### Google MCPs (optional)

Calendar, Gmail, and Google Drive access is available via the claude.ai MCP connector interface:

1. Open [claude.ai](https://claude.ai) → Settings → MCP
2. Connect Google Calendar / Gmail / Google Drive
3. Auth is session-scoped to your claude.ai session — nothing ships in this repo

---

## Scheduler and PKM skills

### Scheduled routines

The bot fires four built-in routines on the schedule defined in `bot-data/schedules.json`:

| Routine | Default schedule | What it does |
|---|---|---|
| Daily focus | 09:00 daily | Active projects + tasks digest |
| Weekly curator | Sunday 20:00 | Stale inbox, draft promotions, project momentum |
| Monthly audit | 1st of month 10:00 | Project health + area coverage |
| Quarterly review | Quarterly | Strategic synthesis |

Edit `schedules.json` to change times or disable routines. The bot picks up changes without restart.

### PKM slash commands

| Command | What it does |
|---|---|
| `/scribe` or `/scribe <text>` | Captures input to `$CTB_VAULT_DIR/inbox/` with correct frontmatter, duplicate check, commit-confirm |
| `/retriever <question>` | Vault-grounded answer with note citations |
| `/curator` | Vault health report: stale inbox, draft promotions, orphan candidates |

Natural-language intent routing is built in — you don't need to type the slash commands explicitly. Say "save this" → Scribe. "What do I know about X" → Retriever. "What needs attention" → Curator.

---

## Bot commands

| Command | Description |
|---|---|
| `/start` | Show status and your user ID |
| `/new` | Start a fresh session |
| `/resume` | Pick from last 5 sessions to resume (with recap) |
| `/stop` | Interrupt current query |
| `/status` | Check what Claude is doing |
| `/restart` | Restart the bot |
| `/menu` | Open Mode 2 control panel (remote session management) |

---

## Security

> **⚠️ Important:** This bot runs Claude Code with permission prompts handled via Telegram inline buttons. Claude can read, write, and execute commands within the allowed paths. Understand the implications before deploying.

**→ [Read the full Security Model](SECURITY.md)**

Protections:
1. **User allowlist** — only your Telegram IDs can use the bot
2. **Intent classification** — AI filter blocks dangerous requests
3. **Path validation** — file access restricted to `ALLOWED_PATHS`
4. **Command safety** — patterns like `rm -rf /` are blocked
5. **Rate limiting** — prevents runaway usage
6. **Audit logging** — all interactions logged to `/tmp/claude-telegram-audit.log`

---

## Development

```bash
bun run dev          # auto-reload on file changes
bun run typecheck    # TypeScript type check
bun test             # run tests
```

After code changes on Linux with systemd: `sudo systemctl restart claude-telegram-bot`.

---

## Troubleshooting

**Bot doesn't respond**
- Verify your user ID is in `TELEGRAM_ALLOWED_USERS`
- `docker compose logs -f` or `tail -f /tmp/claude-telegram-bot-ts.err`

**Claude authentication issues**
- CLI auth: run `claude` on the host and verify you're logged in
- API key: check it starts with `sk-ant-api03-` and has credits at [console.anthropic.com](https://console.anthropic.com/)

**Voice messages fail**
- `OPENAI_API_KEY` must be set and have credits

**Scheduler not firing**
- Check `bot-data/schedules.json` for correct cron syntax
- Verify `TZ` is set to a valid IANA timezone (e.g. `Europe/Moscow`, `America/New_York`)

**`pdftotext` not found (native mode)**
- macOS: `brew install poppler`
- Linux: `apt install poppler-utils`

---

## Attribution

Fork of [linuz90/claude-telegram-bot](https://github.com/linuz90/claude-telegram-bot) — see [NOTICE.md](NOTICE.md).

## License

MIT — see [LICENSE](LICENSE).
