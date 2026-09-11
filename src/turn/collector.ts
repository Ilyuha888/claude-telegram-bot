/**
 * Inbound coalescing: a burst of Telegram messages becomes one Claude turn.
 *
 * Forwarding ten messages used to cost ten turns and ten answers, with the
 * burst's meaning split across all of them. Here they are buffered behind a
 * trailing debounce and dispatched together.
 *
 * ── Why the flush is detached ────────────────────────────────────────────────
 *
 * A batch cannot be flushed from inside grammY middleware. If a handler awaited
 * the flush, the flush would wait for more messages, those messages would wait
 * for `sequentialize`'s per-conversation lock, and that lock would wait for the
 * handler. So `submitPart` returns void and never blocks its handler, and the
 * turn runs from a timer callback — outside `sequentialize` entirely, which is
 * why `runExclusive` has to exist (see dispatcher.ts).
 *
 * ── Why `inflight` exists ────────────────────────────────────────────────────
 *
 * `sequentialize` orders handlers; it does not make them instant. A text
 * message lands at t=0 and arms a 1.5s timer. A voice note lands at t=0.1 and
 * its handler spends four seconds transcribing. Without a counter of handlers
 * that have started but not yet submitted, the timer fires at t=1.5 and
 * dispatches the text *alone* — so a photo forwarded with its caption still
 * produces two turns, intermittently, only under real latency, and only in
 * production. `beginArrival` is therefore called synchronously at handler
 * entry, before the first `await`, and `endArrival` from a `finally` on every
 * path.
 */

import type { Api, Context } from "grammy";
import type { Message } from "grammy/types";
import type { ConversationKey } from "../conversation";
import { convKeyStr, threadOpts } from "../conversation";
import {
  MEDIA_GROUP_TIMEOUT,
  TURN_BATCH_CARD,
  TURN_BATCH_MAX_BYTES,
  TURN_BATCH_MAX_ITEMS,
  TURN_BATCH_MAX_WAIT_MS,
  TURN_BATCH_WINDOW_MS,
} from "../config";
import { runExclusive, runTurn } from "./dispatcher";
import type { TurnPart } from "./part";

/** A batch closed for good, waiting its turn. Only the byte cap makes these. */
interface SealedBatch {
  batch: TurnPart[];
  ctx: Context;
}

interface ConvBuffer {
  key: ConversationKey;
  /** Delivery anchor: the ctx of the first part in the current batch. */
  ctx: Context | null;
  /**
   * Kept separately from `ctx` because the card outlives it: `ctx` is released
   * when the batch is detached, while the card still has to be relabelled and
   * deleted. Process-global anyway — every ctx carries the same Api.
   */
  api: Api | null;
  parts: TurnPart[];
  /** Batches already closed by the byte cap. Dispatched before `parts`. */
  sealed: SealedBatch[];
  bytes: number;
  firstAt: number;
  /** Handlers between beginArrival and endArrival. See the header. */
  inflight: number;
  /**
   * A turn is being dispatched — which covers both waiting for the
   * conversation's mutex and streaming the answer. Set synchronously in
   * `maybeFlush` before anything can await, and cleared in a `finally`: if a
   * throw ever skipped that reset, the conversation would keep accepting
   * messages, keep showing the card, and never answer again.
   */
  running: boolean;
  softTimer: ReturnType<typeof setTimeout> | null;
  hardTimer: ReturnType<typeof setTimeout> | null;
  /** A trigger fired but a precondition blocked it. See `maybeFlush`. */
  flushRequested: boolean;
  /**
   * Arrivals numbered below this were cancelled before they could submit.
   *
   * A transcription or a download can still be running when the user says
   * `/stop` or `/new`, and dropping the buffer alone would not reach it: the
   * handler finishes a few seconds later and submits into the very batch — or
   * the very fresh session — the user just disowned. Because `beginArrival` is
   * synchronous at handler entry, a seq below the drop mark means "this message
   * had already arrived when the user cancelled", which is exactly the set to
   * discard. Replaces the `session.startProcessing()` / `stopRequested` dance
   * the media handlers used to run for the same purpose.
   */
  cancelBefore: number;
  card: Message | null;
  /** In-flight card send, so a flush can't try to edit a card it lacks yet. */
  cardSend: Promise<void> | null;
}

const buffers = new Map<string, ConvBuffer>();

/** Arrival order across the whole process. Only relative order matters. */
let seqCounter = 0;

/** Injectable for tests; the bot always uses the real turn. */
let runTurnImpl = runTurn;

