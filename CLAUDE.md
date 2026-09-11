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
- **`src/session.ts`** - `ClaudeSession` class wrapping Agent SDK V2 with streaming, resume, and defense-in-depth safety checks. Instances are per-conversation, never global — the module exports the class only
- **`src/conversation.ts`** - `ConversationKey {chatId, threadId}`, `convKeyFromCtx`, `convKeyStr`, `threadOpts`, `DeliveryTarget`. One key = one independent Claude session. DMs and the General topic both normalize to `threadId: undefined`
- **`src/session-registry.ts`** - `registry.get/peek/kill/isAnyRunning/evictIdle` — the map of live `ClaudeSession` instances keyed by conversation
- **`src/session-store.ts`** - Atomic serialized store for `${BOT_DATA_DIR}/chat-session-history.json`; per-conversation pruning
- **`src/topics.ts`** - `spawnTopicSession` (the one primitive that creates a topic + session), `closeTopic`, `enforceTopicCap`, `reregisterTopics` (boot resume), naming and deep-link helpers
- **`src/topics-store.ts`** - Atomic JSON store for `bot-data/topics.json`; `touch` on every turn drives the idle timers
- **`src/topic-reaper.ts`** - Lifecycle tick: evicts idle in-memory sessions, auto-closes idle topics. Inert without `TELEGRAM_GROUP_CHAT_ID`
- **`src/security.ts`** - `RateLimiter` (token bucket), path validation, command safety checks
- **`src/formatting.ts`** - Markdown→HTML conversion for Telegram, tool status emoji formatting
- **`src/utils.ts`** - Audit logging, voice transcription (OpenAI), typing indicators
- **`src/types.ts`** - Shared TypeScript types
- **`src/scheduler.ts`** - In-process node-cron scheduler: fire loop, dialogue-interrupt gate (waits ≤60s if session active), boot catch-up, soft Telegram delivery with notification keyboard. `fs.watch(SCHEDULES_FILE)` picks up new one-shot entries written at runtime (e.g. by Scribe) without restart.
- **`src/scheduler-prompts.ts`** - Source-controlled prompt bodies for the 4 V_rich routines (daily focus, weekly curator, monthly audit, quarterly review)

### Turn modules (`src/turn/`)

- **`part.ts`** - `TurnPart` (one prepared Telegram message) and `composeTurn` (N parts → one prompt). Pure
- **`dispatcher.ts`** - `runExclusive` (per-conversation keyed mutex) and `runTurn` (the whole tail: title, streaming, crash-retry, audit, cleanup)
- **`collector.ts`** - The buffer: arrival accounting, debounce, bounds, the collecting card, `dropPending`

### Mode-2 modules (`src/mode2/`)

- **`store.ts`** - Atomic JSON store for RC work sessions (write-tmp-rename, enqueue serialization)
- **`schedules-store.ts`** - Atomic JSON store for schedules (`bot-data/schedules.json`), tracks `last_fired`
- **`notifications-store.ts`** - Atomic JSON store for fired notifications (`bot-data/notifications.json`), 200-row cap
- **`reaper.ts`** - Idle session reaper + `resumeOnBoot` catch-up logic
- **`sh.ts`** - Every external command mode 2 runs (tmux + git), each behind a named wrapper over one private `run()`. Also owns the RC host environment (`pushTmuxEnvironment`) and the spawn-time cgroup guard (see *RC host lifetime* below)
- **`slug.ts`** / **`errors.ts`** / **`repos.ts`** / **`worktree-bootstrap.ts`** - Session id minting, typed errors, repo discovery, and making a fresh worktree usable (node_modules symlink, `.env` copy, workspace pre-trust)
- **`types.ts`** - Shared types: `WorkSession`, `Schedule`, `Notification`

### Handlers (`src/handlers/`)

