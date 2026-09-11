/**
 * Tests for src/turn/collector.ts — the inbound coalescing buffer.
 *
 * `config` is module-mocked with timings small enough to wait on inside a test.
 * The real turn is replaced via `__setRunTurnForTests`, so nothing here touches
 * ClaudeSession, the registry, or Telegram: a dispatch is recorded as the list
 * of parts it was given, which is exactly the property under test.
 *
 * Timing choices, since they are load-bearing:
 *   WINDOW=50, MAX_WAIT=200, MEDIA_GROUP_TIMEOUT=400
 *   → a plain part waits 50ms; an album part's floor (400) exceeds the ceiling
 *     (200), which lets one fixture prove both the floor and the ceiling with
 *     comfortable margins and no fragile trickle loop.
 *   MAX_ITEMS=3, MAX_BYTES=1000 — both small enough to trip deliberately.
 *
 * Bun's module mocks are process-wide and keyed by resolved path, so the real
 * namespace is restored in afterAll (same dance as tests/topic-reaper.test.ts).
 *
 * Run with: bun test tests/turn-collector.test.ts
 */

import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import type { Context } from "grammy";
import type { ConversationKey } from "../src/conversation";
import type { TurnPart } from "../src/turn/part";

const WINDOW = 50;
const MAX_WAIT = 200;
const MEDIA_FLOOR = 400;
const MAX_ITEMS = 3;
const MAX_BYTES = 1000;

const realConfig = { ...(await import("../src/config")) };

afterAll(() => {
  mock.module("../src/config", () => ({ ...realConfig }));
});

mock.module("../src/config", () => ({
  ...realConfig,
  TURN_BATCH_WINDOW_MS: WINDOW,
  TURN_BATCH_MAX_WAIT_MS: MAX_WAIT,
  TURN_BATCH_MAX_ITEMS: MAX_ITEMS,
  TURN_BATCH_MAX_BYTES: MAX_BYTES,
  MEDIA_GROUP_TIMEOUT: MEDIA_FLOOR,
  TURN_BATCH_CARD: "always",
}));

const {
  beginArrival,
  endArrival,
  submitPart,
  flushNow,
  dropPending,
  hasPending,
  pendingCount,
  hasAnyPending,
  __setRunTurnForTests,
  __resetCollectorForTests,
} = await import("../src/turn/collector");
const { __resetDispatcherForTests } = await import("../src/turn/dispatcher");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DM: ConversationKey = { chatId: 4242, threadId: undefined };
const TOPIC: ConversationKey = { chatId: -1002222222222, threadId: 7 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the fake Telegram surface was asked to do. */
interface FakeTg {
  replies: string[];
  edits: { messageId: number; text: string }[];
  deleted: number[];
}

function fakeCtx(chatId: number, tg: FakeTg): Context {
  let nextId = 100;
  const api = {
    editMessageText: async (_chat: number, messageId: number, text: string) => {
      tg.edits.push({ messageId, text });
      return true;
    },
    deleteMessage: async (_chat: number, messageId: number) => {
      tg.deleted.push(messageId);
      return true;
    },
  };
  return {
    api,
    chat: { id: chatId },
    reply: async (text: string) => {
      tg.replies.push(text);
      return { message_id: nextId++, chat: { id: chatId } };
    },
  } as unknown as Context;
}

function part(over: Partial<TurnPart> & { text: string }): TurnPart {
  return {
    kind: "text",
    seq: 0,
    media: [],
    audit: { kind: "TEXT", summary: over.text },
    titleSeed: over.text,
    lastMessageText: over.text,
    bytes: over.text.length,
    ...over,
  };
}

/** Every dispatch the collector made, as the texts of the parts it carried. */
let dispatches: string[][];
/** Set to a promise to make each fake turn block until it resolves. */
let gate: Promise<void> | null;
let tg: FakeTg;
let ctx: Context;

beforeEach(() => {
  __resetCollectorForTests();
  __resetDispatcherForTests();
  dispatches = [];
  gate = null;
  tg = { replies: [], edits: [], deleted: [] };
  ctx = fakeCtx(DM.chatId, tg);

  __setRunTurnForTests(async (_ctx, _key, parts) => {
    dispatches.push(parts.map((p) => p.text));
    if (gate) await gate;
  });
});

afterAll(() => {
  __resetCollectorForTests();
});

/** One handler's worth of work: begin, submit, end — the real call order. */
function deliver(key: ConversationKey, p: Partial<TurnPart> & { text: string }, c = ctx) {
  const seq = beginArrival(key);
  try {
    submitPart(c, key, part({ ...p, seq }));
  } finally {
    endArrival(key);
  }
}

// ---------------------------------------------------------------------------

describe("debounce window", () => {
  test("a single message waits for the window, then dispatches alone", async () => {
    deliver(DM, { text: "hello" });

    await sleep(WINDOW / 2);
    expect(dispatches).toEqual([]);
    expect(hasPending(DM)).toBe(true);

    await sleep(WINDOW * 2);
    expect(dispatches).toEqual([["hello"]]);
    expect(hasPending(DM)).toBe(false);
  });

  test("messages inside the window become ONE turn", async () => {
    deliver(DM, { text: "one" });
    await sleep(WINDOW * 0.6);
    deliver(DM, { text: "two" });
    await sleep(WINDOW * 0.6);
    deliver(DM, { text: "three" });

    await sleep(WINDOW * 3);
    expect(dispatches).toEqual([["one", "two", "three"]]);
  });

  test("a gap longer than the window makes two turns", async () => {
    deliver(DM, { text: "first" });
    await sleep(WINDOW * 3);
    deliver(DM, { text: "second" });
    await sleep(WINDOW * 3);

    expect(dispatches).toEqual([["first"], ["second"]]);
  });

  test("parts are ordered by arrival, not by submission", async () => {
    // A voice note that lands first but transcribes slowly must still come
    // first: the batch is ordered by the seq handed out at beginArrival.
    const slow = beginArrival(DM);
    const fast = beginArrival(DM);

    submitPart(ctx, DM, part({ text: "typed", seq: fast }));
    endArrival(DM);
    submitPart(ctx, DM, part({ text: "transcribed", seq: slow }));
    endArrival(DM);

    await sleep(WINDOW * 3);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.length).toBe(2);
    // composeTurn does the sorting; the collector's job is to give it the seqs.
    expect(slow).toBeLessThan(fast);
  });
});