function buffer(key: ConversationKey): ConvBuffer {
  const k = convKeyStr(key);
  let buf = buffers.get(k);
  if (!buf) {
    buf = {
      key,
      ctx: null,
      api: null,
      parts: [],
      sealed: [],
      bytes: 0,
      firstAt: 0,
      inflight: 0,
      running: false,
      softTimer: null,
      hardTimer: null,
      flushRequested: false,
      cancelBefore: -1,
      card: null,
      cardSend: null,
    };
    buffers.set(k, buf);
  }
  return buf;
}

/** Forget a buffer that holds nothing and is doing nothing. */
function gc(buf: ConvBuffer): void {
  if (
    buf.parts.length === 0 &&
    buf.sealed.length === 0 &&
    buf.inflight === 0 &&
    !buf.running &&
    !buf.card &&
    !buf.cardSend
  ) {
    clearTimers(buf);
    buffers.delete(convKeyStr(buf.key));
  }
}

function clearTimers(buf: ConvBuffer): void {
  if (buf.softTimer) clearTimeout(buf.softTimer);
  if (buf.hardTimer) clearTimeout(buf.hardTimer);
  buf.softTimer = null;
  buf.hardTimer = null;
}

// ============== Arrival accounting ==============

/**
 * Register that a message for this conversation has started being prepared.
 * Returns its arrival sequence number, which is what orders the batch — a voice
 * note that arrives first but transcribes slowly must still come first.
 *
 * Call synchronously at handler entry, before any `await`, and pair with
 * `endArrival` in a `finally`.
 */
export function beginArrival(key: ConversationKey): number {
  const buf = buffer(key);
  buf.inflight++;
  return seqCounter++;
}

/** Preparation finished (or failed). Never skip this — see the header. */
export function endArrival(key: ConversationKey): void {
  const k = convKeyStr(key);
  const buf = buffers.get(k);
  if (!buf) return;
  buf.inflight = Math.max(0, buf.inflight - 1);
  maybeFlush(buf);
}

// ============== Submission ==============

/**
 * Hand a prepared message to the collector. Returns immediately: the turn is
 * dispatched later, from a timer, for the deadlock reason in the header.
 *
 * Returns false if the message was cancelled while it was being prepared, in
 * which case it will never be sent and the caller owns its temp files.
 */
export function submitPart(ctx: Context, key: ConversationKey, part: TurnPart): boolean {
  const buf = buffer(key);

  if (part.seq < buf.cancelBefore) {
    console.log(`[collector] discarding ${part.kind} — cancelled while preparing`);
    return false;
  }

  // Checked BEFORE appending, so the cap bounds what is actually sent instead
  // of being advisory. Nothing is dropped — the batch so far is closed and this
  // part starts the next one.
  if (buf.parts.length > 0 && buf.bytes + part.bytes > TURN_BATCH_MAX_BYTES) {
    seal(buf);
    requestFlush(buf);
  }

  buf.api = ctx.api;
  if (buf.parts.length === 0) {
    buf.ctx = ctx;
    buf.firstAt = Date.now();
  }
  buf.parts.push(part);
  buf.bytes += part.bytes;

  // A message that arrived as part of an album gets a floor on its window: the
  // client split one user action into N updates and never said how many, so
  // those must coalesce even with burst batching switched off.
  const window = Math.max(
    TURN_BATCH_WINDOW_MS,
    part.mediaGroupId ? MEDIA_GROUP_TIMEOUT : 0,
  );

  if (buf.parts.length >= TURN_BATCH_MAX_ITEMS) {
    requestFlush(buf);
    return true;
  }

  if (window <= 0) {
    // No artificial wait. Still not a synchronous dispatch — and still not
    // necessarily alone: if another handler is mid-preparation right now,
    // `inflight` holds this back and the two travel together, which is what a
    // caption arriving beside its photo needs.
    requestFlush(buf);
    return true;
  }

  if (buf.softTimer) clearTimeout(buf.softTimer);
  buf.softTimer = setTimeout(() => {
    buf.softTimer = null;
    requestFlush(buf);
  }, window);

  // Armed once, from the first part, so a steady trickle can't defer the answer
  // forever by re-arming the debounce.
  if (!buf.hardTimer) {
    buf.hardTimer = setTimeout(
      () => {
        buf.hardTimer = null;
        requestFlush(buf);
      },
      Math.max(0, TURN_BATCH_MAX_WAIT_MS - (Date.now() - buf.firstAt)),
    );
  }

  showCard(buf);
  return true;
}

/**
 * Close the current batch synchronously and queue it for dispatch.
 *
 * Only the byte cap needs this, and it needs it badly. `flush` normally detaches
 * inside the lock, so parts that arrive while it waits still join the batch —
 * but the part that just overflowed the cap must *not* join it, and the detach
 * is a microtask away, which is plenty of time for `submitPart` to have appended
 * it. Without a synchronous seal here the cap bounds nothing at all.
 */
