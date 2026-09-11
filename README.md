# Claude Telegram Bot

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-1.3+-black.svg)](https://bun.sh/)

**A personal knowledge system on Telegram.** Capture thoughts via voice or text, get answers grounded in your own notes, and let scheduled routines keep your vault healthy. Built on [Claude Code](https://claude.com/product/claude-code), powered by an Obsidian-compatible knowledge vault, glued together with three custom PKM skills.

The Telegram bot is just the access surface. The actual product is the **capture → triage → promote → review** loop running on top of your own files in your own git repo.

> **Claude Code only.** The bot runs on the Claude Code agent runtime — skills, hooks, MCP integrations, and the `canUseTool` permission bridge are all Claude Code-specific. Porting to Codex or Gemini would require replacing the entire agent runtime. This is by design for v1.

---

## How it works — the knowledge flywheel

```
                  ┌──────────────────────────────────┐
                  │ 1. CAPTURE                       │
                  │ /scribe (text/voice) → inbox/    │◄─── you, on the go via Telegram
                  └────────────┬─────────────────────┘
                               ▼
                  ┌──────────────────────────────────┐
                  │ 2. TRIAGE                        │
                  │ Weekly /curator scans inbox/     │
                  │ flags drafts ready for promotion │◄─── scheduler routine
                  └────────────┬─────────────────────┘
                               ▼
                  ┌──────────────────────────────────┐
                  │ 3. PROMOTE                       │
                  │ You decide what's evergreen      │◄─── human-in-the-loop
                  │ raw → draft → evergreen          │
                  └────────────┬─────────────────────┘
                               ▼
                  ┌──────────────────────────────────┐
                  │ 4. REVIEW                        │
                  │ Daily focus digest               │
                  │ Monthly project audit            │◄─── scheduler routines
                  │ Quarterly strategic review       │
                  └────────────┬─────────────────────┘
                               │
                  ┌────────────▼─────────────────────┐
                  │ 5. RETRIEVE                      │
                  │ /retriever — vault-grounded      │◄─── you, asking questions
                  │   answers with citations         │
                  └──────────────────────────────────┘
```

The vault is your knowledge graph; the bot is the loop's interface; the scheduler is the maintenance cron. Each piece is replaceable — the methodology (V-A note types, PARA folders, lifecycle states) is documented in the vault itself at `meta/va-contract.md`, so you own how it works.

---

## The three layers

### 1. The vault — `ctb-vault`

An [Obsidian](https://obsidian.md)-compatible scaffold with [PARA folders](https://fortelabs.com/blog/para/) and the **V-A methodology** baked in:
- 6 note types (evergreen, inbox, project, area, person, reference)
- Lifecycle states (raw → draft → evergreen | archived)
- Frontmatter contract enforced by the PKM skills

Read [ctb-vault/README.md](https://github.com/Ilyuha888/ctb-vault) for the methodology spec.

### 2. The PKM skills — invokable from Telegram

| Skill | What it does |
|---|---|
| `/scribe <text>` | Capture to `inbox/` with correct frontmatter; detects time refs and creates one-shot reminders; commit-confirm flow |
| `/retriever <question>` | Vault-grounded answer with note citations; says "I don't know" rather than hallucinate |
| `/curator` | Vault health report: stale inbox, draft promotions ready, project momentum, orphan candidates, MOC gaps |

Skills live in the vault's `.claude/skills/` directory — version-controlled with your knowledge, not the bot. Customize them.

### 3. The scheduler — built into the bot

Four built-in routines run on your timezone:

| Routine | Default | Purpose |
|---|---|---|
| Daily focus | 09:00 daily | Active projects + tasks digest |
| Weekly curator | Sunday 20:00 | Stale inbox, draft promotions, momentum |
| Monthly audit | 1st of month | Project health + area coverage |
| Quarterly review | Quarterly | Strategic synthesis: what shipped, what slipped |

Plus one-shot reminders triggered by `/scribe` ("remind me Friday at 3pm to ..."). Edit `bot-data/schedules.json` to customize.

---

## What the bot itself can do (access surface)

The Telegram interface accepts every media type and turns it into a Claude session:

- 💬 Text, voice, photos, documents, audio, video — all flow through the same agent
- 🔄 Session persistence — conversations continue across messages; `/resume` restores past sessions
- 📨 Message queuing — send multiple while Claude works; prefix with `!` to interrupt
- 🧠 Extended thinking — say "think" or "reason" to trigger Claude's reasoning mode
- 🔘 Interactive buttons — Claude presents choices as tappable Telegram keyboards
- 📎 File delivery — Claude sends files back via the chat
- 🔔 Notifications — scheduled routines and reminders deliver as actionable Telegram messages
- 🧵 Parallel sessions — optional: each forum topic in a supergroup is an independent Claude session (see [Parallel sessions](#parallel-sessions-forum-topics))

---

## Repo layout

Three repos cloned side by side:

```bash
git clone https://github.com/Ilyuha888/claude-telegram-bot ~/repos/claude-telegram-bot
git clone https://github.com/Ilyuha888/ctb-vault          ~/repos/ctb-vault
git clone https://github.com/Ilyuha888/bot-data           ~/repos/bot-data
```

- **`claude-telegram-bot`** (this repo) — bot code, Docker, scheduler runtime, MCP servers
- **`ctb-vault`** — knowledge vault scaffold (PARA + V-A spec + PKM skills + scheduler prompt templates) — see [its own README](https://github.com/Ilyuha888/ctb-vault)
- **`bot-data`** — example schedules + empty notification log; the bot reads/writes this at runtime; `sessions.json` is gitignored (conversation history stays personal)

The split lets each piece evolve independently: bot code on its own release cadence, vault under your control as your knowledge grows, runtime state isolated for backup and rotation.

---

## Quick start (Docker)

The recommended way to run the bot. No Bun or Node.js installation required on the host.

**1. Create your bot**

1. Open [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` → copy the token
3. Skip `/setcommands`: the bot registers its own command menu on every boot (`setMyCommands` from `src/commands-manifest.ts`), so the autocomplete list always matches the running version.

**Finding your Telegram user ID:** message [@userinfobot](https://t.me/userinfobot).

**2. Configure**

```bash
cd ~/repos/claude-telegram-bot
cp .env.example .env
```

Edit `.env` — minimum required:

```bash
TELEGRAM_BOT_TOKEN=1234567890:ABC-DEF...
TELEGRAM_ALLOWED_USER=123456789          # your Telegram user ID

# Paths (used by docker-compose as host-side mount sources)
BOT_DATA_DIR=../bot-data
CTB_VAULT_DIR=../ctb-vault
```

**3. Authenticate Claude**

The bot uses your Claude Code subscription (most cost-effective) or an API key:

```bash
# Option A — Claude Code CLI auth (recommended)
# Run once on the host; auth state is stored in ~/.claude/
# Docker mounts ~/.claude into the container, so this MUST run before
# `docker compose up` for the container to inherit your login.
claude

# Option B — API key (set in .env, billed per token)
ANTHROPIC_API_KEY=sk-ant-api03-...
```

**Where credentials live:**

| Credential | Where | Lifetime | Rotate |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | `.env` | Until revoked | `/revoke` in @BotFather, paste new token in `.env`, restart |
| `TELEGRAM_ALLOWED_USER` | `.env` | Permanent | Edit `.env`, restart |
| Claude CLI auth | `~/.claude/` (host) | Subscription session | Re-run `claude` on the host |
| `ANTHROPIC_API_KEY` | `.env` | Until deleted in console | Replace key in `.env`, restart |
| `OPENAI_API_KEY` | `.env` | Until deleted in console | Replace key in `.env`, restart |
| Google MCP auth | claude.ai session | Session-scoped | Re-auth via `/mcp` on claude.ai |

**4. Start**

```bash
docker compose up -d
docker compose logs -f   # watch startup
```

The container mounts `~/bot-data`, `~/ctb-vault`, and `~/.claude` (read-only, for Claude auth + settings + skills).

---

## Alternative: native (Linux/macOS)

If you prefer running without Docker:

**Prerequisites:** Bun 1.3+, Claude Code CLI, `pdftotext`.

```bash
# Bun
curl -fsSL https://bun.sh/install | bash

# Claude Code CLI
npm install -g @anthropic-ai/claude-code

# pdftotext
brew install poppler        # macOS
sudo apt install poppler-utils   # Debian/Ubuntu
```

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

**Linux systemd services** (`systemd/`, install with `sudo cp systemd/*.service /etc/systemd/system/ && sudo systemctl daemon-reload`). The unit files carry `/home/<user>` in `WorkingDirectory`, `EnvironmentFile`, `ExecStart` and `PATH`; replace it with the bot user's home before copying, e.g. `sed -i "s|/home/<user>|$HOME|g" systemd/*.service`.

| Unit | Role |
|---|---|
| `claude-rc-tmux` | Long-lived tmux server that owns every mode-2 RC session. Restarting it kills them all. |
| `claude-telegram-bot` | The bot process. Safe to restart any time; sessions live in the tmux server, not here. |
| `claude-assistant` | Interactive "KB Assistant" Claude session in tmux. Ordered after `claude-rc-tmux`. |

```bash
sudo systemctl restart claude-telegram-bot        # deploy new bot code; sessions survive
sudo systemctl restart claude-assistant           # restart only the KB Assistant session

# Full restart. Never `restart` all three in one command: systemd starts them in
# parallel, claude-assistant's `tmux new-session` wins the socket, the server
# lands in the wrong cgroup and `tmux -D` crash-loops on "not a terminal".
sudo systemctl stop claude-assistant claude-telegram-bot
sudo systemctl restart claude-rc-tmux
sudo systemctl start claude-assistant claude-telegram-bot
```

### Persistent operation: sleep, restart, lifecycle

This bot is designed for 24/7 server operation (Linux + systemd, or a small VPS running Docker). Running on a Mac laptop works but has caveats.

**On Mac sleep:**
- Bot process is paused. Telegram polling stops.
- Telegram queues incoming messages on its server for **~24 hours** — they'll be delivered when the bot wakes up.
- Scheduled routines (daily focus, weekly curator, etc.) miss their fire times during sleep, but the bot has **catch-up logic**: on wake, it reads `last_fired` from `bot-data/schedules.json` and fires anything that became due while asleep.
- One-shot reminders queued via `/scribe` ("remind me tomorrow at 9am") survive sleep — they're stored in `schedules.json` and fire on the first wake after the due time.

**On Mac restart / shutdown:**
- launchd (with the plist above) auto-restarts the bot on login. `RunAtLoad` + `KeepAlive` are set in the template.
- Past sessions are restored — chat session history lives in `${BOT_DATA_DIR}/chat-session-history.json`, which survives reboots. The bot auto-resumes the most recent session on the next message, or use `/resume` to pick from the last 5.
- A single in-flight Claude stream (if the bot was actively replying when the host went down) is interrupted; just send the message again.

**To prevent sleep while bot is running on Mac:**
- System Settings → Battery → Options → "Prevent automatic sleeping when the display is off" (only effective on power adapter)
- Or run `caffeinate -d` in a terminal as long as you want sleep blocked

**For 24/7 reliability**, run the bot on a Linux VPS (Hetzner, DigitalOcean, etc.) with Docker or systemd. The repo ships with both `docker-compose.yml` and a systemd-friendly layout for this case.

---

## Configuration

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | From @BotFather |
| `TELEGRAM_ALLOWED_USER` | ✅ | Your Telegram user ID (single integer — bot is single-tenant per deployment) |
| `ANTHROPIC_API_KEY` | if no CLI auth | Claude API key |
| `OPENAI_API_KEY` | | Voice transcription (without it, voice messages won't work) |
| `CLAUDE_WORKING_DIR` | | Where Claude runs — loads CLAUDE.md, skills, MCP config |
| `CTB_VAULT_DIR` | | Path to your vault (scheduler prompts default to `~/repos/ctb-vault`) |
| `BOT_DATA_DIR` | | Path to bot-data dir (default: `~/bot-data`) |
| `ALLOWED_PATHS` | | Comma-separated dirs Claude can access (overrides defaults; include `~/.claude`) |
| `TZ` | | Timezone for scheduler (default: `Europe/Moscow`; set to your own, e.g. `America/Los_Angeles`, `Europe/Berlin`, `Asia/Tokyo`) |

Everything else is optional and documented inline in [`.env.example`](.env.example), grouped as follows. Defaults are the values in that file.

| Group | Variables | What it controls |
|---|---|---|
| Parallel sessions | `TELEGRAM_GROUP_CHAT_ID`, `SESSION_IDLE_EVICT_MINUTES`, `TOPIC_IDLE_CLOSE_DAYS`, `MAX_ACTIVE_TOPICS`, `TOPIC_REAPER_INTERVAL_MS`, `AUTO_RESUME_TTL_HOURS`, `TOPIC_AUTO_RESUME_TTL_HOURS` | Forum-topic sessions and their idle/auto-close/resume windows (see below) |
| Turn batching | `TURN_BATCH_WINDOW_MS`, `TURN_BATCH_MAX_WAIT_MS`, `TURN_BATCH_MAX_ITEMS`, `TURN_BATCH_MAX_BYTES`, `TURN_BATCH_CARD` | A burst of messages (forwards, an album, typing faster than Claude answers) becomes one turn; `TURN_BATCH_WINDOW_MS=0` switches it off |
| Rich Messages | `RICH_MESSAGES_ENABLED`, `RICH_STREAMING_ENABLED` | Long or structured answers go out as Bot API Rich Messages (32k chars, tables, fenced code) instead of being split at 4096 |
| Mode 2 | `REPOS_DIR`, `REAPER_INTERVAL_MS`, `REAPER_IDLE_THRESHOLD_MS`, `MODE2_MENU_WORKTREE`, `WORKTREE_LINK_PATHS`, `WORKTREE_COPY_PATHS` | Remote coding sessions: where repos are discovered, when idle sessions retire, what a fresh worktree inherits |
| Security | `RATE_LIMIT_ENABLED`, `RATE_LIMIT_REQUESTS`, `RATE_LIMIT_WINDOW` | Token-bucket rate limit per user |
| Claude auth | `ANTHROPIC_API_KEY`, `CLAUDE_CLI_PATH` | API key instead of CLI login; explicit CLI path when it is not on `PATH` |
| Extended thinking | `THINKING_KEYWORDS`, `THINKING_DEEP_KEYWORDS` | Words in a message that switch on normal / deep thinking |
| Voice | `TRANSCRIPTION_CONTEXT_FILE` | Names and terms handed to the transcriber so they are not misheard |
| Logging | `AUDIT_LOG_PATH`, `AUDIT_LOG_JSON` | Where the audit log goes and whether it is JSON |

### Parallel sessions (forum topics)

Optional. With `TELEGRAM_GROUP_CHAT_ID` unset the bot behaves as a single DM conversation. Set it and every forum topic in that supergroup becomes an **independent Claude session** with its own context, history, `/status` and `/stop`; topics run in parallel and do not interrupt each other. `/topic [name]` opens one, `/close` inside a topic closes it, and every notification gains an "Open in new chat" button.

One-time manual setup, all four steps required:

1. Create a **supergroup** and turn on **Topics** (Manage group → Topics).
2. Add the bot as an **admin** with the **Manage Topics** permission.
3. **Disable privacy mode** for the bot in @BotFather (`/setprivacy` → Disable). Without this the bot only sees commands and replies in the group; plain messages inside topics never reach it, which looks exactly like the bot being broken.
4. Keep the group's membership to yourself: authorization is still the single `TELEGRAM_ALLOWED_USER`.

Then set `TELEGRAM_GROUP_CHAT_ID` to the group id (starts with `-100`) and restart. Routines and reminders are delivered to the group's General topic from then on, falling back to the DM only if that send fails. Idle windows, the topic cap and the auto-resume TTLs are the *Parallel sessions* group in the table above.

### MCP servers

Two built-in MCP servers ship with the bot and are **always loaded**, no setup required:

- **`ask-user`** — presents options as Telegram inline keyboard buttons (powers the `/scribe` commit-confirm flow)
- **`send-file`** — sends files (images, videos, audio, documents) back to the chat

These are wired in `src/config.ts` (`BUILTIN_MCP_SERVERS`); the implementations live in `ask_user_mcp/server.ts` and `send_file_mcp/server.ts`.

To add **personal** MCP servers (haft, Things, Notion, Typefully, etc.):

```bash
cp mcp-config.example.ts mcp-config.ts
# Uncomment what you want; user entries merge on top of the built-ins.
```

This file is optional — the bot runs fine without it.

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

> **First boot is quiet.** A fresh install seeds each schedule's `last_fired` to "now" so no routine fires immediately on first launch. The first real fire happens at the next cron tick (e.g. 09:00 MSK for daily focus). To force a catch-up for testing, backdate `last_fired` past the cadence window (23h for daily, 8d for weekly, etc.) and restart.

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
| `/topic [name]` | Open a forum topic with its own independent session (only with `TELEGRAM_GROUP_CHAT_ID`) |
| `/compact` | Summarize this session into a handoff brief and start fresh with it |
| `/resume` | Pick from last 5 sessions to resume (with recap) |
| `/retry` | Re-send the previous message |
| `/stop` | Interrupt current query |
| `/status` | Model, context usage with a breakdown, session state |
| `/model [model-id]` | Show or change the model; applies to the next `/new` |
| `/restart` | Restart the bot |
| `/menu` | Open Mode 2 control panel (remote session management) |
| `/work <repo> [subpath] [worktree] [branch]` | Spawn a Mode 2 coding session |
| `/sessions` | List open Mode 2 sessions with idle times |
| `/attach <slug>` | Get the claude.ai/code link for a session |
| `/close [slug]` | Close a Mode 2 session; bare `/close` closes the current forum topic |
| `/repos` | List the repos `/work` and `/menu` can spawn sessions on |

---

## Security

> **⚠️ Important:** This bot runs Claude Code in its `default` permission mode with the bot's own approval policy in front of every tool call: local work inside `ALLOWED_PATHS` is auto-approved, anything that leaves the machine or changes future sessions asks you via a Telegram inline keyboard. Claude can read, write, and execute commands within the allowed paths without a prompt. Understand the implications before deploying.

**→ [Read the full Security Model](SECURITY.md)**

Protections:
1. **User allowlist** — only your Telegram user ID can use the bot
2. **Auto-approval policy** — remote writes (`ssh`, `curl -d`, non-read `gh`), privilege escalation, connector tools that are not reads, and writes to `CLAUDE.md` / `settings*.json` ask first; everything local runs without a prompt (`checkAutoApprove` in `src/security.ts`; interactive sessions get the same lists from `config/claude-permissions.json` via `scripts/sync-claude-permissions.sh`)
3. **Path validation** — file access restricted to `ALLOWED_PATHS`
4. **Command safety** — patterns like `rm -rf /` are blocked
5. **Rate limiting** — prevents runaway usage
6. **Audit logging** — all interactions logged to `${BOT_DATA_DIR}/audit.log`

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
- Verify your user ID is in `TELEGRAM_ALLOWED_USER`
- `docker compose logs -f` or `tail -f /tmp/claude-telegram-bot-ts.err`

**Claude authentication issues**
- CLI auth: run `claude` on the host and verify you're logged in
- API key: check it starts with `sk-ant-api03-` and has credits at [console.anthropic.com](https://console.anthropic.com/)

**Voice messages fail**
- `OPENAI_API_KEY` must be set and have credits

**Scheduler not firing**
- Check `bot-data/schedules.json` for correct cron syntax
- Verify `TZ` is set to a valid IANA timezone (e.g. `Europe/Moscow`, `America/New_York`)

**`/menu` (Mode 2) fails to spawn a session**
- One-time setup per target repo: run `claude` interactively inside the repo once and accept the workspace-trust dialog. Trust persists for the workspace; subsequent `/menu` spawns succeed without prompts.
- The repo's default branch is detected automatically — `main`, `master`, or whatever HEAD points at — so this is no longer a source of "worktree already exists" errors.
- If the error names `claude-rc-tmux.service`, the long-lived tmux server that owns RC hosts is not running: `sudo systemctl start claude-rc-tmux`. Spawning is refused rather than falling back, because a server started by the bot would sit in the bot's cgroup and every session in it would die on the next bot restart. Check the journal for `mode2.tmux.no_server` or `mode2.tmux.in_service_cgroup`.

**Mode 2 sessions die whenever the bot restarts**
- Expected before `claude-rc-tmux.service` existed; a bug now. RC hosts must live in that unit's cgroup, not the bot's, because tmux panes inherit the *server's* cgroup. Verify with:
  ```bash
  RC_PID=$(tmux list-panes -t work-<slug> -F '#{pane_pid}')
  cat /proc/$RC_PID/cgroup   # want claude-rc-tmux.service, NOT claude-telegram-bot.service
  ```
- If it reads `claude-telegram-bot.service`, the bot started its own tmux server. Most likely cause: `PrivateTmp=` or `ProtectHome=` was added to a unit, which splits the `/tmp/tmux-$UID/default` socket path. Remove it and restart `claude-rc-tmux`.

**`pdftotext` not found (native mode)**
- macOS: `brew install poppler`
- Linux: `apt install poppler-utils`

---

## Attribution

Fork of [linuz90/claude-telegram-bot](https://github.com/linuz90/claude-telegram-bot) — see [NOTICE.md](NOTICE.md).

## License

MIT — see [LICENSE](LICENSE).
