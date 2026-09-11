/**
 * Rich Messages support for Claude Telegram Bot (Telegram Bot API 10.1/10.2).
 *
 * Pure, self-contained module: `shouldUseRichMessage()` (the router),
 * `convertToRichMarkdown()` + `exceedsRichMessageLimits()` (the renderer and
 * its size gate), and `RichStreamController` (the streaming core). No I/O,
 * no dependency on the live bot — see the plan file
 * `~/.claude/plans/imperative-floating-wand.md` for the full design and the
 * confirmed wire schema this is built against.
 *
 * This is deliberately near-passthrough, not an AST-based Markdown parser:
 * Claude's output is already valid GFM, so a handful of regex-based surgical
 * fixes (thinking-tag rewrite, stray-HTML escaping, nesting/size ceilings)
 * are enough — pulling in remark/unified would be a heavy dependency for a
 * problem this narrow.
 *
 * Distinct from, and does not share code with, `src/formatting.ts`'s
 * `convertMarkdownToHtml()` — that pipeline lossily converts Markdown down
 * to Telegram's restricted plain-HTML subset for `sendMessage`; this one
 * targets Rich Markdown for `sendRichMessage`/`sendRichMessageDraft`, which
 * is a GFM superset that needs the opposite treatment (preserve almost
 * everything, escape only what's dangerous).
 */

import type { Api } from "grammy";
import type { Message } from "grammy/types";
import type { MessageWithRichMessage, RichMessageRawApi } from "./rich-api";

// ============== Router ==============

// Mirrors config.ts's TELEGRAM_MESSAGE_LIMIT (4096) — Telegram's plain
// sendMessage cap. Duplicated rather than imported: this module is pure and
// config-agnostic by design (a later phase gates callers on
// RICH_MESSAGES_ENABLED before they even reach this function; that flag
// intentionally does not exist here).
const PLAIN_MESSAGE_LIMIT = 4096;

const HEADING_RE = /^#{1,6}\s+.+$/gm;
const LANGUAGE_FENCE_RE = /```(\w+)/;
const MATH_BLOCK_FENCE_RE = /```math\b/;
const MATH_DISPLAY_RE = /\$\$[\s\S]+?\$\$/;
// Inline math: a '$...$' span that contains at least one LaTeX-only character
// (backslash command, sup/subscript, or brace). That guard is what keeps
// ordinary currency prose — "costs $5 and $10" — from being classified as
// math; see MATH_SPAN_RE for the renderer half of the same rule.
const MATH_INLINE_RE = /(?<!\$)\$(?!\$)[^\n$]*[\\^_{}][^\n$]*\$(?!\$)/;

/**
 * True if a header row (any line containing '|') is immediately followed by
 * a GFM separator row (a line of only '|', ':', '-' and whitespace, with at
 * least one '-'), e.g.:
 *   | A | B |
 *   |---|:---:|
 */
function hasGfmTable(content: string): boolean {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    const header = lines[i]!.trim();
    const separator = lines[i + 1]!.trim();
    if (!header.includes("|")) continue;
    if (isGfmSeparatorRow(separator)) return true;
  }
  return false;
}

function isGfmSeparatorRow(line: string): boolean {
  if (!line.includes("-")) return false;
  // A separator row with no '|' at all is a horizontal rule ("---"), not a
  // table separator — without this guard any prose line containing a pipe
  // followed by a '---' rule was misread as a table.
  if (!line.includes("|")) return false;
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(line);
}

function countHeadings(content: string): number {
  return (content.match(HEADING_RE) || []).length;
}

function hasLanguageCodeFence(content: string): boolean {
  return LANGUAGE_FENCE_RE.test(content);
}

function hasMath(content: string): boolean {
  return (
    MATH_BLOCK_FENCE_RE.test(content) ||
    MATH_DISPLAY_RE.test(content) ||
    MATH_INLINE_RE.test(content)
  );
}

/**
 * Router deciding rich vs. plain path. Ordered checks, first match wins.
 * Errs toward the plain path (returns false) when nothing matches.
 *
 * Does NOT check a `RICH_MESSAGES_ENABLED`-style flag — that lives in
 * config.ts (a later phase) and callers must short-circuit on it themselves
 * before calling this function, to keep this module pure/config-agnostic.
 */