function seal(buf: ConvBuffer): void {
  if (buf.parts.length === 0 || !buf.ctx) return;
  buf.sealed.push({ batch: buf.parts, ctx: buf.ctx });
  buf.parts = [];
  buf.bytes = 0;
  buf.ctx = null;
}

/** `!`-prefixed input means now: dispatch whatever is buffered. */
export function flushNow(key: ConversationKey): void {
  const buf = buffers.get(convKeyStr(key));
  if (buf) requestFlush(buf);
}

// ============== Flushing ==============

function requestFlush(buf: ConvBuffer): void {
  buf.flushRequested = true;
  maybeFlush(buf);
}

/**
 * The one place the flush precondition is evaluated.
 *
 * Six triggers can want a flush (both timers, the item cap, the byte cap, `!`,
 * and a finishing turn). Each of them sets `flushRequested` and calls this;
 * none of them decides for itself. Four triggers times three preconditions
 * written inline is exactly where double-flush bugs live.
 */
function maybeFlush(buf: ConvBuffer): void {
  const nothingToSend = buf.parts.length === 0 && buf.sealed.length === 0;
  if (!buf.flushRequested || buf.running || buf.inflight > 0 || nothingToSend) {
    gc(buf);
    return;
  }
  // Set before anything can await, so a second trigger in the same tick cannot
  // start a second turn.
  buf.running = true;
  buf.flushRequested = false;
  clearTimers(buf);
  void flush(buf);
}

async function flush(buf: ConvBuffer): Promise<void> {
  try {
    await runExclusive(buf.key, async () => {
      // A sealed batch is already closed and goes first, in order. Otherwise the
      // live batch is detached AFTER the lock is held, never before: detaching
      // first would strand every part that arrived while we waited into a second
      // batch dispatched a millisecond later — the exact behaviour this module
      // exists to remove, and one that passes any naive test.
      const sealed = buf.sealed.shift();
      const batch = sealed ? sealed.batch : buf.parts;
      const ctx = sealed ? sealed.ctx : buf.ctx;
      if (!sealed) {
        buf.parts = [];
        buf.bytes = 0;
        buf.ctx = null;
      }

      const card = await takeCard(buf, batch.length);
      if (batch.length === 0 || !ctx) return;

      await runTurnImpl(ctx, buf.key, batch, card);
    });
  } catch (err) {
    // runTurn handles its own errors and reports to the user; anything landing
    // here is a bug in the plumbing, and swallowing it silently is how a
    // conversation goes quiet with no trace.
    console.error(`[collector] flush failed for ${convKeyStr(buf.key)}:`, err);
  } finally {
    buf.running = false;
    // Parts that arrived while the turn was streaming go out as one turn now,
    // rather than as one turn each. Same for a batch the byte cap sealed.
    if (buf.parts.length > 0 || buf.sealed.length > 0) buf.flushRequested = true;
    maybeFlush(buf);
  }
}

// ============== The collecting card ==============

function showCard(buf: ConvBuffer): void {
  if (TURN_BATCH_CARD === "off") return;
  if (buf.card || buf.cardSend) return;

  // "Informative" means the card is telling the user something they can't see:
  // more than one message is being held, or an answer is already in progress.
  const informative = buf.parts.length >= 2 || buf.running;
  if (TURN_BATCH_CARD === "multi" && !informative) return;
  // Even in `always` mode, don't post a card for a message that isn't going to
  // wait — it would appear and vanish for no reason.
  if (!informative && !buf.softTimer && !buf.hardTimer) return;

  const ctx = buf.ctx;
  if (!ctx) return;

  buf.cardSend = ctx
    .reply("📥 Collecting…")
    .then((msg) => {
      buf.card = msg;
    })
    .catch((err) => {
      console.debug("[collector] failed to post collecting card:", err);
    })
    .finally(() => {
      buf.cardSend = null;
    });
}

/**
 * Hand the card over to its next owner, relabelled for what happens now.
 *
 * Awaits an in-flight send first: a burst can be flushed before Telegram has
 * answered the card's own `sendMessage`, and abandoning it there would leave a
 * "📥 Collecting…" message stranded above the answer forever.
 *
 * `count === 0` means the caller is discarding rather than dispatching, and
 * relabels the card itself.
 */
async function takeCard(buf: ConvBuffer, count: number): Promise<Message | null> {
  if (buf.cardSend) {
    try {
      await buf.cardSend;
    } catch {
      // showCard already logged it.
    }
  }
  const card = buf.card;
  buf.card = null;
  if (!card || count === 0) return card;

  const text = count === 1 ? "📥 Processing…" : `📥 Processing ${count} messages…`;
  try {
    await buf.api?.editMessageText(card.chat.id, card.message_id, text);
  } catch (err) {
    console.debug("[collector] failed to relabel collecting card:", err);
  }
  return card;
}

