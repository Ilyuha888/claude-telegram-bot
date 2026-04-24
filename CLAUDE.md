# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun run start      # Run the bot
bun run dev        # Run with auto-reload (--watch)
bun run typecheck  # Run TypeScript type checking
bun install        # Install dependencies
```

## Architecture

This is a Telegram bot (~4,200 lines TypeScript) that lets you control Claude Code from your phone via text, voice, photos, and documents. Built with Bun and grammY.

### Message Flow

```
Telegram message → Handler → Auth check → Rate limit → Claude session → Streaming response → Audit log
```

### Key Modules

- **`src/index.ts`** - Entry point, registers handlers, starts polling
- **`src/config.ts`** - Environment parsing, MCP loading, safety prompts
- **`src/session.ts`** - `ClaudeSession` class wrapping Agent SDK V2 with streaming, session persistence (`/tmp/claude-telegram-session.json`), and defense-in-depth safety checks
- **`src/security.ts`** - `RateLimiter` (token bucket), path validation, command safety checks
- **`src/formatting.ts`** - Markdown→HTML conversion for Telegram, tool status emoji formatting
- **`src/utils.ts`** - Audit logging, voice transcription (OpenAI), typing indicators
- **`src/types.ts`** - Shared TypeScript types
- **`src/scheduler.ts`** - In-process node-cron scheduler: fire loop, dialogue-interrupt gate (waits ≤60s if session active), boot catch-up, soft Telegram delivery with notification keyboard. `fs.watch(SCHEDULES_FILE)` picks up new one-shot entries written at runtime (e.g. by Scribe) without restart.
- **`src/scheduler-prompts.ts`** - Source-controlled prompt bodies for the 4 V_rich routines (daily focus, weekly curator, monthly audit, quarterly review)

### Mode-2 modules (`src/mode2/`)

- **`store.ts`** - Atomic JSON store for RC work sessions (write-tmp-rename, enqueue serialization)
- **`schedules-store.ts`** - Atomic JSON store for schedules (`bot-data/schedules.json`), tracks `last_fired`
- **`notifications-store.ts`** - Atomic JSON store for fired notifications (`bot-data/notifications.json`), 200-row cap
- **`reaper.ts`** - Idle session reaper + `resumeOnBoot` catch-up logic
- **`types.ts`** - Shared types: `WorkSession`, `Schedule`, `Notification`

### Handlers (`src/handlers/`)

Each message type has a dedicated async handler:
- **`commands.ts`** - `/start`, `/new`, `/stop`, `/status`, `/resume`, `/restart`, `/retry`
- **`text.ts`** - Text messages with intent filtering
- **`voice.ts`** - Voice→text via OpenAI, then same flow as text
- **`audio.ts`** - Audio file transcription via OpenAI (mp3, m4a, ogg, wav, etc.), also handles audio sent as documents
- **`photo.ts`** - Image analysis with media group buffering (1s timeout for albums)
- **`document.ts`** - PDF extraction (pdftotext CLI), text files, archives, routes audio files to `audio.ts`
- **`video.ts`** - Video messages and video notes
- **`callback.ts`** - Inline keyboard button handling; prefix dispatch: `resume:`, `permask:`, `notif:`, `m2:`, `menu:`, `askq:`, `askuser:`
- **`streaming.ts`** - Shared `StreamingState` and status callback factory
- **`mode2/menu.ts`** - `/menu` inline keyboard controller; all `m2:` callbacks handled here
- **`mode2/notifications.ts`** - Notification callbacks (`notif:show/new/del/remind/sched-del/tab`); Scheduled and Fired tab renderers. Scheduled tab shows verbose pending one-shot reminders with per-row delete buttons and human-readable fire times.

### Security Layers

1. User allowlist (`TELEGRAM_ALLOWED_USERS`)
2. Rate limiting (token bucket, configurable)
3. Path validation (`ALLOWED_PATHS`)
4. Command safety (blocked patterns)
5. System prompt constraints
6. Audit logging

### Configuration

All config via `.env` (copy from `.env.example`). Key variables:
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS` (required)
- `CLAUDE_WORKING_DIR` - Working directory for Claude
- `ALLOWED_PATHS` - Directories Claude can access
- `OPENAI_API_KEY` - For voice transcription

MCP servers defined in `mcp-config.ts`.

### Runtime Files

- `/tmp/claude-telegram-session.json` - Session persistence for `/resume`
- `/tmp/telegram-bot/` - Downloaded photos/documents
- `/tmp/claude-telegram-audit.log` - Audit log
- `bot-data/schedules.json` - Scheduler registry: cron expressions, `last_fired`, one-shot remind entries
- `bot-data/notifications.json` - Delivered notification history (content, status, Telegram message metadata)

## Patterns

**Adding a command**: Create handler in `commands.ts`, register in `index.ts` with `bot.command("name", handler)`

**Adding a message handler**: Create in `handlers/`, export from `index.ts`, register in `index.ts` with appropriate filter

**Streaming pattern**: All handlers use `createStatusCallback()` from `streaming.ts` and `session.sendMessageStreaming()` for live updates.

**Type checking**: Run `bun run typecheck` periodically while editing TypeScript files. Fix any type errors before committing.

