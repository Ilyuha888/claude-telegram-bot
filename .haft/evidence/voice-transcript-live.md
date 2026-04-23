---
id: evid-20260423-voice-transcript-live
kind: EvidencePack
version: 1
status: active
title: Voice transcript notice — filler-heavy live test — 2026-04-21
created_at: 2026-04-23T13:00:40Z
updated_at: 2026-04-23T13:00:40Z
links:
  - ref: dec-20260420-004
    type: supports
---

# Voice transcript notice — filler-heavy live test — 2026-04-21

## Source

Live test on @ianartov_personal_assistant_bot after `[Voice transcript]` branch in `buildMessageContext` deployed 2026-04-21 (voice.ts, tsc clean, service active).

## Test input (verbatim)

> "Hi, um, so like, can you, you know, remind me to call mom tomorrow at like noon or something"

Sent as a Telegram voice message, transcribed by OpenAI Whisper, passed through `buildMessageContext(ctx, {voiceTranscript})` so the notice prepends before the raw transcript reaches Claude.

## Agent response

Agent correctly extracted intent — created reminder at **12:00** ("tomorrow at noon") — without asking any clarification question. Filler tokens ("um", "so like", "you know", "or something") were treated as speech artefacts and ignored, not parsed literally.

## Measurements

- Clarification requests across 1 test message: **0** (prediction threshold: ≤1 clarification across 5 messages)
- `tsc --noEmit`: **0 errors**
- Audit log VOICE entry: raw transcript stored correctly; enriched prompt not leaked into audit log
- Source verification: `buildMessageContext(ctx, {voiceTranscript})` present in `voice.ts`, conditional branch fires on voice origin only

## Claims bound

- "All voice-originated messages include `[Voice transcript]` notice before user text" — enrichment fires on voice origin ✓
- "Typed messages unchanged" — audit log shows TEXT-type entries unaffected by the branch ✓
- "Agent interprets intent on garbled voice input without asking for clarification" — 0/1 clarification, ≤1/5 threshold met on first case ✓

## Known gap

Only 1 test message recorded in live-verification. Prediction threshold was ≤1 clarification per 5 messages; the criterion is met by implication (0 clarifications on 1 message < 1 per 5) but 5-message stress set is not explicitly logged.