export function shouldUseRichMessage(content: string): boolean {
  if (content.length > PLAIN_MESSAGE_LIMIT) return true;
  if (hasGfmTable(content)) return true;
  if (countHeadings(content) >= 2) return true;
  if (hasLanguageCodeFence(content)) return true;
  if (hasMath(content)) return true;
  return false;
}

// ============== Renderer ==============

// Soft ceilings from the Bot API docs (32,768 chars / 500 blocks / 16
// nesting levels). Exported so callers (and tests) don't have to hardcode
// the same numbers.
export const RICH_MESSAGE_CHAR_LIMIT = 32_768;
export const RICH_MESSAGE_BLOCK_LIMIT = 500;
export const RICH_MESSAGE_MAX_NESTING = 16;

// Assumed spaces-per-nesting-level for list indentation (GFM convention).
// This is a heuristic, not a spec requirement — Markdown renderers disagree
// on 2 vs. 4 space indents; 2 is the more common convention for tight lists.
const LIST_INDENT_UNIT = 2;

const THINKING_RE = /<thinking>([\s\S]*?)<\/thinking>/gi;
// Fenced code blocks are stashed whole (including the opening ```lang line)
// so the language tag and body both survive untouched.
const FENCED_CODE_RE = /```[\s\S]*?```/g;
// Inline code spans, run only after fenced blocks are stashed (so a lone
// backtick from a fence marker can't be mistaken for one). The delimiter is a
// run of N backticks closed by a run of exactly N (CommonMark rule), so
// double-backtick spans (``code``) round-trip exactly instead of being
// re-emitted as a single-backtick span.
const INLINE_CODE_RE = /(`+)[^\n]*?\1/g;

/**
 * Math spans preserved verbatim: display math ($$..$$) and inline math whose
 * body contains at least one LaTeX-only character (\ ^ _ { }).
 *
 * Everything else that looks like '$' is currency or a cashtag, not a formula.
 * Rich Markdown parses '$..$' as inline LaTeX, so leaving bare '$' in prose
 * made "costs $5 and the addon costs $10" render as a formula. The renderer
 * therefore stashes real math, escapes every remaining '$' as '\$', then
 * restores the math untouched. Escaping unconditionally is not an option: it
 * would break legitimate math like $2^n$ (whose opening '$' is followed by a
 * digit, so a naive "escape $ before a digit" rule corrupts it).
 */
const MATH_SPAN_RE = /\$\$[\s\S]+?\$\$|\$(?!\$)[^\n$]*[\\^_{}][^\n$]*\$(?!\$)/g;

/**
 * Escape stray literal '<', '>', '&' — the same class of risk
 * `formatting.ts`'s `escapeHtml` manages, but deliberately narrower: Rich
 * Markdown text is not an HTML attribute context, so quotes don't need
 * escaping here (unlike `formatting.ts`'s helper), and none of Rich
 * Markdown's own syntax characters (*_`#|$[]) are touched.
 */
function escapeStray(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Per-line nesting flatten + stray-HTML escape.
 *
 * Nesting heuristic (soft, best-effort — not a hard guarantee of staying
 * under 16 levels for pathological input): blockquote nesting is measured
 * by counting leading '>' markers; list nesting by leading-space count /
 * LIST_INDENT_UNIT. Lines nested deeper than RICH_MESSAGE_MAX_NESTING are
 * dedented down to exactly that depth. This intentionally does not attempt
 * a full block-tree parse (mixed blockquote-inside-list-inside-blockquote
 * nesting isn't modeled) — it's a safety valve against runaway indentation,
 * not a correctness guarantee.
 *
 * Blockquote '>' markers are structural Rich Markdown syntax, so they're
 * excluded from the stray-HTML escape (only the text after the marker
 * prefix is escaped) — otherwise every blockquote in the message would be
 * corrupted into "&gt; quoted text".
 */
function processLine(line: string, maxLevels: number): string {
  const bqMatch = line.match(/^(\s*(?:>[ \t]*)+)/);
  if (bqMatch) {
    let prefix = bqMatch[1]!;
    const rest = line.slice(prefix.length);
    const level = (prefix.match(/>/g) || []).length;
    if (level > maxLevels) {
      const leadingWs = prefix.match(/^\s*/)![0];
      prefix = leadingWs + "> ".repeat(maxLevels);
    }
    return prefix + escapeStray(rest);
  }

  const listMatch = line.match(/^( +)(?:[-*+]|\d+[.)])(?:\s|$)/);
  if (listMatch) {
    const indent = listMatch[1]!;
    const level = Math.floor(indent.length / LIST_INDENT_UNIT);
    if (level > maxLevels) {
      const clippedIndent = " ".repeat(maxLevels * LIST_INDENT_UNIT);
      return escapeStray(clippedIndent + line.slice(indent.length));
    }
  }

  return escapeStray(line);
}

/**
 * Replace a stashed placeholder with its original content, without
 * `String.replace`'s special `$`-pattern handling kicking in (code/math
 * content routinely contains literal `$` sequences that would otherwise be
 * misread as replacement patterns like `$&`/`$1`).
 */
function restorePlaceholder(text: string, token: string, original: string): string {
  return text.replace(token, () => original);
}

/**
 * Renders Claude's output into the `markdown` field of an InputRichMessage.
 *
 * - `forDraft: true` (streaming preview, `sendRichMessageDraft`): rewrites
 *   `<thinking>...</thinking>` into the literal `<tg-thinking>...</tg-thinking>`
 *   tag, which is valid ONLY in draft messages.
 * - `forDraft: false` or omitted (finalize, `sendRichMessage`): strips
 *   `<thinking>...</thinking>` entirely — `<tg-thinking>` "can't be received
 *   in messages" per the Bot API docs, and there's no other Rich-Markdown
 *   construct worth preserving Claude's raw thinking prose as in the
 *   persisted message.
 *
 * Code fences and inline code spans pass through byte-for-byte (including
 * any literal <, >, & inside them); stray <, >, & in surrounding prose are
 * HTML-escaped. Markdown syntax characters (*_`#|$[] etc.) are never
 * touched. Nesting deeper than 16 levels is flattened (see `processLine`).
 *
 * Does NOT enforce the 32k-char/500-block ceiling — see
 * `exceedsRichMessageLimits()`, which callers should check separately so
 * this function stays a pure string -> string transform.
 */
export function convertToRichMarkdown(
  content: string,
  opts: { forDraft?: boolean } = {}
): string {
  const forDraft = opts.forDraft ?? false;
  // Strip NULs up front. They have no legitimate place in a Telegram message,
  // and \x00 is the sentinel this function's stash placeholders are built
  // from — input containing a literal "\x00CODEBLOCK0\x00" would otherwise
  // collide with the placeholder namespace and scramble which code block
  // lands where.
  let text = content.replace(/\x00/g, "");

  // 1. Thinking blocks. Handled first (mirroring formatting.ts's
  //    convertMarkdownToHtml, which also processes <thinking> before code
  //    blocks) — an accepted edge case is that any code fence nested inside
  //    a <thinking> block is treated as part of that reasoning prose rather
  //    than protected code, since Claude's <thinking> content is prose, not
  //    literal tool/code output.
  const thinkingBlocks: string[] = [];
  if (forDraft) {
    text = text.replace(THINKING_RE, (_match, inner: string) => {
      const escapedInner = escapeStray(inner.trim());
      thinkingBlocks.push(`<tg-thinking>${escapedInner}</tg-thinking>`);
      return `\x00THINKING${thinkingBlocks.length - 1}\x00`;
    });
  } else {
    text = text.replace(THINKING_RE, "");
  }

  // 2. Stash fenced code blocks and inline code spans verbatim before any
  //    escaping touches the rest of the text.
  const codeBlocks: string[] = [];
  text = text.replace(FENCED_CODE_RE, (match) => {
    codeBlocks.push(match);
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
  });

  // Stash the whole match (delimiters included) so the span round-trips
  // byte-for-byte rather than being rebuilt with an assumed backtick count.
  const inlineCodes: string[] = [];
  text = text.replace(INLINE_CODE_RE, (match) => {
    inlineCodes.push(match);
    return `\x00INLINECODE${inlineCodes.length - 1}\x00`;
  });

  // 3. Protect real math, then escape every other '$' so currency in prose
  //    isn't parsed as a formula (see MATH_SPAN_RE).
  const mathSpans: string[] = [];
  text = text.replace(MATH_SPAN_RE, (match) => {
    mathSpans.push(match);
    return `\x00MATH${mathSpans.length - 1}\x00`;
  });
  text = text.replace(/\$/g, "\\$");

  // 4. Flatten excess nesting and escape stray HTML in whatever prose
  //    remains — code, math and thinking content are already protected as
  //    opaque placeholders above, so this pass can't touch them.
  text = text
    .split("\n")
    .map((line) => processLine(line, RICH_MESSAGE_MAX_NESTING))
    .join("\n");

  // 5. Restore math and code verbatim (no escaping).
  for (let i = 0; i < mathSpans.length; i++) {
    text = restorePlaceholder(text, `\x00MATH${i}\x00`, mathSpans[i]!);
  }
  for (let i = 0; i < inlineCodes.length; i++) {
    text = restorePlaceholder(text, `\x00INLINECODE${i}\x00`, inlineCodes[i]!);
  }
  for (let i = 0; i < codeBlocks.length; i++) {
    text = restorePlaceholder(text, `\x00CODEBLOCK${i}\x00`, codeBlocks[i]!);
  }

  // 6. Restore thinking placeholders (draft path only; finalize already
  //    removed the tag content in step 1 and stashed nothing).
  for (let i = 0; i < thinkingBlocks.length; i++) {
    text = restorePlaceholder(text, `\x00THINKING${i}\x00`, thinkingBlocks[i]!);
  }

  return text;
}

/**
 * Rough block-count heuristic: counts paragraphs (a run of non-blank lines
 * that isn't a heading/list-item/table-row/blockquote/details/fence),
 * headings, list items, table rows, blockquote groups (a run of consecutive
 * '>' lines counts as one block, matching how Telegram nests a blockquote
 * as a single block), fenced code blocks (one block regardless of internal
 * line count), and `<details>` blocks. Not an exact parser — deliberately
 * conservative in the sense that it's a best-effort estimate, not a
 * guarantee of matching Telegram's own block count exactly.
 */
function countBlocks(content: string): number {
  const withoutFences = content.replace(FENCED_CODE_RE, "\x00FENCE\x00");
  const lines = withoutFences.split("\n");

  let blocks = 0;
  let inParagraph = false;
  let inBlockquoteGroup = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "") {
      inParagraph = false;
      inBlockquoteGroup = false;
      continue;
    }

    if (trimmed === "\x00FENCE\x00") {
      blocks += 1;
      inParagraph = false;
      inBlockquoteGroup = false;
      continue;
    }

    if (/^#{1,6}\s+/.test(trimmed)) {
      blocks += 1;
      inParagraph = false;
      inBlockquoteGroup = false;
      continue;
    }

    if (/^(?:[-*+]|\d+[.)])\s+/.test(trimmed)) {
      blocks += 1;
      inParagraph = false;
      inBlockquoteGroup = false;
      continue;
    }

    // Blockquote before the table check: a quoted table row ("> | a | b |")
    // belongs to the surrounding blockquote group, and counting it as its own
    // table row inflated the block count (and so could force needless
    // chunking).
    if (trimmed.startsWith(">")) {
      if (!inBlockquoteGroup) {
        blocks += 1;
        inBlockquoteGroup = true;
      }
      inParagraph = false;
      continue;
    }

    if (trimmed.includes("|")) {
      blocks += 1;
      inParagraph = false;
      inBlockquoteGroup = false;
      continue;
    }

    inBlockquoteGroup = false;

    if (/^<details/i.test(trimmed)) {
      blocks += 1;
      inParagraph = false;
      continue;
    }

    if (!inParagraph) {
      blocks += 1;
      inParagraph = true;
    }
  }

  return blocks;
}

