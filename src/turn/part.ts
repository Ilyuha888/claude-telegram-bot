/**
 * The unit of user input, and the composition of N of them into one Claude turn.
 *
 * Pure by design: no grammY, no ClaudeSession, no I/O, no clock. Everything here
 * is unit-testable without a single mock, which matters because this file holds
 * the regression guarantee for the whole batching feature — a lone message must
 * reach Claude byte-for-byte as it did before batching existed. See composeTurn.
 */

import type { UserContentBlock } from "../session";

export type TurnPartKind =
  | "text"
  | "voice"
  | "audio"
  | "video"
  | "photo"
  | "pdf"
  | "doctext"
  | "archive";

/**
 * One Telegram message, prepared by its handler and ready to become (part of) a
 * Claude turn.
 *
 * `text` is the complete per-message prompt — it already carries that message's
 * own `buildMessageContext` headers (`[Forwarded from …]`, `[Replying to: …]`,
 * `[Attachments on disk: …]`). The composer treats those as opaque and never
 * parses or rewrites them; that is what keeps a forward header attached to the
 * message it belongs to when four forwards arrive at once.
 */
export interface TurnPart {
  kind: TurnPartKind;
  /** Arrival order, monotonic per process. The sort key for composition. */
  seq: number;
  /** Telegram message_id, for logs. */
  messageId?: number;
  /**
   * Set only for parts that arrived as one Telegram album.
   *
   * Gives this part a *floor* on the debounce window (see collector): album
   * coalescing is protocol handling — the client splits one user action into N
   * updates and the bot is never told how many — whereas burst batching is a
   * product decision. So albums must keep coalescing when batching is off.
   */
  mediaGroupId?: string;
  /** This message's complete prompt text. May be empty only if `media` is not. */
  text: string;
  /** Blocks that must immediately follow `text`. Empty for text-only kinds. */
  media: UserContentBlock[];
  /** Audit verb + one-line summary. Never base64. */
  audit: { kind: string; summary: string };
  /** Candidate `session.conversationTitle` if this part opens the session. */
  titleSeed: string;
  /** `session.lastMessage` for /retry. Text-only parts set it, as today. */
  lastMessageText?: string;
  /** Temp files to unlink once the turn is done. */
  cleanupPaths?: string[];
  /** Prompt weight, for the byte cap. Base64 media dominates. */
  bytes: number;
}

export interface ComposedTurn {
  content: string | UserContentBlock[];
  audit: { kind: string; summary: string };
  titleSeed: string;
  lastMessageText?: string;
  cleanupPaths: string[];
  partCount: number;
}

/** Human label for the `--- i/N (label) ---` delimiter. */
const PART_LABEL: Record<TurnPartKind, string> = {
  text: "text",
  voice: "voice message",
  audio: "audio",
  video: "video",
  photo: "photo",
  pdf: "PDF",
  doctext: "document",
  archive: "archive",
};

function preamble(n: number): string {
  return (
    `[The user sent ${n} messages in quick succession without waiting for a reply. ` +
    `They are ONE turn: read all of them, then answer once.]`
  );
}

function section(part: TurnPart, index: number, total: number): string {
  const header = `--- ${index + 1}/${total} (${PART_LABEL[part.kind]}) ---`;
  return part.text ? `${header}\n${part.text}` : header;
}

/**
 * Compose one Claude turn from the parts of a burst.
 *
 * Three properties this function exists to guarantee:
 *
 * 1. **A single text-only part returns its own `text` as a bare string.** Not a
 *    one-element block array. `sendMessageStreaming` has two input modes — a
 *    plain string (session.ts:538) and an `AsyncIterable<SDKUserMessage>` for
 *    blocks (session.ts:544) — so wrapping a lone text message in blocks would
 *    silently switch every text turn in the bot onto a different SDK path.
 *    Any future preamble belongs on the multi-part branch only.
 *
 * 2. **A batch with no media anywhere is still a string.** Forwarding five text
 *    messages is the headline case for this feature; there is no reason to drag
 *    it onto the blocks path. It also keeps `lastMessageText` (and therefore
 *    /retry) meaningful for exactly the batches that can be replayed.
 *
 * 3. **Media blocks immediately follow their own part's text block. Never
 *    regrouped.** Hoisting all text first and all media last is the tempting
 *    "tidier" layout and it silently destroys the caption↔image binding: the
 *    model can no longer tell which caption describes which photo. That failure
 *    produces confident wrong answers rather than errors, which is why it is
 *    called out here and asserted in tests/turn-compose.test.ts.
 */
export function composeTurn(parts: TurnPart[]): ComposedTurn {
  if (parts.length === 0) {
    throw new Error("composeTurn: refusing to compose an empty turn");
  }

  const ordered = [...parts].sort((a, b) => a.seq - b.seq);
  const cleanupPaths = ordered.flatMap((p) => p.cleanupPaths ?? []);
  const hasMedia = ordered.some((p) => p.media.length > 0);

  // ---- single part: identity ------------------------------------------------
  if (ordered.length === 1) {
    const p = ordered[0]!;
    return {
      content: hasMedia ? [{ type: "text", text: p.text }, ...p.media] : p.text,
      audit: p.audit,
      titleSeed: p.titleSeed,
      lastMessageText: p.lastMessageText,
      cleanupPaths,
      partCount: 1,
    };
  }

  const total = ordered.length;
  const sections = ordered.map((p, i) => section(p, i, total));

  // ---- text-only batch: still a string -------------------------------------
  let content: string | UserContentBlock[];
  if (!hasMedia) {
    content = [preamble(total), ...sections].join("\n\n");
  } else {
    // ---- mixed batch: one text block per part, its media right behind it ----
    const blocks: UserContentBlock[] = [{ type: "text", text: preamble(total) }];
    ordered.forEach((p, i) => {
      blocks.push({ type: "text", text: sections[i]! });
      blocks.push(...p.media);
    });
    content = blocks;
  }

  const kinds = ordered.map((p) => p.kind).join("+");
  const lead = ordered.find((p) => p.text.trim())?.text ?? "";

  return {
    content,
    audit: {
      kind: "BATCH",
      summary: `${total} parts: ${kinds} — ${lead.slice(0, 120)}`,
    },
    // A photo+caption burst should title from the caption, not from "[Foto]".
    titleSeed: ordered.find((p) => p.titleSeed.trim())?.titleSeed ?? ordered[0]!.titleSeed,
    // Only when the whole batch is replayable as text. A batch carrying images
    // would otherwise have /retry silently resend the words and drop the
    // pictures — and today a photo turn never sets lastMessage at all, so this
    // preserves current semantics instead of inventing new ones.
    lastMessageText: hasMedia ? undefined : (content as string),
    cleanupPaths,
    partCount: total,
  };
}
