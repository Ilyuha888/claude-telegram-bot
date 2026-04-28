---
id: note-20260428-2caddebe
kind: Note
version: 1
status: active
title: Code-fence boundary fix in sendChunkedMessages
context: bot
mode: note
valid_until: 2026-07-27T11:43:05Z
created_at: 2026-04-28T11:43:05Z
updated_at: 2026-04-28T11:43:05Z
---

# Code-fence boundary fix in sendChunkedMessages

## Rationale

The original HTML-tag split bug (splitting pre-built HTML at character offsets) was fixed by commits 872b400 and 98377d1 on 2026-04-24 — both committed same day the prob card was filed. The remaining edge case was code blocks > 3500 chars: sendChunkedMessages would split at a \n inside a code fence, leaving chunks with unclosed ``` that convertMarkdownToHtml can't match, so code rendered as plain text. Fixed by adding getUnclosedFence() which walks fence lines and detects unclosed blocks; sendChunkedMessages now closes any open fence at the end of a chunk and reopens it at the start of the next. prob-20260424-1009a021 closed.

## Affected Files

- `src/handlers/streaming.ts`