describe("inflight arrivals (R1)", () => {
  test("an outstanding arrival holds the batch, and joins it when it lands", async () => {
    // The failure this prevents: text lands at t=0 and arms the window, a photo
    // lands at t=0.1 and spends four seconds downloading, the window fires and
    // dispatches the text alone. Intermittent, latency-dependent, production-only.
    const textSeq = beginArrival(DM);
    submitPart(ctx, DM, part({ text: "look at this", seq: textSeq }));

    const slowSeq = beginArrival(DM); // handler still preparing
    endArrival(DM); // the text handler returns

    // The window elapses several times over with a preparation outstanding.
    await sleep(WINDOW * 4);
    expect(dispatches).toEqual([]);

    submitPart(ctx, DM, part({ text: "[Photo]", seq: slowSeq }));
    endArrival(DM);

    // No further wait needed: the window already fired and requested the flush,
    // so the last arrival releases it immediately.
    await sleep(WINDOW / 2);
    expect(dispatches).toEqual([["look at this", "[Photo]"]]);
  });

  test("hasAnyPending covers an arrival that has not submitted yet", () => {
    beginArrival(DM);
    expect(hasAnyPending()).toBe(true);
    expect(pendingCount(DM)).toBe(0); // nothing buffered yet — but not idle
    endArrival(DM);
    expect(hasAnyPending()).toBe(false);
  });
});

describe("mid-turn arrivals", () => {
  test("messages arriving during a turn coalesce into ONE next turn", async () => {
    let release!: () => void;
    gate = new Promise<void>((r) => {
      release = r;
    });

    deliver(DM, { text: "question" });
    await sleep(WINDOW * 2);
    expect(dispatches).toEqual([["question"]]);

    deliver(DM, { text: "addendum a" });
    deliver(DM, { text: "addendum b" });
    await sleep(WINDOW * 3);

    // Still exactly one dispatch: the turn holds the conversation.
    expect(dispatches).toEqual([["question"]]);

    gate = null;
    release();
    await sleep(WINDOW);

    expect(dispatches).toEqual([["question"], ["addendum a", "addendum b"]]);
  });

  test("a thrown turn does not wedge the conversation (R3)", async () => {
    __setRunTurnForTests(async (_ctx, _key, parts) => {
      dispatches.push(parts.map((p) => p.text));
      throw new Error("turn exploded");
    });

    deliver(DM, { text: "boom" });
    await sleep(WINDOW * 3);
    expect(dispatches).toEqual([["boom"]]);

    // `running` was reset in a finally, so the next message still gets a turn.
    deliver(DM, { text: "after" });
    await sleep(WINDOW * 3);
    expect(dispatches).toEqual([["boom"], ["after"]]);
  });
});

