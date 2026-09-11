/**
 * The per-conversation dispatch mutex.
 *
 * Today `bot.use(sequentialize(...))` (index.ts:52-70) is the only thing
 * stopping two `sendMessageStreaming` calls from overlapping on one
 * `ClaudeSession`. That guarantee is thinner than it looks:
 *
 *   - it covers messages only. Callback queries, `!`-prefixed text and every
 *     `/command` are deliberately exempted from the queue, so a button press or
 *     `/compact` can already land on top of a running turn;
 *   - `topics.ts` streams a primed session's first answer from a callback, and
 *     `notifications.ts` does the same — neither is a queued message at all.
 *
 * An overlap is not a clean error. `ClaudeSession` keeps one `abortController`
 * (session.ts:680) and one `_queryInstance` (session.ts:725) per instance, and
 * the loser's `finally` resets both (session.ts:1099-1104) — so the second turn
 * silently steals the first turn's cancellation handle, and `/stop` starts
 * aborting the wrong query.
 *
 * This module makes the exclusion explicit and, crucially, independent of
 * grammY middleware — batching has to dispatch turns from a detached timer,
 * which runs outside `sequentialize` entirely.
 *
 * Keyed by conversation, never global: one mutex for the whole bot would
 * serialise every forum topic behind every other and destroy the parallel
 * sessions the topics feature exists to provide (CLAUDE.md, "Parallel sessions").
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { unlink } from "fs/promises";
import type { Context } from "grammy";
import type { Message } from "grammy/types";
import type { StatusCallback } from "../types";
import type { ConversationKey } from "../conversation";
import { convKeyStr } from "../conversation";
import { registry } from "../session-registry";
import {
  auditLog,
  classifyClaudeError,
  formatClaudeErrorReply,
  startTypingIndicator,
} from "../utils";
import { StreamingState, createStatusCallback } from "../handlers/streaming";
import { composeTurn, type TurnPart } from "./part";

/**
 * Thrown when a conversation tries to acquire its own lock while already
 * holding it.
 *
 * Loud on purpose. The alternative — waiting on a chain whose head is our own
 * caller — is a permanent hang with no error, no log and no timeout: the user
 * sees a typing indicator forever. The document handler's audio path
 * (`document.ts` routing an audio file to `processAudioFile`) is the live
 * example of two dispatch sites one call apart, so this is a real shape, not a
 * hypothetical one. Wrap leaf dispatch sites only.
 */
export class ReentrantDispatchError extends Error {
  constructor(key: string) {
    super(
      `runExclusive: re-entrant acquire of conversation ${key}. ` +
        `Something already holding this conversation's dispatch lock tried to ` +
        `take it again — that would deadlock. Wrap leaf dispatch sites only.`,
    );
    this.name = "ReentrantDispatchError";
  }
}

/** Tail of the promise chain per conversation. Absent = idle. */
const chains = new Map<string, Promise<unknown>>();

/** Entries queued or running per conversation. Drives isDispatching. */
const pending = new Map<string, number>();

/** Conversation keys held by the current async context, for re-entrancy. */
const heldKeys = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * Run `fn` with exclusive access to one conversation's Claude session.
 *
 * Calls on the same conversation run one after another in call order; calls on
 * different conversations do not wait for each other at all.
 */
export function runExclusive<T>(key: ConversationKey, fn: () => Promise<T>): Promise<T> {
  const k = convKeyStr(key);

  const held = heldKeys.getStore();
  if (held?.has(k)) throw new ReentrantDispatchError(k);
  const nested = new Set(held ?? []);
  nested.add(k);

  // Incremented synchronously, before any await, so a caller that enqueues
  // while our `release` is pending cannot see a count of zero and be treated as
  // idle — nor have its chain entry deleted out from under it.
  pending.set(k, (pending.get(k) ?? 0) + 1);

  let tail: Promise<unknown>;

  const release = () => {
    const left = (pending.get(k) ?? 1) - 1;
    if (left > 0) {
      pending.set(k, left);
      return;
    }
    pending.delete(k);
    // Only when nobody is queued behind us, so the map doesn't grow one entry
    // per conversation for the process's lifetime.
    if (chains.get(k) === tail) chains.delete(k);
  };

  const prev = chains.get(k) ?? Promise.resolve();
  const result = prev.then(async () => {
    try {
      return await heldKeys.run(nested, fn);
    } finally {
      release();
    }
  });

  // `.catch(() => {})` is not optional: chaining the raw `result` would make one
  // thrown turn reject every later turn on that conversation forever. Same
  // poison-proofing as `enqueue` in session-store.ts:119-123.
  tail = result.catch(() => {});
  chains.set(k, tail);

  return result;
}

/** True while a turn is queued or streaming for this conversation. */
export function isDispatching(key: ConversationKey): boolean {
  return (pending.get(convKeyStr(key)) ?? 0) > 0;
}

/** Test seam. Not called by the bot. */
export function __resetDispatcherForTests(): void {
  chains.clear();
  pending.clear();
}

// ============== The turn itself ==============

/** One retry, and only for a Claude Code crash. See the loop below. */
const MAX_RETRIES = 1;