Each message type has a dedicated async handler:
- **`commands.ts`** - `/start`, `/new`, `/stop`, `/status`, `/resume`, `/restart`, `/retry`, `/compact`, `/model`, `/topic`, `/close`
- **`text.ts`** - Text messages with intent filtering
- **`voice.ts`** - Voice→text via OpenAI, then same flow as text
- **`audio.ts`** - Audio file transcription via OpenAI (mp3, m4a, ogg, wav, etc.), also handles audio sent as documents
- **`photo.ts`** - Image analysis; one photo = one part, albums coalesce in the collector
- **`document.ts`** - PDF extraction (pdftotext CLI), text files, archives, routes audio files to `audio.ts`
- **`video.ts`** - Video messages and video notes
- **`callback.ts`** - Inline keyboard button handling; prefix dispatch: `resume:`, `permask:`, `notif:`, `m2:`, `menu:`, `askq:`, `askuser:`
- **`streaming.ts`** - Shared `StreamingState` and status callback factory
- **`mode2/menu.ts`** - `/menu` inline keyboard controller; all `m2:` callbacks handled here
- **`mode2/notifications.ts`** - Notification callbacks (`notif:show/new/del/remind/sched-del/tab`); Scheduled and Fired tab renderers. Scheduled tab shows verbose pending one-shot reminders with per-row delete buttons and human-readable fire times.

### Security Layers

1. User allowlist (`TELEGRAM_ALLOWED_USER`)
2. Rate limiting (token bucket, configurable)
3. Path validation (`ALLOWED_PATHS`)
4. Command safety (blocked patterns) and the auto-approval policy in `security.ts`: local work runs without a prompt; remote writes, privilege escalation (`isRemoteWriteCommand`) and connector tools whose verb is not a read (`isClaudeAiReadTool`) ask via a Telegram keyboard
5. System prompt constraints
6. Audit logging

### Configuration

