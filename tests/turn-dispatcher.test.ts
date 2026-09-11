/**
 * Unit tests for the per-conversation dispatch mutex in src/turn/dispatcher.ts.
 *
 * Run with: bun test tests/turn-dispatcher.test.ts
 *
 * The two assertions that matter most pull in opposite directions:
 *
 *   - same conversation → never overlap (that's the bug being fixed);
 *   - different conversations → DO overlap (a global mutex would serialise
 *     every forum topic behind every other and quietly undo the whole point of
 *     parallel sessions, while passing any test that only checks exclusion).
 */

import { describe, it, expect, beforeEach } from "bun:test";

import type { ConversationKey } from "../src/conversation";
import {
  runExclusive,
  isDispatching,
  ReentrantDispatchError,
  __resetDispatcherForTests,
} from "../src/turn/dispatcher";

const DM: ConversationKey = { chatId: 1, threadId: undefined };
const TOPIC_A: ConversationKey = { chatId: -100, threadId: 7 };
const TOPIC_B: ConversationKey = { chatId: -100, threadId: 8 };

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** Counts concurrent entries and records the peak. */
function makeProbe() {
  let inside = 0;
  let peak = 0;
  return {
    get peak() {
      return peak;
    },
    async body<T>(ms: number, value: T): Promise<T> {
      inside++;
      peak = Math.max(peak, inside);
      try {
        await tick(ms);
        return value;
      } finally {
        inside--;
      }
    },
  };
}

beforeEach(() => {
  __resetDispatcherForTests();
});

describe("runExclusive — exclusion per conversation", () => {
  it("never runs two entries for one conversation at the same time", async () => {
    const probe = makeProbe();
    await Promise.all([
      runExclusive(DM, () => probe.body(10, "a")),
      runExclusive(DM, () => probe.body(1, "b")),
      runExclusive(DM, () => probe.body(5, "c")),
    ]);
    expect(probe.peak).toBe(1);
  });

  it("runs entries in the order they were requested", async () => {
    const order: string[] = [];
    // Descending durations: without the mutex, "c" would finish first.
    await Promise.all([
      runExclusive(DM, async () => {
        await tick(15);
        order.push("a");
      }),
      runExclusive(DM, async () => {
        await tick(10);
        order.push("b");
      }),
      runExclusive(DM, async () => {
        await tick(1);
        order.push("c");
      }),
    ]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("returns each entry's own value to its own caller", async () => {
    const results = await Promise.all([
      runExclusive(DM, () => Promise.resolve(1)),
      runExclusive(DM, () => Promise.resolve(2)),
    ]);
    expect(results).toEqual([1, 2]);
  });

  it("lets DIFFERENT conversations overlap", async () => {
    const probe = makeProbe();
    await Promise.all([
      runExclusive(TOPIC_A, () => probe.body(10, "a")),
      runExclusive(TOPIC_B, () => probe.body(10, "b")),
      runExclusive(DM, () => probe.body(10, "c")),
    ]);
    expect(probe.peak).toBe(3);
  });

  it("treats a DM and the General topic of the same chat as one conversation", async () => {
    // convKeyFromCtx normalises General (thread_id 1) to undefined, so these two
    // keys must collide — a mismatch here would give the General topic a second,
    // concurrent lock on the same ClaudeSession.
    const probe = makeProbe();
    await Promise.all([
      runExclusive({ chatId: 5, threadId: undefined }, () => probe.body(10, "a")),
      runExclusive({ chatId: 5, threadId: undefined }, () => probe.body(10, "b")),
    ]);
    expect(probe.peak).toBe(1);
  });
});

describe("runExclusive — failures don't poison the chain", () => {
  it("rejects only the entry that threw", async () => {
    const boom = runExclusive(DM, async () => {
      throw new Error("boom");
    });
    const after = runExclusive(DM, async () => "still works");

    await expect(boom).rejects.toThrow("boom");
    expect(await after).toBe("still works");
  });

  it("keeps serialising after a throw", async () => {
    const probe = makeProbe();
    await Promise.allSettled([
      runExclusive(DM, async () => {
        await tick(5);
        throw new Error("boom");
      }),
      runExclusive(DM, () => probe.body(5, "a")),
      runExclusive(DM, () => probe.body(5, "b")),
    ]);
    expect(probe.peak).toBe(1);
  });
});

describe("runExclusive — re-entrancy is an error, not a hang", () => {
  it("throws when the same conversation is acquired from inside its own lock", async () => {
    let inner: unknown;
    await runExclusive(DM, async () => {
      await tick(1); // the nested acquire is usually behind an await, as in real code
      try {
        await runExclusive(DM, async () => "never reached");
      } catch (err) {
        inner = err;
      }
    });
    expect(inner).toBeInstanceOf(ReentrantDispatchError);
  });

  it("allows a nested acquire of a DIFFERENT conversation", async () => {
    const got = await runExclusive(TOPIC_A, () =>
      runExclusive(TOPIC_B, async () => "ok"),
    );
    expect(got).toBe("ok");
  });

  it("does not mistake a queued caller for a re-entrant one", async () => {
    // The failure mode a plain held-Set would have: caller two arrives while
    // caller one holds the lock, and gets rejected instead of queued.
    const first = runExclusive(DM, async () => {
      await tick(10);
      return "first";
    });
    const second = runExclusive(DM, async () => "second");
    expect(await Promise.all([first, second])).toEqual(["first", "second"]);
  });
});

describe("isDispatching", () => {
  it("is false when idle, true while queued or running", async () => {
    expect(isDispatching(DM)).toBe(false);

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const running = runExclusive(DM, () => gate);
    const queued = runExclusive(DM, async () => {});

    expect(isDispatching(DM)).toBe(true);
    expect(isDispatching(TOPIC_A)).toBe(false);

    release();
    await Promise.all([running, queued]);
    expect(isDispatching(DM)).toBe(false);
  });

  it("goes false again after a rejected entry", async () => {
    await runExclusive(DM, async () => {
      throw new Error("boom");
    }).catch(() => {});
    expect(isDispatching(DM)).toBe(false);
  });
});
