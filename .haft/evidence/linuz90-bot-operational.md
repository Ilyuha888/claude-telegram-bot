---
id: evid-20260423-linuz90-bot-operational
kind: EvidencePack
version: 1
status: active
title: linuz90/claude-telegram-bot — operational state — 2026-04-23 (verdict partial)
created_at: 2026-04-23T13:01:10Z
updated_at: 2026-04-23T13:01:10Z
links:
  - ref: dec-20260416-003
    type: supports
---

# linuz90/claude-telegram-bot — operational state — 2026-04-23

## Source

Current-state audit of the linuz90 bot adoption decision (dec-20260416-003). The latest Impact Measurement verdict remains **partial** by design — known evidence gaps persist (see "Known gaps"). This pack records the features that *are* verified plus the gaps that are *not*, so the partial verdict is auditable.

## Operational posture (2026-04-23)

- `systemctl is-active claude-telegram-bot.service`: **active** since 2026-04-17 (non-root `assistant` user)
- No unexpected crashes in current session
- `bun run typecheck`: **0 errors**
- `journalctl` AbortError / crash-pattern matches in 7-day window: **40** — all are operator-initiated restarts, not crashes (see note-20260422-001)
- Bun runtime: **1.3.12**, `@anthropic-ai/claude-agent-sdk` **0.1.76**
- `permissionMode`: **default** (was `dontAsk` pre-fix), `settingSources` includes `local`

## Features verified across 7-week window

- Voice input via OpenAI Whisper — working
- MarkdownV2 + HTML streaming — working
- Multi-session `/new` and `/resume` — working
- Session persistence across bot restarts — `tryAutoResume` confirmed
- Inline permission keyboards (Allow/Deny via `canUseTool`) — working
- AskUserQuestion routing (inline keyboard, `askq:` namespace) — working (rendering verified; multi-question array handles first only)
- Media handling — photos, PDFs via content blocks (dec-20260420-001)
- Message queuing — grammY runner + `sequentialize` active
- Rate limiting — enabled
- Mode-2 remote coding sessions — added 2026-04-23 (dec-20260422-003), full lifecycle verified (spawn / attach / close / reaper / boot-resume)
- Permission allowlist — static allowlist model (dec-20260420-003), accepted 2026-04-21 (208 auto-approvals / 0 file-op prompts on 133-file migration)
- Session fixes — AbortError crash paths + kill()/segment_end (dec-20260422-001) shipped 2026-04-22

## Test suite

- 33 tests passing across permission store (×6), path validation (×8), command safety (×7), allowlist integration (×12)
- `bun run typecheck`: 0 errors

## Rollback path verified

Plugin re-enable steps documented (restore `settings.local.json`, restart tmux, verify plugin bridge). Target: restore within 5 minutes.

## Known gaps (verdict remains partial)

- 2-week zero-drop-message stability run **not formally observed**
- Whisper cost against **$10/mo budget not measured** (OpenAI usage dashboard not checked)
- AskUserQuestion: multi-question arrays handle first only; **multiSelect** and free-form **Other** fallback not implemented
- Prior waivers: 2026-04-17 extended to 2026-07-16 ("bot live, no fresh measurement needed"); 2026-04-21 extended to 2026-10-16 after allowlist + session-continuity improvements — stale evidence window, not operational degradation

## Claims bound

- "No messages dropped under normal single-user load after bot restart" — partial: no observed drops in 5-day operation window, not a formal 2-week run ⚠
- "Voice transcription cost stays within budget" — unmeasured ⚠
- "Bot survives VM reboot without manual intervention" — confirmed via Phase B re-verification, systemd auto-start on boot ✓

## Why verdict = partial, not accepted

All structural post-conditions are met and the bot is stable under daily use. The three evidence-gated predictions have **not** been closed out (stability window, Whisper cost, resume-across-reboot formal test). Graduating past `partial` requires completing those observations, not re-framing the criteria.