/**
 * Size gate for the 32,768-char / 500-block Rich Message ceilings.
 * `convertToRichMarkdown` stays a pure string -> string transform (it never
 * truncates); callers must check this separately — on oversized content,
 * the appropriate response is chunking into multiple Rich Messages, which
 * only the caller (a later phase's streaming.ts) can orchestrate.
 */
export function exceedsRichMessageLimits(content: string): boolean {
  if (content.length > RICH_MESSAGE_CHAR_LIMIT) return true;
  if (countBlocks(content) > RICH_MESSAGE_BLOCK_LIMIT) return true;
  return false;
}

/**
 * Split oversized content into the largest pieces that each clear
 * `exceedsRichMessageLimits`, so a long answer goes out as a run of Rich
 * Messages instead of collapsing to the 4096-char plain chunker.
 *
 * Two structures have to survive a boundary or the continuation piece renders
 * as literal text:
 *   - a fenced code block is closed at the end of the piece and reopened with
 *     the same info string at the start of the next (the trick the plain
 *     chunker already uses), and
 *   - a GFM table has its header and separator rows repeated, because
 *     `hasGfmTable` needs *both* to recognise the continuation as a table at
 *     all. Without this the second half of a split table arrives as raw pipes.
 *
 * Returns `[content]` untouched when it already fits, so callers can treat the
 * single- and multi-piece cases uniformly.
 */
