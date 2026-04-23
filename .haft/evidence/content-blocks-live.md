---
id: evid-20260423-content-blocks-live
kind: EvidencePack
version: 1
status: active
title: SDK content blocks — PDF + image live pilot — 2026-04-20
created_at: 2026-04-23T13:00:10Z
updated_at: 2026-04-23T13:00:10Z
links:
  - ref: dec-20260420-001
    type: supports
---

# SDK content blocks — PDF + image live pilot — 2026-04-20

## Source

Live pilot on @ianartov_personal_assistant_bot after the SDK-content-blocks rollout deployed 2026-04-20. Replaces the pdftotext + Read-tool round-trip with Anthropic-native document and image content blocks inlined into the `query()` prompt.

## Measurements

- `bun run typecheck`: **0 errors**
- Service uptime since deploy: **stable since 2026-04-20T11:30Z**
- Album-image handling: **N content blocks in one SDKUserMessage** (verified on Telegram album input)
- PDF processing: **no pdftotext invocation observed**, no "File does not exist" error after deploy
- Image handling: **base64 JPEG per photo**, each becomes a discrete image content block

## Claims bound

- "PDF sent via Telegram is summarized correctly" — previously-failing PDF `Analyst_Ilya_Nartov (1).pdf` (2026-04-18 repro) now summarizes via Anthropic document pipeline ✓
- "Image sent via Telegram described accurately without hallucination" — post-deploy images returned accurate descriptions; no fabricated content observed ✓
- "Voice and text flows unchanged (string-prompt path preserved)" — string-prompt branch untouched; voice/text flows confirmed operational post-deploy ✓

## Known gaps

- Media-group PDFs still fall back to `pdftotext` in the edge path (poppler-utils not installed on VM). Rare case, untested.
- `canUseTool` permission-keyboard flow during `isSingleUserTurn=false` content-block sessions not explicitly stress-tested.