All config via `.env` (copy from `.env.example`). Key variables:
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER` (required)
- `CLAUDE_WORKING_DIR` - Working directory for Claude
- `ALLOWED_PATHS` - Directories Claude can access
- `OPENAI_API_KEY` - For voice transcription
- `TELEGRAM_GROUP_CHAT_ID` - Supergroup for parallel sessions. **Unset = single-DM behavior, unchanged** (see below)
- `SESSION_IDLE_EVICT_MINUTES` (120) - Drop an unused conversation from memory. Invisible: the next message resumes it
- `AUTO_RESUME_TTL_HOURS` (24) / `TOPIC_AUTO_RESUME_TTL_HOURS` (720) - How long a conversation can be idle and still auto-resume. Topics get their own, much longer window (see *Resume windows* below)
- `TOPIC_IDLE_CLOSE_DAYS` (7, `0` disables) - Auto-close a topic left untouched this long
- `MAX_ACTIVE_TOPICS` (20, `0` disables) - Cap on open topics; spawning past it closes the oldest idle one first
- `TOPIC_REAPER_INTERVAL_MS` (300000) - How often the two timers above are scanned
- `TURN_BATCH_WINDOW_MS` (1500, `0` disables) - Trailing debounce before a burst is dispatched as one turn. `0` is the rollback switch; albums still coalesce (see *Turn batching* below)
- `TURN_BATCH_MAX_WAIT_MS` (15000) / `TURN_BATCH_MAX_ITEMS` (25) / `TURN_BATCH_MAX_BYTES` (24 MiB) - Bounds. All three flush early; nothing is ever dropped
- `TURN_BATCH_CARD` (`always`|`multi`|`off`) - The `📥 Collecting…` card

MCP servers defined in `mcp-config.ts`.

Interactive sessions (KB Assistant, mode-2 remote-control hosts) get the same policy as settings rules: `config/claude-permissions.json` holds the allow/ask lists and `scripts/sync-claude-permissions.sh` writes them into `.claude/settings.local.json` of every repo under `REPOS_DIR` (the vault receives the ask list plus rules that hand `curl`, `wget`, `gh` and file writes back to the bot, so the mode-1 code policy stays authoritative there). A remote-control session opened in the vault therefore still prompts for those tools; that is the accepted price. Re-run the script after editing the JSON.

### Runtime Files

- `${BOT_DATA_DIR}/chat-session-history.json` - Session persistence for `/resume` (survives host reboots)
- `/tmp/telegram-bot/` - Downloaded photos/documents
- `${BOT_DATA_DIR}/audit.log` - Audit log (survives host reboots; configurable via `AUDIT_LOG_PATH`)
- `bot-data/schedules.json` - Scheduler registry: cron expressions, `last_fired`, one-shot remind entries
- `bot-data/notifications.json` - Delivered notification history (content, status, Telegram message metadata)
- `bot-data/topics.json` - Forum topic registry: `thread_id`, `chat_id`, `name`, `session_id`, `last_active_at`, `closed`. Inert without `TELEGRAM_GROUP_CHAT_ID`

## Parallel sessions / forum topics

Each Telegram forum topic in one supergroup is an **independent Claude session** — its own context, history, `/status` and `/stop`. They run in parallel and don't interrupt each other. Routing is by `ConversationKey = (chatId, threadId)`.

**With `TELEGRAM_GROUP_CHAT_ID` unset, everything behaves exactly as the single-DM bot did**: every message resolves to one implicit key per chat, no topic is ever created, the reaper never starts, and `/topic` and `/close` are absent from the command menu and `/start` help.

### One-time manual setup (all of it required)

1. Create a **supergroup** and turn on **Topics** (Manage group → Topics).
2. Add the bot as an **admin** with the **Manage Topics** permission.
3. **Disable privacy mode** in @BotFather (`/setprivacy` → Disable). Without this the bot only sees commands and replies in the group — plain messages inside topics never reach it, which looks exactly like the bot being broken.
4. Keep the group's membership to yourself: auth is still a single `TELEGRAM_ALLOWED_USER`.
5. Set `TELEGRAM_GROUP_CHAT_ID` to the supergroup id (starts with `-100`) and restart.

### Lifecycle

- **`/topic [name]`** opens a topic with a fresh session. Notifications also carry an "Open in new chat" button that spawns one, primed with the notification's content.
- **`/close`** (no argument, sent inside a topic) closes it: abort any query in flight (`stop()` → 100ms → `clearStopRequested()`, the same dance as `/new`) → `closeForumTopic` → kill the session → mark `closed` in `topics.json`. Stop-and-close, not refuse-if-busy: unlike the cap and the reaper, `/close` names one topic and has no alternative to pick — the interruption is reported in the confirmation instead. The SDK session is deliberately **left on disk**, so reopening the topic from the Telegram UI and posting within the auto-resume TTL continues the same conversation. Refused in the General topic and in DMs — there's no topic there; `/new` clears the conversation instead. `/close <slug>` still closes a mode-2 work session (same verb, different object — see `handleCloseCommand`).
- **Idle session eviction** drops in-memory instances after `SESSION_IDLE_EVICT_MINUTES`. Invisible: nothing on disk changes, and the next message re-creates the instance and auto-resumes.
- **Idle topic auto-close** closes topics untouched for `TOPIC_IDLE_CLOSE_DAYS`, after posting a note into them.
- **`MAX_ACTIVE_TOPICS`** is enforced *before* creating a topic: the oldest-idle one is closed to make room, and a topic with a running query is never a candidate. If every topic is busy the spawn fails rather than exceeding the cap.
- **Duplicate names are disambiguated, not rejected.** `uniqueTopicName` stamps a colliding name with the date (`Daily focus · 29 Jul`), then the time, then a counter. A name no *open* topic is using is left exactly as given — `/topic refactor auth` must not acquire a stamp. Closed topics don't reserve their names, so closing one frees it for reuse. This is purely cosmetic: nothing resolves a topic by name (`topics.json` keys on `thread_id`, the registry on `(chatId, threadId)`), and Telegram itself permits duplicates — the problem it solves is a sidebar full of identical `Daily focus` rows from pressing "Open in new chat" on a recurring routine each morning.

### Resume windows

A conversation idle longer than its auto-resume TTL starts a **fresh** session on its next message. Two windows, because a DM and a topic are different objects: a DM is one rolling scratchpad (24h), a topic is a named thread opened deliberately and closed by hand, where continuing it next week is the entire point (720h / 30 days). `autoResumeTtlMs(threadId)` in `config.ts` is the single source — `tryAutoResume` and `reregisterTopics` both read it, and they **must agree**, or a topic continues or not depending on whether the bot restarted.

Three things that are easy to get wrong here:

- **Declining is never silent.** `tryAutoResume` sets `_pendingAutoResumeNotice` on the TTL path too, not just on success. The original bug wasn't the fresh context, it was that nothing said so — the user spent a conversation asking a bot with no memory what it remembered. The notice points at `/resume`, which is accurate: `/resume` filters by conversation, working dir and `errored`, but never by age.
- **`errored` entries get no notice**, deliberately: `getSessionList` drops them for `/resume` too, so there'd be nothing to point at.
- **30 days is a real ceiling.** Claude Code deletes its own transcript `.jsonl` files after `cleanupPeriodDays` (default 30). A longer window mints session ids whose transcript is gone; `classifyClaudeError` catches that as `session_gone` and `ClaudeSession` clears the id so the failure costs one explanatory message instead of a permanently wedged topic. Raising the window past 720h means raising `cleanupPeriodDays` too.

**Topic invariants**: `last_active_at` is written by `ClaudeSession.sendMessageStreaming` (via `noteTopicActivity`) — the single choke point every message type passes through. Add new entry points there, not in individual handlers. Same for `session_id`, recorded on the first turn of every session so a `/new` inside a topic doesn't leave `topics.json` pointing at the abandoned conversation.

## Turn batching

A burst of messages — forwarded, or typed faster than Claude answers — becomes **one** turn. Each message becomes a `TurnPart`; the collector holds them behind a trailing debounce (`TURN_BATCH_WINDOW_MS`) and `composeTurn` merges them into one prompt.

**A handler prepares, it never dispatches.** The boundary is greppable: prepare may talk to Telegram and do I/O, but must never touch `ClaudeSession`. `registry.get` does not appear in any of the six message handlers. Everything after submission — title, streaming, crash-retry, audit, temp cleanup — is `runTurn` in `src/turn/dispatcher.ts`.

Four things here are load-bearing and each has a failure mode that unit tests written without it in mind will pass:

- **`beginArrival` synchronously at handler entry, before the first `await`; `endArrival` in a `finally` on every path.** `sequentialize` orders handlers, it does not make them instant. A text message arms the debounce at t=0 while a voice note beside it spends four seconds transcribing; without the arrival counter the timer fires and dispatches the text *alone*. The bug is intermittent, latency-dependent, and production-only. An arrival counted and never released is worse: that conversation stalls forever with the card up.
- **The flush is detached, and must be.** If a handler awaited it, the flush would wait for more messages, those messages would wait for `sequentialize`'s per-key lock, and the lock would wait for the handler. `submitPart` returns immediately; the turn runs from a timer, *outside* the middleware — which is the entire reason `runExclusive` (a per-conversation keyed mutex) exists. Keyed, not global: one mutex would serialise every forum topic behind every other and destroy the parallel-sessions promise.
- **Detach the batch after acquiring the mutex, not before.** Detaching first strands parts that arrive during the wait into a second batch running a millisecond later — the very bug this removes. The one exception is the byte cap, which must `seal()` synchronously: the detach is a microtask away, which is plenty of time for the overflowing part to be appended to the batch it just overflowed.
- **Media blocks immediately follow their own part's text block. Never regroup.** Hoisting all text first and all media last is the tidier-looking shape and it silently unbinds captions from images — plausible wrong answers, not errors.

**Albums are protocol handling, not batching.** Telegram splits one user action into N updates and never says how many, so `MEDIA_GROUP_TIMEOUT` (1s) survives as a *window floor* for parts carrying `mediaGroupId` — albums coalesce even at `TURN_BATCH_WINDOW_MS=0`. There is no second buffer: `handlers/media-group.ts` is gone, because two levels of grouping stack their latencies and make the `inflight` count a guess.

**A pending buffer is invisible to every idleness check.** A conversation collecting a burst has no running query, and `last_active_at` isn't written until the turn starts — so the session reaper, the topic auto-close and the scheduler's dialogue gate all need an explicit pin (`isCollecting` / `collectingKeys` / `hasAnyPending`). The pin is passed *down* from `topic-reaper.ts` into `registry.evictIdle`: `collector → dispatcher → session-registry` already exists and the reverse import would close a cycle.

Commands that make a buffer meaningless **drop** it (`/new`, `/stop`, `!stop`, `/close`); commands that would race it **refuse** (`/compact`, `/retry`). `dropPending` also marks `cancelBefore`, which cancels messages still being prepared — a voice note three seconds into transcription submits into nothing rather than into a session the user has just cleared.

## Patterns

**Adding a command**: Create handler in `commands.ts`, register in `index.ts` with `bot.command("name", handler)`

**Adding a message handler**: Create in `handlers/`, export from `index.ts`, register in `index.ts` with appropriate filter. It builds a `TurnPart` and calls `submitPart` — see *Turn batching* above; it does not call `sendMessageStreaming`.

**Streaming pattern**: `runTurn` (`src/turn/dispatcher.ts`) owns `createStatusCallback()` from `streaming.ts` and `session.sendMessageStreaming()`. The remaining direct callers are the paths that are not inbound messages: `callback.ts` and `mode2/notifications.ts` (button actions), `topics.ts` (priming a spawned topic), `commands.ts` (`/compact`) and the scheduler.

**Rich Messages have no `text`** — the one thing to know before touching an incoming-message path. Anything the bot sends over 4096 chars, or with a table, ≥2 headings, a language-tagged fence, or math, goes out via `sendRichMessage` (`shouldUseRichMessage` in `rich.ts`). Such a message comes *back* — as a reply target, a forward, or an update — with `Message.text` unset and its content nested in `rich_message.blocks`. So the idiom `msg.text ?? msg.caption` silently sees nothing, and `bot.on("message:text")` doesn't match at all. Read it with `incomingRichText(msg)` / `isRichMessage(msg)` from `rich.ts`; never add a bare `.text` read. Both failures were live: replying to a long answer quoted `[non-text message]`, and forwarding one matched no handler and vanished without a reply. `index.ts` now ends with a rich-message route plus an `unhandledContentKind` fallback so no user content is ever dropped in silence.

The observed payload, which is **not** what core.telegram.org describes:

```
rich_message: { blocks: [ { type: "paragraph", text: "…" },
                          { type: "pre",       text: "…" }, … ] }