export function splitForRichMessages(content: string): string[] {
  if (!exceedsRichMessageLimits(content)) return [content];

  const pieces: string[] = [];
  let buf: string[] = [];
  let chars = 0;
  // Blocks are bounded above by the non-blank line count (countBlocks adds at
  // most 1 per line), so the expensive exact count is only consulted once that
  // cheap upper bound crosses the ceiling.
  let nonBlank = 0;
  let openFence: string | null = null;
  let tableHead: [string, string] | null = null;

  const flush = (): void => {
    if (buf.length === 0) return;
    const closing = openFence !== null ? "\n```" : "";
    pieces.push(buf.join("\n") + closing);

    // Reopen whatever structure the cut landed inside of.
    buf = openFence !== null ? [openFence] : tableHead ? [...tableHead] : [];
    chars = buf.reduce((n, l) => n + l.length + 1, 0);
    nonBlank = buf.length;
  };

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;

    // A single line past the ceiling can't be split on a boundary — cut it on
    // characters, or it would sit in the buffer forever and overflow.
    while (line.length > RICH_MESSAGE_CHAR_LIMIT - 16) {
      flush();
      const room = RICH_MESSAGE_CHAR_LIMIT - 16 - chars;
      buf.push(line.slice(0, room));
      line = line.slice(room);
      flush();
    }

    const isBlank = line.trim() === "";
    const projected = chars + line.length + 1 + (openFence !== null ? 4 : 0);
    const mustCount = nonBlank + (isBlank ? 0 : 1) > RICH_MESSAGE_BLOCK_LIMIT;
    const overflows =
      projected > RICH_MESSAGE_CHAR_LIMIT ||
      (mustCount && countBlocks([...buf, line].join("\n")) > RICH_MESSAGE_BLOCK_LIMIT);

    if (overflows && buf.length > 0) flush();

    buf.push(line);
    chars += line.length + 1;
    if (!isBlank) nonBlank++;

    // Structure tracking, after the push so `flush()` above saw the state that
    // applied to the lines already in the buffer.
    const fence = line.match(/^\s*```(\S*)/);
    if (fence) {
      openFence = openFence === null ? "```" + (fence[1] ?? "") : null;
      tableHead = null;
      continue;
    }
    if (openFence !== null) continue;

    if (isBlank) {
      tableHead = null;
    } else if (
      tableHead === null &&
      line.includes("|") &&
      i + 1 < lines.length &&
      isGfmSeparatorRow(lines[i + 1]!.trim())
    ) {
      tableHead = [line, lines[i + 1]!];
    } else if (!line.includes("|")) {
      tableHead = null;
    }
  }

  if (buf.some((l) => l.trim() !== "")) flush();
  return pieces;
}