/** Conversation titles are shown in /status and /resume lists. */
function asTitle(seed: string): string {
  const raw = seed.trim() === "" ? "[Message]" : seed;
  return raw.length > 50 ? raw.slice(0, 47) + "..." : raw;
}

/**
 * Wrap a status callback so the collecting card is removed as soon as the
 * answer starts arriving.
 *
 * The card's whole job is to say "I'm waiting for more of your messages"; the
 * moment output appears it is stale, and leaving it above a streaming answer
 * reads as a second, stuck reply. Deleted rather than edited so nothing is left
 * behind. Idempotent, because status events arrive many times per turn.
 */
function dismissCardOnFirstOutput(
  ctx: Context,
  card: Message | null,
  inner: StatusCallback,
): StatusCallback {
  if (!card) return inner;
  let dismissed = false;
  return async (statusType, content, segmentId) => {
    if (!dismissed) {
      dismissed = true;
      try {
        await ctx.api.deleteMessage(card.chat.id, card.message_id);
      } catch (err) {
        console.debug("[turn] failed to delete collecting card:", err);
      }
    }
    return inner(statusType, content, segmentId);
  };
}

/**
 * Run one Claude turn for a conversation. **Assumes the conversation's dispatch
 * lock is already held** — call it through `runExclusive`, or via
 * `dispatchTurn`.
 *
 * This is the tail every message handler used to carry its own copy of: set the
 * title, mark processing, start typing, stream, audit, handle errors, clean up.
 * It lives here because batching dispatches from a detached timer, so the tail
 * has to run somewhere that isn't a handler — and once it does, the handlers
 * reduce to preparing a `TurnPart`.
 */
export async function runTurn(
  ctx: Context,
  key: ConversationKey,
  parts: TurnPart[],
  card: Message | null = null,
): Promise<void> {
  const turn = composeTurn(parts);
  const session = registry.get(key);
  const userId = ctx.from?.id ?? 0;
  const username = ctx.from?.username ?? "unknown";

  // /retry replays this verbatim, so it is set only for turns that can be
  // replayed in full — composeTurn leaves it undefined when media is involved.
  if (turn.lastMessageText !== undefined) {
    session.lastMessage = turn.lastMessageText;
  }

  if (!session.isActive) {
    session.conversationTitle = asTitle(turn.titleSeed);
  }

  const stopProcessing = session.startProcessing();
  const typing = startTypingIndicator(ctx);

  let state = new StreamingState();
  let statusCallback = dismissCardOnFirstOutput(
    ctx,
    card,
    createStatusCallback(ctx, state),
  );

  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await session.sendMessageStreaming(
          turn.content,
          username,
          userId,
          statusCallback,
          key.chatId,
          ctx,
          key.threadId,
        );
        await auditLog(userId, username, turn.audit.kind, turn.audit.summary, response);
        break;
      } catch (error) {
        // Partial output from the failed attempt would otherwise be left above
        // the retry's output, or above the error message.
        for (const toolMsg of state.toolMessages) {
          try {
            await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
          } catch {
            // Ignore cleanup errors
          }
        }

        // Retried only for a crashed subprocess, never for a refusal, a
        // cancellation or an API error — re-running one of those would spend the
        // user's tokens twice on the same failure.
        if (String(error).includes("exited with code") && attempt < MAX_RETRIES) {
          console.log(
            `Claude Code crashed, retrying (attempt ${attempt + 2}/${MAX_RETRIES + 1})...`,
          );
          await session.kill();
          await ctx.reply("⚠️ Claude crashed, retrying...");
          state = new StreamingState();
          statusCallback = dismissCardOnFirstOutput(
            ctx,
            card,
            createStatusCallback(ctx, state),
          );
          continue;
        }

        console.error("[turn] error processing turn:", error);

        if (classifyClaudeError(error) === "cancellation") {
          // "Query stopped" belongs to an explicit /stop. An interrupt from a
          // new message is not something the user needs told twice.
          if (!session.consumeInterruptFlag()) {
            await ctx.reply(formatClaudeErrorReply(error));
          }
        } else {
          await ctx.reply(formatClaudeErrorReply(error));
        }
        break;
      }
    }
  } finally {
    stopProcessing();
    typing.stop();

    // The card normally goes on the first status event; this covers a turn that
    // produced none at all (an immediate error).
    if (card) {
      try {
        await ctx.api.deleteMessage(card.chat.id, card.message_id);
      } catch {
        // Already deleted by the status callback, in the common case.
      }
    }

    for (const path of turn.cleanupPaths) {
      try {
        await unlink(path);
      } catch (err) {
        console.debug(`[turn] failed to remove ${path}:`, err);
      }
    }
  }
}

/**
 * Take the conversation's lock and run one turn. The entry point for a caller
 * that has parts in hand and no batching to do.
 */
export function dispatchTurn(
  ctx: Context,
  key: ConversationKey,
  parts: TurnPart[],
  card: Message | null = null,
): Promise<void> {
  return runExclusive(key, () => runTurn(ctx, key, parts, card));
}
