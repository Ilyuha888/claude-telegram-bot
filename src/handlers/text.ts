/**
 * Text message handler for Claude Telegram Bot.
 *
 * Prepares the message and hands it to the turn collector, which decides
 * whether it travels alone or with the rest of a burst. Everything after that —
 * title, streaming, retry, audit, cleanup — is `runTurn` in src/turn.
 *
 * This handler must never await the turn: the collector's flush runs outside
 * grammY's `sequentialize` middleware precisely because awaiting it from in
 * here would deadlock (see the header of src/turn/collector.ts).
 */

import type { Context } from "grammy";
import { convKeyFromCtx } from "../conversation";
import { ALLOWED_USER } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import {
  buildMessageContext,
  auditLogRateLimit,
  checkInterrupt,
} from "../utils";
import {
  beginArrival,
  endArrival,
  submitPart,
  flushNow,
  dropPending,
  hasPending,
} from "../turn/collector";

/**
 * Handle incoming text messages.
 */
export async function handleText(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;

  if (!userId || !chatId) {
    return;
  }

  // 1. Authorization check — before the collector learns this conversation
  // exists, so unauthorized traffic can't create buffers.
  if (!isAuthorized(userId, ALLOWED_USER)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  const convKey = convKeyFromCtx(ctx);

  // 2. Claim an arrival slot. Synchronous, before the first await: the batch is
  // ordered by this number, and the count of outstanding arrivals is what stops
  // a fast message from being dispatched without a slow one that arrived first.
  const seq = beginArrival(convKey);

  try {
    const built = buildMessageContext(ctx);
    if (!built) return;

    // 3. `!` prefix. checkInterrupt aborts a running query; `!stop` reduces to
    // the empty string, which means "stop and send nothing".
    const wasBang = built.startsWith("!");
    const message = await checkInterrupt(built, ctx);
    if (!message.trim()) {
      if (wasBang) {
        const dropped = await dropPending(convKey, "stopped");
        if (dropped > 0) {
          console.log(`[text] !stop discarded ${dropped} buffered message(s)`);
        }
      }
      return;
    }

    // 4. Rate limit. Skipped while a burst is already collecting: forwarding 25
    // messages is one user action, and charging it 25 times against a 20-per-60s
    // bucket would silently drop the tail. Same "charge the first item only"
    // rule albums have always used.
    if (!hasPending(convKey)) {
      const [allowed, retryAfter] = rateLimiter.check(userId);
      if (!allowed) {
        await auditLogRateLimit(userId, username, retryAfter!);
        await ctx.reply(
          `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
        );
        return;
      }
    }

    // 5. Hand it over. Returns immediately — the turn runs from a timer.
    submitPart(ctx, convKey, {
      kind: "text",
      seq,
      messageId: ctx.message?.message_id,
      text: message,
      media: [],
      audit: { kind: "TEXT", summary: message },
      titleSeed: message,
      lastMessageText: message,
      bytes: message.length,
    });

    // `!` means now. Note it joins the buffer first and then forces the flush,
    // rather than jumping the queue: dispatching it alone would orphan the
    // earlier messages behind a turn they were part of.
    if (wasBang) flushNow(convKey);
  } finally {
    // Never skip this. An arrival that is counted and never released stalls
    // every later message in the conversation — silently, with the card up.
    endArrival(convKey);
  }
}