// ============== Streaming controller ==============

// Matches STREAMING_THROTTLE_MS in src/config.ts. Duplicated rather than
// imported to keep this module free of a config.ts dependency; callers that
// want the two values to stay in lockstep should pass STREAMING_THROTTLE_MS
// explicitly into the constructor.
const DEFAULT_THROTTLE_MS = 500;

// Telegram draft messages are hard-ephemeral at ~30s. 25s is the "finalize
// and restart" signal exposed via isApproachingExpiry(), leaving margin for
// the caller's own finalize round-trip before the 30s wall.
const DRAFT_EXPIRY_WARNING_MS = 25_000;

// ============== Read side ==============

/**
 * The plain text of a message that arrived as a Rich Message, or undefined for
 * anything else.
 *
 * The read-side counterpart to everything above: this module's job is to turn
 * Claude's Markdown into Rich Messages, and the consequence nobody wired up was
 * that the bot then could not read its own output back. An incoming Rich
 * Message leaves `Message.text` unset and carries its content in
 * `rich_message.text` instead, so `msg.text ?? msg.caption` — the idiom used
 * everywhere for "what did the user send" — evaluates to nothing for a reply to
 * or forward of any answer long or structured enough to have gone out rich.
 *
 * Takes `unknown` deliberately: callers hold a `Message`, a
 * `reply_to_message`, or an `external_reply`, and none of them are typed with
 * the field. The cast is contained here rather than repeated at each site,
 * mirroring `richRawApi()` on the send side.
 */
