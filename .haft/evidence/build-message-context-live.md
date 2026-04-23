---
id: evid-20260423-build-message-context-live
kind: EvidencePack
version: 1
status: active
title: buildMessageContext — 5 UX scenarios live — 2026-04-20
created_at: 2026-04-23T13:00:20Z
updated_at: 2026-04-23T13:00:20Z
links:
  - ref: dec-20260420-002
    type: supports
---

# buildMessageContext — 5 UX scenarios live — 2026-04-20

## Source

Live verification after `buildMessageContext(ctx)` helper deployed across text, photo, document, and media-group handlers (src/handlers/text.ts, src/utils.ts).

## Scenarios verified

1. **Forward** — `forward_origin` prepended for text and photo messages as `[Forwarded from ...]` line ✓
2. **Edit** — `edited_message` updates silently dropped (no handler registered; policy from note-20260420-006) ✓
3. **Rapid succession** — grammY `sequentialize` middleware serializes message handling; behaviour unchanged ✓
4. **Reply-to** — `reply_to_message` source text prepended as `[Replying to: "..."]`, truncated to ≤500 chars ✓
5. **Quote** — `message.quote` fragment prepended as `[Quoting: "..."]` plain text fragment (no position/entities in v1) ✓

## Measurements

- `tsc --noEmit`: **clean**
- `systemctl is-active claude-telegram-bot.service`: **active**
- Handler coverage: **4 handlers updated** (text, photo, document, media-group)
- Document handler call sites replaced: **4 of 4** (all caption sites)
- Media-group buffer: enriched context stored on first item and update — verified in utils.ts
- Photo handler: `buildMessageContext` replaces `ctx.message?.caption` — verified in source

## Claims bound

- "Enriched prompt fits within ~1.5x plain-text prompt size on typical reply-to" — truncation to ≤500 chars bounds overhead ✓
- "Plain text path unchanged" — no-metadata messages produce byte-identical output to prior behaviour ✓
- "buildMessageContext covers all four handler types" — text/photo/document/media-group verified ✓

## Note

No free-form `Other` input and no multi-select fallback are implemented — out of scope for v1 (see admissibility in dec-20260420-002).