**After code changes**: Restart the bot so changes can be tested. On Linux with systemd: `sudo systemctl restart claude-telegram-bot`. For manual runs: `bun run start`. The scheduler re-registers all cron handles on startup and fires any stale catch-up tasks automatically.

**Scheduler invariants**: Ephemeral Claude sessions spawned by the scheduler MUST NOT write to `SESSION_FILE` (enforced via `ClaudeSession({ persist: false })`). The scheduler polls `session.isRunning` for ≤60s before firing to avoid interrupting active dialogue.

**One-shot reminder lifecycle**: Scribe writes a `scribe_reminder` entry to `bot-data/schedules.json` (prompt_key `scribe_reminder`, `one_shot: true`, payload has `reminder_message` + `note_path`). The scheduler's `fs.watch` picks this up within seconds and registers a `setTimeout` timer — no restart needed. When fired, the notification shows a [Log outcome] button that primes a new session with the original reminder title and note content so the agent can capture the outcome. The `registeredOneShotIds` Set prevents duplicate timer registration on re-reads.

## Attachment persistence contract

When the user sends photos or documents via Telegram, each message's user turn includes a machine-readable block:

```
[Attachments on disk:
  - /tmp/telegram-bot/photo_1714082400000_a7b3c2.jpg (image/jpeg, 2.30 MB)
  - /tmp/telegram-bot/visa_receipt.pdf (application/pdf, 180 KB)
]
```

The files under `/tmp/telegram-bot/` are Read-allowed (TEMP_PATHS) and survive the turn. The vault and other repos under `REPOS_DIR` are Write-allowed.

When the user asks to persist an attachment (e.g. "attach this to my visa note"):

1. `Read` the bytes from the `/tmp/telegram-bot/` path.
2. `Write` them into a sibling `files/` directory next to the target note, using the convention `YYYY-MM-DD_HHMMSS_<original-basename>.<ext>` (or a short content hash if no sensible name exists).
3. `Edit` the note to add a wikilink to the saved file (Obsidian style: `![[files/<filename>]]` for images, `[[files/<filename>]]` otherwise).
4. Commit via `git add <files>` + `git commit -m "..."` — the commit-confirm prompt will surface on Telegram; user approval goes through the existing callback flow.
5. Reply with the absolute paths of the saved files so the user can verify.

The attachment hint is in addition to the SDK's inline image/PDF content blocks — vision still works. Use the hint when the user intent is persistence, not analysis.

## Standalone Build

The bot can be compiled to a standalone binary with `bun build --compile`. This is used by the ClaudeBot macOS app wrapper.

### External Dependencies

PDF extraction uses `pdftotext` CLI instead of an npm package (to avoid bundling issues):

```bash
brew install poppler  # Provides pdftotext
```

### PATH Requirements

When running as a standalone binary (especially from a macOS app), the PATH may not include Homebrew. The launcher must ensure PATH includes:
- `/opt/homebrew/bin` (Apple Silicon Homebrew)
- `/usr/local/bin` (Intel Homebrew)

Without this, `pdftotext` won't be found and PDF parsing will fail silently with an error message.

## Commit Style

Do not add "Generated with Claude Code" footers or "Co-Authored-By" trailers to commit messages.

## Running as Service (macOS)

```bash
cp launchagent/com.claude-telegram-ts.plist.template ~/Library/LaunchAgents/com.claude-telegram-ts.plist
# Edit plist with your paths
launchctl load ~/Library/LaunchAgents/com.claude-telegram-ts.plist

# Logs
tail -f /tmp/claude-telegram-bot-ts.log
tail -f /tmp/claude-telegram-bot-ts.err
```

## PKM Skills

Three Claude Code skills for Obsidian vault operations, invocable via Telegram slash commands:

| Skill | Invoke | What it does |
|-------|--------|--------------|
| **Scribe** | `/scribe` or `/scribe <text>` | Captures input → `User_Obsidian_Vault/00-inbox/` with correct frontmatter, duplicate check, attachment wikilinks, commit-confirm. Detects time references and sets a `scribe_reminder` one-shot if `reminder_date` found. |
| **Retriever** | `/retriever what do I know about X` | Vault-grounded answer with note citations; scope statement when answer is partial; no hallucination |
| **Curator** | `/curator` | Stale inbox, draft promotions, orphan candidates, MOC gaps — read-only, ≤1500 chars for Telegram |

Skill files live in `~/.claude/skills/` on the VM. The weekly curator also runs automatically every Sunday 20:00 MSK via the scheduler (`prompt_key: weekly_curator` in `schedules.json`).

**Implicit routing**: The SAFETY_PROMPT (rule 6 in `src/config.ts`) maps natural-language intent patterns to the correct skill — the user doesn't need to type `/scribe` explicitly. Triggers: "note for tomorrow", "save this", "remember that", "what do I know about", "vault health", etc.

**Scribe frontmatter**: When a time reference is detected, Scribe adds `reminder_date: YYYY-MM-DD` to the note frontmatter and writes a `scribe_reminder` entry to `bot-data/schedules.json` after the commit is confirmed. The fire time defaults to 09:00 MSK.

**Notification UX for routine sessions**: [New session] on curator/audit/quarterly notifications primes with `/curator`. [Log outcome] on scribe_reminder notifications primes with the original note content for outcome capture.

## Governance

For architecture invariants, haft decisions, and safety rules, see `AGENTS.md` and `.haft/`.