export function incomingRichText(msg: unknown): string | undefined {
  const rich = (msg as MessageWithRichMessage | null | undefined)?.rich_message;
  if (!rich || typeof rich !== "object") return undefined;

  // Flat forms first. NOT observed on the wire — kept because they cost two
  // lines and a future API version adding one shouldn't silently fall through
  // to the block walk. The block form below is the one that actually happens.
  for (const flat of [rich.text, rich.markdown, rich.html]) {
    if (typeof flat === "string" && flat.trim().length > 0) return flat;
  }

  if (!Array.isArray(rich.blocks)) return undefined;

  const parts: string[] = [];
  for (const block of rich.blocks) {
    if (!block || typeof block !== "object") continue;
    const { type, text } = block as { type?: unknown; text?: unknown };
    const body = flattenRichText(text).trim();
    if (body === "") continue; // dividers and other bodiless blocks
    // Fencing `pre` preserves the one distinction that changes how the quoted
    // text should be read — this string ends up inside a prompt, and code that
    // arrives as prose invites the model to "fix" its formatting.
    parts.push(type === "pre" ? `\`\`\`\n${body}\n\`\`\`` : body);
  }

  const joined = parts.join("\n\n").trim();
  return joined.length > 0 ? joined : undefined;
}

/**
 * A block's `text` reduced to a string.
 *
 * Written permissively on purpose: the observed payload has a plain string here,
 * but `RichMessage` also references a `RichText` type, so a nested
 * `{text: …}` / array-of-runs form is plausible for styled blocks that this
 * bot's own output happens not to produce. Guessing wrong is what cost three
 * restarts already; handling both shapes costs six lines.
 */
function flattenRichText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenRichText).join("");
  if (value && typeof value === "object") {
    const o = value as { text?: unknown };
    if (o.text !== undefined) return flattenRichText(o.text);
  }
  return "";
}

/** True if this message carries Rich Message content instead of plain `text`. */
export function isRichMessage(msg: unknown): boolean {
  return incomingRichText(msg) !== undefined;
}

// ============== Send side ==============

/**
 * Casts `api.raw` to the locally-declared Rich Message method shapes (see
 * `src/rich-api.d.ts` for why this is a cast-based wrapper rather than
 * declaration merging).
 */
function richRawApi(api: Api): RichMessageRawApi {
  return api.raw as unknown as RichMessageRawApi;
}

/**
 * `{ message_thread_id }`, or nothing at all.
 *
 * Absent rather than explicitly undefined because these objects are spread
 * straight into the wire payload. Mirrors `threadOpts` in src/conversation.ts;
 * kept local so this module stays free of bot-side imports.
 *
 * Unlike `ctx.reply`, the raw rich methods have no auto-threading to inherit —
 * a forum-topic destination that doesn't carry this ends up in General, with no
 * error and nothing logged.
 */
function threadParam(threadId?: number): { message_thread_id?: number } {
  return threadId === undefined ? {} : { message_thread_id: threadId };
}

/**
 * Send one already-sized piece of content as a standalone Rich Message.
 *
 * `RichStreamController.finalize` covers the first piece of a segment (it owns
 * the draft that has to be replaced); the continuation pieces produced by
 * `splitForRichMessages` have no draft behind them and just need sending, so
 * they go through here rather than through a throwaway controller each.
 */
export async function sendRichMessageChunk(
  api: Api,
  chatId: number,
  content: string,
  threadId?: number
): Promise<Message> {
  const markdown = convertToRichMarkdown(content, { forDraft: false });
  return richRawApi(api).sendRichMessage({
    chat_id: chatId,
    rich_message: { markdown },
    ...threadParam(threadId),
  });
}

/**
 * Draft ids are drawn from one process-wide counter rather than per-controller,
 * so no two controllers can ever pick the same id. Telegram animates changes to
 * drafts sharing an id, so a collision would make one segment's live preview
 * appear to rewrite another's. Today's event order (a segment is finalized
 * before the next one streams) happens to avoid that, but this removes the
 * dependency on that ordering. Starts at 1 — the id must be non-zero.
 */
let nextDraftId = 0;