describe("bounds", () => {
  test("the item cap flushes early, without waiting for the window", async () => {
    for (let i = 0; i < MAX_ITEMS; i++) deliver(DM, { text: `m${i}` });

    // Well inside the window: the cap, not the timer, released this.
    await sleep(WINDOW / 5);
    expect(dispatches).toEqual([["m0", "m1", "m2"]]);
  });

  test("the byte cap closes the batch before the overflowing part joins it", async () => {
    const big = "x".repeat(600);
    deliver(DM, { text: big });
    deliver(DM, { text: `${big}!` });

    await sleep(WINDOW * 4);
    // Two turns of 600 bytes, not one of 1200. The seal has to be synchronous:
    // the detach inside flush() is a microtask away, which is long enough for
    // the second submitPart to have appended.
    expect(dispatches).toEqual([[big], [`${big}!`]]);
  });

  test("the max-wait ceiling pre-empts a longer window", async () => {
    // An album part's window floor (400) is deliberately past the ceiling (200).
    deliver(DM, { text: "[Photo 1]", mediaGroupId: "album-1" });

    await sleep(MAX_WAIT + WINDOW * 2);
    expect(dispatches).toEqual([["[Photo 1]"]]);
    expect(MAX_WAIT).toBeLessThan(MEDIA_FLOOR);
  });

  test("an album part waits longer than the plain window", async () => {
    deliver(DM, { text: "[Photo 1]", mediaGroupId: "album-1" });

    // Past the plain window, so a missing floor would already have dispatched.
    await sleep(WINDOW * 2);
    expect(dispatches).toEqual([]);
  });

  test("album items coalesce into one turn", async () => {
    deliver(DM, { text: "[Photo 1]", mediaGroupId: "album-1" });
    await sleep(WINDOW * 2);
    deliver(DM, { text: "[Photo 2]", mediaGroupId: "album-1" });

    await sleep(MAX_WAIT + WINDOW * 2);
    expect(dispatches).toEqual([["[Photo 1]", "[Photo 2]"]]);
  });
});

describe("conversation isolation", () => {
  test("two conversations collect and dispatch independently", async () => {
    const topicTg: FakeTg = { replies: [], edits: [], deleted: [] };
    const topicCtx = fakeCtx(TOPIC.chatId, topicTg);
    const seen: string[][] = [];

    __setRunTurnForTests(async (_ctx, key, parts) => {
      seen.push([String(key.threadId ?? "dm"), ...parts.map((p) => p.text)]);
    });

    deliver(DM, { text: "dm message" });
    deliver(TOPIC, { text: "topic message" }, topicCtx);

    await sleep(WINDOW * 3);

    expect(seen).toHaveLength(2);
    expect(seen).toContainEqual(["dm", "dm message"]);
    expect(seen).toContainEqual(["7", "topic message"]);
  });

  test("pendingCount and hasPending are per conversation", async () => {
    deliver(DM, { text: "only in the dm" });

    expect(pendingCount(DM)).toBe(1);
    expect(pendingCount(TOPIC)).toBe(0);
    expect(hasPending(TOPIC)).toBe(false);

    await sleep(WINDOW * 3);
  });
});