// ============== Inspection and teardown ==============

export function hasPending(key: ConversationKey): boolean {
  return pendingCount(key) > 0;
}

export function pendingCount(key: ConversationKey): number {
  const buf = buffers.get(convKeyStr(key));
  if (!buf) return 0;
  let n = buf.parts.length;
  for (const s of buf.sealed) n += s.batch.length;
  return n;
}

/** True if any conversation is mid-burst. Used by the scheduler's idle gate. */
export function hasAnyPending(): boolean {
  for (const buf of buffers.values()) {
    if (busy(buf)) return true;
  }
  return false;
}

/**
 * Busy in the collector's sense: buffering, preparing, or dispatching.
 *
 * Wider than `hasPending`, and deliberately so — this is the question the
 * lifecycle layer asks. A conversation whose only outstanding work is a voice
 * note three seconds into transcription has zero buffered parts and no running
 * ClaudeSession, so every existing idleness check reads it as idle.
 */
function busy(buf: ConvBuffer): boolean {
  return (
    buf.parts.length > 0 || buf.sealed.length > 0 || buf.inflight > 0 || buf.running
  );
}

/** Is this one conversation mid-burst? For the topic reaper and /status. */
export function isCollecting(key: ConversationKey): boolean {
  const buf = buffers.get(convKeyStr(key));
  return buf ? busy(buf) : false;
}

/**
 * The same question for every conversation at once, as serialised keys.
 *
 * The registry scans its own map of `convKeyStr` keys and must not import this
 * module — `collector → dispatcher → session-registry` already exists, and the
 * reverse edge would close the cycle. So the reaper reads the set here and
 * hands it down.
 */
export function collectingKeys(): Set<string> {
  const keys = new Set<string>();
  for (const [k, buf] of buffers) {
    if (busy(buf)) keys.add(k);
  }
  return keys;
}

/**
 * Tell every conversation holding unsent messages that they died in a restart.
 *
 * Best effort by construction: the caller is on its way to `process.exit` and
 * caps how long this may take. Silence would be worse than a late card — the
 * user is sitting in front of a `📥 Collecting…` that will never resolve, and
 * nothing else in the system will ever mention those messages again.
 */
export async function warnPendingOnShutdown(): Promise<number> {
  let total = 0;
  const jobs: Promise<unknown>[] = [];

  for (const buf of buffers.values()) {
    const n = pendingCount(buf.key);
    if (n === 0 || !buf.api) continue;
    total += n;
    clearTimers(buf);
    jobs.push(
      buf.api
        .sendMessage(
          buf.key.chatId,
          `⚠️ Restarting — ${n} message${n === 1 ? "" : "s"} ${n === 1 ? "was" : "were"} ` +
            "still being collected and never reached Claude. Please resend.",
          threadOpts(buf.key.threadId),
        )
        .catch(() => {}),
    );
  }

  await Promise.all(jobs);
  return total;
}

/**
 * Throw away whatever is buffered for a conversation, returning how many
 * messages were discarded.
 *
 * For the commands that make a pending batch meaningless: `/new` and `/close`
 * would otherwise flush pre-command messages into a *fresh* session, seeding
 * and titling it from input the user has just disowned.
 *
 * Also cancels arrivals that are still being prepared — see `cancelBefore`. The
 * count returned covers only what was actually buffered, because a voice note
 * three seconds into transcription is not something the user can see a number
 * for.
 */
export async function dropPending(key: ConversationKey, reason: string): Promise<number> {
  const buf = buffers.get(convKeyStr(key));
  if (!buf) return 0;

  buf.cancelBefore = seqCounter;
  const dropped = pendingCount(key);
  buf.parts = [];
  buf.sealed = [];
  buf.bytes = 0;
  buf.ctx = null;
  buf.flushRequested = false;
  clearTimers(buf);

  const card = await takeCard(buf, 0);
  if (card) {
    const text =
      dropped > 0
        ? `🗑 ${dropped} unsent message${dropped === 1 ? "" : "s"} discarded — ${reason}.`
        : null;
    try {
      if (text) {
        await buf.api?.editMessageText(card.chat.id, card.message_id, text);
      } else {
        await buf.api?.deleteMessage(card.chat.id, card.message_id);
      }
    } catch (err) {
      console.debug("[collector] failed to update card on drop:", err);
    }
  }

  gc(buf);
  return dropped;
}

/** Test seams. Not called by the bot. */
export function __setRunTurnForTests(fn: typeof runTurn): void {
  runTurnImpl = fn;
}
export function __resetCollectorForTests(): void {
  for (const buf of buffers.values()) clearTimers(buf);
  buffers.clear();
  runTurnImpl = runTurn;
  seqCounter = 0;
}
