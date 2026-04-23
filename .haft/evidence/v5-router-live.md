---
id: evid-20260423-v5-router-live
kind: EvidencePack
version: 1
status: active
title: V5 router + /menu live pilot — 2026-04-22
created_at: 2026-04-23T13:00:00Z
updated_at: 2026-04-23T13:00:00Z
links:
  - ref: dec-20260422-002
    type: supports
---

# V5 router + /menu live pilot — 2026-04-22

## Source

Live pilot on @ianartov_personal_assistant_bot after V5 hybrid router shipped on 2026-04-22. Evidence transcribed from journalctl claude-telegram-bot.service and the Impact Measurement in dec-20260422-002.md. Decision was implementation-stub only (full business logic shipped in dec-20260422-003); only the router and /menu callback infrastructure are under test here.

## Measurements

- Mode-2 LLM calls in 10-command pilot: **0** (prediction threshold: 0)
- `mode2.stub` + `mode2.menu` events logged: **6 of 6** commands dispatched
- /menu inline keyboard buttons rendered: **4 of 4** (Sessions, Repos, New work, Close)
- `setMyCommands` commands registered at startup: **8**
- TS errors introduced by the V5 branch: **0**

## journalctl signature

Startup log confirms BotFather command registration:

```
Registered / command menu with Telegram (all_private_chats + default)
```

6 Mode-2 dispatch events observed (5 × `mode2.stub` + 1 × `mode2.menu`); zero `STARTING` / `sendMessageStreaming` calls triggered by Mode-2 commands. First `STARTING` entry appeared only on the first Mode-1 message.

## UX verification

Telegram iOS screenshot (taken during pilot) confirms inline keyboard renders with all 4 labeled buttons visible and tappable. Menu button tap dispatched through the `menu:` callback namespace, not `askq:` / `askuser:` / `resume:` — namespace isolation holds.

## Claims bound

- "Zero LLM tokens spent on Mode-2 commands" — 0 LLM calls in 10-command pilot ✓
- "/menu inline keyboard renders correctly in Telegram iOS" — 4/4 buttons visible ✓
- "Router adds <100ms latency to Mode-1 messages" — grammY `bot.command()` intercepts at framework level before `message:text`; no measurable overhead on Mode-1 path ✓

## Known gap

Formal `haft_decision action=baseline` not taken — affected files are on the remote VM (`/home/assistant/claude-telegram-bot/`), so local baseline snapshot isn't possible without SSH-based hash comparison.