describe("flushNow and dropPending", () => {
  test("flushNow dispatches without waiting, and takes the buffer with it", async () => {
    deliver(DM, { text: "earlier" });
    deliver(DM, { text: "!urgent" });
    flushNow(DM);

    await sleep(WINDOW / 5);
    // The urgent message does not jump the queue — dispatching it alone would
    // orphan "earlier" behind a turn it belonged to.
    expect(dispatches).toEqual([["earlier", "!urgent"]]);
  });

  test("dropPending discards the buffer and reports the count", async () => {
    deliver(DM, { text: "a" });
    deliver(DM, { text: "b" });

    const dropped = await dropPending(DM, "stopped");
    expect(dropped).toBe(2);
    expect(hasPending(DM)).toBe(false);

    await sleep(WINDOW * 4);
    expect(dispatches).toEqual([]);
  });

  test("dropPending on an idle conversation is silent", async () => {
    expect(await dropPending(DM, "stopped")).toBe(0);
    expect(tg.replies).toEqual([]);
    expect(tg.edits).toEqual([]);
  });

  test("dropPending also discards a batch the byte cap had sealed", async () => {
    const big = "x".repeat(600);
    let release!: () => void;
    gate = new Promise<void>((r) => {
      release = r;
    });

    deliver(DM, { text: "first" });
    await sleep(WINDOW * 2); // "first" is now in flight, holding the lock
    expect(dispatches).toEqual([["first"]]);

    deliver(DM, { text: big });
    deliver(DM, { text: `${big}!` }); // seals the batch holding `big`

    expect(pendingCount(DM)).toBe(2);
    expect(await dropPending(DM, "stopped")).toBe(2);

    gate = null;
    release();
    await sleep(WINDOW * 3);
    expect(dispatches).toEqual([["first"]]);
  });
});

describe("cancelling a message that is still being prepared", () => {
  test("a transcription in flight when /stop lands never reaches Claude", async () => {
    // The handler is between beginArrival and submitPart — a voice note three
    // seconds into transcription. Dropping the buffer alone would not reach it.
    const seq = beginArrival(DM);

    expect(await dropPending(DM, "stopped")).toBe(0);

    const accepted = submitPart(ctx, DM, part({ text: "…transcribed too late", seq }));
    endArrival(DM);

    expect(accepted).toBe(false);
    await sleep(WINDOW * 4);
    expect(dispatches).toEqual([]);
  });

  test("a buffered message and one still preparing are both cancelled", async () => {
    deliver(DM, { text: "typed" });
    const slowSeq = beginArrival(DM);

    expect(await dropPending(DM, "stopped")).toBe(1); // only the visible one is counted

    expect(submitPart(ctx, DM, part({ text: "[Voice]", seq: slowSeq }))).toBe(false);
    endArrival(DM);

    await sleep(WINDOW * 4);
    expect(dispatches).toEqual([]);
  });

  test("a message that arrives after the drop is kept", async () => {
    deliver(DM, { text: "before" });
    await dropPending(DM, "stopped");

    deliver(DM, { text: "after" });

    await sleep(WINDOW * 3);
    expect(dispatches).toEqual([["after"]]);
  });
});

describe("the collecting card", () => {
  test("posted once while collecting, then relabelled with the count", async () => {
    deliver(DM, { text: "one" });
    deliver(DM, { text: "two" });

    await sleep(WINDOW * 3);

    expect(tg.replies).toEqual(["📥 Collecting…"]);
    expect(tg.edits.map((e) => e.text)).toEqual(["📥 Processing 2 messages…"]);
  });

  test("a single message gets the singular label", async () => {
    deliver(DM, { text: "alone" });
    await sleep(WINDOW * 3);

    expect(tg.edits.map((e) => e.text)).toEqual(["📥 Processing…"]);
  });

  test("dropPending edits the card into the discard notice", async () => {
    deliver(DM, { text: "a" });
    deliver(DM, { text: "b" });
    await sleep(WINDOW / 5); // let the card's own send resolve

    await dropPending(DM, "stopped");

    expect(tg.edits.map((e) => e.text)).toEqual([
      "🗑 2 unsent messages discarded — stopped.",
    ]);
    expect(tg.deleted).toEqual([]);
  });

  test("a flush racing the card's own send does not strand it", async () => {
    // The card is sent and the batch flushed in the same tick, so takeCard has
    // to await the in-flight send rather than abandon a message it has no id for.
    deliver(DM, { text: "one" });
    deliver(DM, { text: "two" });
    flushNow(DM);

    await sleep(WINDOW);

    expect(dispatches).toEqual([["one", "two"]]);
    expect(tg.replies).toEqual(["📥 Collecting…"]);
    expect(tg.edits.map((e) => e.text)).toEqual(["📥 Processing 2 messages…"]);
  });
});