/**
 * Streaming core for Rich Messages: drives `sendRichMessageDraft` during
 * generation and `sendRichMessage` to finalize. Driven from
 * `createStatusCallback` in `src/handlers/streaming.ts`.
 */
export class RichStreamController {
  private draftId = 0;
  private lastDraftSentAt = 0;
  private segmentStartedAt = 0;
  finalized = false;

  constructor(
    private readonly chatId: number,
    private readonly api: Api,
    private readonly throttleMs: number = DEFAULT_THROTTLE_MS,
    /**
     * Forum topic to deliver into. Optional and last so existing call sites
     * are unaffected; omitted means the chat's General topic / a non-forum
     * chat, which is what every DM is.
     */
    private readonly threadId?: number
  ) {
    this.startSegment();
  }

  /**
   * Begin a new logical segment: bumps the monotonic nonzero draft id (a
   * fresh id signals a new draft to Telegram; reusing the same id across
   * `updateDraft` calls within one segment is what makes Telegram animate
   * the transition between draft versions) and resets throttle/expiry
   * bookkeeping.
   */
  startSegment(): void {
    nextDraftId += 1;
    this.draftId = nextDraftId;
    this.lastDraftSentAt = 0;
    this.segmentStartedAt = 0;
    this.finalized = false;
  }

  /**
   * Push a throttled draft update (respects `throttleMs`, silently no-ops
   * if called again inside the throttle window — mirrors the throttle
   * behaviour in `createStatusCallback`). Builds Rich Markdown with
   * `forDraft: true`; if `thinkingContent` is provided, prepends it as a
   * `<tg-thinking>` block.
   */
  async updateDraft(content: string, thinkingContent?: string): Promise<void> {
    const now = Date.now();
    if (this.lastDraftSentAt !== 0 && now - this.lastDraftSentAt < this.throttleMs) {
      return;
    }

    let markdown = convertToRichMarkdown(content, { forDraft: true });
    if (thinkingContent && thinkingContent.trim().length > 0) {
      const escapedThinking = escapeStray(thinkingContent.trim());
      markdown = `<tg-thinking>${escapedThinking}</tg-thinking>\n\n${markdown}`;
    }

    await richRawApi(this.api).sendRichMessageDraft({
      chat_id: this.chatId,
      draft_id: this.draftId,
      rich_message: { markdown },
      ...threadParam(this.threadId),
    });

    if (this.segmentStartedAt === 0) {
      this.segmentStartedAt = now;
    }
    this.lastDraftSentAt = now;
  }

  /**
   * Finalize the current segment: converts with `forDraft: false`
   * (stripping `<thinking>`) and calls `sendRichMessage`. Returns the sent
   * Message (its message_id is useful for later deletion on error/`/stop`,
   * mirroring how `StreamingState` tracks `Message` objects today).
   */
  async finalize(content: string): Promise<Message> {
    // Guarded, not just flagged: a caller can't atomically check `finalized`
    // and call across an await, so an expiry-driven finalize racing a
    // segment_end-driven one would otherwise send the user two copies of the
    // same answer. Throwing surfaces the caller bug instead of swallowing it.
    // Note the flag is only set after a SUCCESSFUL send, so a transient API
    // failure still leaves the segment retryable.
    if (this.finalized) {
      throw new Error(
        "RichStreamController: segment already finalized (call startSegment() first)"
      );
    }
    const markdown = convertToRichMarkdown(content, { forDraft: false });
    const message = await richRawApi(this.api).sendRichMessage({
      chat_id: this.chatId,
      rich_message: { markdown },
      ...threadParam(this.threadId),
    });
    this.finalized = true;
    return message;
  }

  /**
   * Best-effort cleanup. The Bot API documents no explicit "cancel a draft"
   * call — an unfinalized draft simply expires client-side after ~30s. This
   * just marks local state so callers know the segment is dead.
   */
  async abort(): Promise<void> {
    this.finalized = true;
  }

  /**
   * True once the current segment's first draft is more than ~25s old.
   * Callers (a later phase) should treat this as "finalize now with the
   * full current content, then startSegment() and resume streaming" rather
   * than expecting this controller to finalize on its own — finalizing
   * needs the complete current text, which only the caller
   * (`streaming.ts`'s accumulated segment content) holds.
   */
  isApproachingExpiry(): boolean {
    if (this.segmentStartedAt === 0) return false;
    return Date.now() - this.segmentStartedAt > DRAFT_EXPIRY_WARNING_MS;
  }
}