```

`blocks` is the only key — there is no flat `text`/`markdown`/`html`, no `entities` alongside it, and block types are lowercase short names (`paragraph`, `pre`), not the `RichBlockParagraph` identifiers the docs list. This cost three production restarts because the first implementation read `rich_message.text` — a field taken from a *summarised* reading of the docs, never checked against a payload. The tests were written to the same fiction, so they passed green while the feature was broken end to end. **For an undocumented or newly-added wire field, get the shape from a real update before coding against it**; `describeMessageShape` / `describeRichShape` in `utils.ts` exist for exactly that and log field names only, never content.

Related: every message in a forum topic reports the topic's `forum_topic_created` service message as its `reply_to_message`. Treating that as a quote stamps a bogus `[Replying to: …]` on the first turn of every topic — `buildMessageContext` skips it.

**Type checking**: Run `bun run typecheck` periodically while editing TypeScript files. Fix any type errors before committing.

**After code changes**: Restart the bot so changes can be tested. On Linux with systemd: `sudo systemctl restart claude-telegram-bot`. For manual runs: `bun run start`. The scheduler re-registers all cron handles on startup and fires any stale catch-up tasks automatically.

This restart is safe for mode-2 sessions — but only because they were deliberately moved out of the bot's cgroup. See *RC host lifetime* below before touching anything tmux-related. Note also that the bot's own user is not in sudoers, so an agent running *as the bot* cannot issue this command and must ask the operator.

**RC host lifetime (mode 2)**: RC hosts live in a separate systemd unit's cgroup, `claude-rc-tmux.service` (unit text in `systemd/claude-rc-tmux.service`), so `systemctl restart claude-telegram-bot` no longer kills live sessions. This is not cosmetic — before it, every restart destroyed in-flight work, and the symptom was a misleading `[Request interrupted by user for tool use]`.

The mechanism is one tmux property: **panes inherit the tmux server's cgroup, not the client's**, because the server forks them. So the server has to be started by that unit and not by the bot. Consequences:

- **Never** add `PrivateTmp=` or `ProtectHome=` to either unit. The socket path (`/tmp/tmux-$UID/default`) would diverge, the bot would silently start its own in-cgroup server, and the bug returns with no visible symptom. `TMUX_TMPDIR` is deliberately unset everywhere.
- **Never** give the tmux unit an `EnvironmentFile=`. The bot publishes only what RC hosts need via `pushTmuxEnvironment()`; loading `.env` there would put `TELEGRAM_BOT_TOKEN` and `OPENAI_API_KEY` back into every host's environ.
- `tmuxNewSession` refuses to spawn if no external server exists or if the server shares the bot's cgroup, logging `mode2.tmux.no_server` / `mode2.tmux.in_service_cgroup` with the remedy. Restart `claude-rc-tmux` in that case — which **does** kill all sessions.
- `resumeOnBoot` now only retires a session record on a *terminal* failure. "duplicate session", a missing server, or a guard refusal leave the record open (`mode2.resume.boot.deferred`), because closing it would orphan a healthy running host from `/sessions`, `/attach` and `/close`.

**Scheduler invariants**: Ephemeral Claude sessions spawned by the scheduler MUST NOT write to `SESSION_FILE` (enforced via `ClaudeSession({ persist: false })`). The scheduler polls `session.isRunning` for ≤60s before firing to avoid interrupting active dialogue.

**A failed routine must never be silent.** `fire()` retries a transient failure (`FIRE_RETRY_DELAYS_MS`, gated on `isTransientClaudeError` in `utils.ts`) and, if every attempt fails, delivers a `⚠️ Routine failed` card via `reportFireFailure` — recorded as a real Notification so it also appears in the Fired tab. Before this, the catch did `console.error` + `return`: on 2026-07-30 the 09:00 daily focus died on `API Error: 529 Overloaded` 3.5 minutes in and left no trace anywhere the user looks, surfacing a day later as "is the scheduler broken?". Nobody watches the process, so the delivery channel has to carry its own failures. `last_fired` is deliberately *not* touched on failure, which is what makes the cadence-window catch-up in `startScheduler()` re-fire the routine on the next restart. Note the retry is scheduler-only — an interactive handler must not silently re-run a query the user is waiting on.

**Reading the bot's logs: the host is UTC, the routines are MSK.** All four default schedules use `tz: "Europe/Moscow"`, so the 09:00 daily focus is logged at `06:00` and `journalctl -S '09:00'` returns `-- No entries --` for it. That empty result reads exactly like "the bot logs nothing" and cost a full debugging round. Convert first, or pass an explicit zone:

```bash
journalctl -u claude-telegram-bot -S '2026-07-30 05:55' -U '2026-07-30 06:20'   # UTC, as the host sees it
```

Also: `sudo` is not required and is the wrong reflex here. The bot runs as `assistant`, so `assistant`'s own unprivileged journal view contains every line it writes — an agent running as the bot can read its own logs with plain `journalctl -u claude-telegram-bot` and should check before claiming it can't. `assistant` is in neither `adm` nor `systemd-journal`, so only *other* units' logs are actually out of reach.

**Notification delivery is group-first**: routines and reminders go to the supergroup's General topic when `TELEGRAM_GROUP_CHAT_ID` is set, and fall back to the DM only if that send fails. Every send site goes through `sendNotificationCard` — do not reintroduce a bare `chatId = ALLOWED_USER`, which is what put the cards in the DM while their own "Open in new chat" buttons acted on the group. The DM fallback is deliberate: a notification has no user action behind it, so an unreachable group has nobody to report the failure to, and losing the daily routine silently is worse than delivering it to the old address. `patchMessageMeta` records whichever chat accepted it, since that's the message the callbacks edit.

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
| **Scribe** | `/scribe` or `/scribe <text>` | Captures input → `${CTB_VAULT_DIR}/inbox/` with correct frontmatter, duplicate check, attachment wikilinks, commit-confirm. Detects time references and sets a `scribe_reminder` one-shot if `reminder_date` found. |
| **Retriever** | `/retriever what do I know about X` | Vault-grounded answer with note citations; scope statement when answer is partial; no hallucination |
| **Curator** | `/curator` | Stale inbox, draft promotions, orphan candidates, MOC gaps — read-only, ≤1500 chars for Telegram |

Skill files live in `~/.claude/skills/` on the VM. The weekly curator also runs automatically every Sunday 20:00 MSK via the scheduler (`prompt_key: weekly_curator` in `schedules.json`).

**Implicit routing**: The SAFETY_PROMPT (rule 6 in `src/config.ts`) maps natural-language intent patterns to the correct skill — the user doesn't need to type `/scribe` explicitly. Triggers: "note for tomorrow", "save this", "remember that", "what do I know about", "vault health", etc.

**Scribe frontmatter**: When a time reference is detected, Scribe adds `reminder_date: YYYY-MM-DD` to the note frontmatter and writes a `scribe_reminder` entry to `bot-data/schedules.json` after the commit is confirmed. The fire time defaults to 09:00 MSK.

**Notification UX for routine sessions**: [New session] on curator/audit/quarterly notifications primes with `/curator`. [Log outcome] on scribe_reminder notifications primes with the original note content for outcome capture.

## Governance

For architecture invariants, haft decisions, and safety rules, see `AGENTS.md` and `.haft/`.
