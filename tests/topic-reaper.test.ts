/**
 * Tests for the topic lifecycle layer:
 *   - src/session-registry.ts  — idle in-memory eviction
 *   - src/topic-reaper.ts      — the scan that drives it, plus idle auto-close
 *   - src/topics.ts            — the MAX_ACTIVE_TOPICS cap on the spawn path
 *
 * `config` is module-mocked so GROUP_CHAT_ID is set and the three lifecycle
 * knobs are short enough to trip inside a test. `topics-store` runs for real
 * against a scratch file — the reaper's whole job is reading and writing that
 * file, so stubbing it would test the stub.
 *
 * Bun's module mocks are process-wide and keyed by resolved path — they do NOT
 * end with this file. Two precautions, both load-bearing: each mock spreads the
 * real module so no export goes missing, and afterAll puts the real namespaces
 * back. (See tests/notification-new-session.test.ts for the same dance.)
 *
 * Run with: bun test tests/topic-reaper.test.ts
 */

import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Api } from "grammy";
import type { TopicEntry } from "../src/topics-store";
import type { ConversationKey } from "../src/conversation";

const GROUP = -1002222222222;
const EVICT_MINUTES = 120;
const CLOSE_DAYS = 7;
const CAP = 3;

const realConfig = { ...(await import("../src/config")) };

afterAll(() => {
  mock.module("../src/config", () => ({ ...realConfig }));
});

mock.module("../src/config", () => ({
  ...realConfig,
  GROUP_CHAT_ID: GROUP,
  SESSION_IDLE_EVICT_MINUTES: EVICT_MINUTES,
  TOPIC_IDLE_CLOSE_DAYS: CLOSE_DAYS,
  MAX_ACTIVE_TOPICS: CAP,
}));

const topicsStore = await import("../src/topics-store");
const { registry } = await import("../src/session-registry");
const { evictIdleSessions, closeIdleTopics, topicReaperTick } = await import(
  "../src/topic-reaper"
);
const { enforceTopicCap, closeTopic } = await import("../src/topics");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DIR = join(tmpdir(), `ctb-reaper-test-${process.pid}`);
let fileN = 0;

const NOW = Date.parse("2026-07-26T12:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** Records what the reaper asked Telegram to do. */
interface FakeApi {
  api: Api;
  closed: number[];
  messages: { chatId: number; text: string; threadId?: number }[];
  /** Thread ids for which closeForumTopic should throw. */
  refuse: Set<number>;
  /** Thread ids for which closeForumTopic should report "already closed". */
  alreadyClosed: Set<number>;
}

function fakeApi(): FakeApi {
  const f: FakeApi = {
    closed: [],
    messages: [],
    refuse: new Set(),
    alreadyClosed: new Set(),
    api: null as unknown as Api,
  };
  f.api = {
    closeForumTopic: async (chatId: number, threadId: number) => {
      if (f.alreadyClosed.has(threadId)) {
        throw new Error(
          `Call to 'closeForumTopic' failed! (400: Bad Request: TOPIC_ALREADY_CLOSED)`
        );
      }
      if (f.refuse.has(threadId)) {
        throw new Error(
          `Call to 'closeForumTopic' failed! (400: Bad Request: not enough rights to manage topics)`
        );
      }
      f.closed.push(threadId);
      return true;
    },
    sendMessage: async (
      chatId: number,
      text: string,
      other?: { message_thread_id?: number }
    ) => {
      f.messages.push({ chatId, text, threadId: other?.message_thread_id });
      return { message_id: 1 };
    },
    createForumTopic: async (_chatId: number, _name: string) => ({
      message_thread_id: 900 + f.closed.length,
    }),
  } as unknown as Api;
  return f;
}

function topic(threadId: number, over: Partial<TopicEntry> = {}): TopicEntry {
  return {
    thread_id: threadId,
    chat_id: GROUP,
    name: `Topic ${threadId}`,
    created_at: new Date(NOW - 30 * DAY).toISOString(),
    session_id: `sess-${threadId}`,
    last_active_at: new Date(NOW - MIN).toISOString(),
    ...over,
  };
}

/** Put a session in the registry with a controlled idle age. */
function seedSession(threadId: number, idleMs: number, running = false) {
  const key: ConversationKey = { chatId: GROUP, threadId };
  const s = registry.get(key);
  s.lastActivity = new Date(NOW - idleMs);
  // lastAccess is stamped at get() time (real Date.now(), far past NOW), so it
  // has to be pushed back too or nothing would ever look idle.
  const entries = (
    registry as unknown as {
      sessions: Map<string, { session: unknown; lastAccess: number }>;
    }
  ).sessions;
  for (const e of entries.values()) {
    if (e.session === s) e.lastAccess = NOW - idleMs;
  }
  if (running) {
    // startProcessing() flips isRunning without needing an SDK query.
    s.startProcessing();
  }
  return s;
}

function clearRegistry() {
  const entries = (registry as unknown as { sessions: Map<string, unknown> }).sessions;
  entries.clear();
}

beforeEach(async () => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  topicsStore.__setTopicsFileForTests(join(DIR, `topics-${fileN++}.json`));
  clearRegistry();
});

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Idle in-memory session eviction
// ---------------------------------------------------------------------------

describe("evictIdleSessions", () => {
  test("drops a session idle past the threshold", () => {
    seedSession(11, (EVICT_MINUTES + 1) * MIN);

    expect(evictIdleSessions(NOW)).toEqual([`${GROUP}:11`]);
    expect(registry.peek({ chatId: GROUP, threadId: 11 })).toBeUndefined();
  });

  test("keeps a session inside the threshold", () => {
    seedSession(11, (EVICT_MINUTES - 1) * MIN);

    expect(evictIdleSessions(NOW)).toEqual([]);
    expect(registry.peek({ chatId: GROUP, threadId: 11 })).toBeDefined();
  });

  test("never evicts a running session, however idle it looks", () => {
    // The dangerous case: a query has been in flight for hours (a long Task
    // run). Evicting it would orphan the claude subprocess and its callbacks.
    const s = seedSession(11, 10 * EVICT_MINUTES * MIN, true);
    expect(s.isRunning).toBe(true);

    expect(evictIdleSessions(NOW)).toEqual([]);
    expect(registry.peek({ chatId: GROUP, threadId: 11 })).toBe(s);
  });

  test("never evicts a session holding an unconsumed /compact handoff", () => {
    // The brief lives only in memory and cost the user a turn to produce.
    const s = seedSession(11, 10 * EVICT_MINUTES * MIN);
    s.pendingHandoff = "carry this forward";

    expect(evictIdleSessions(NOW)).toEqual([]);
    expect(registry.peek({ chatId: GROUP, threadId: 11 })?.pendingHandoff).toBe(
      "carry this forward"
    );
  });

  test("a never-used session is aged from when the registry handed it out, not from null", () => {
    // lastActivity is null before the first turn and again after kill(). Read
    // as "epoch" it would make every freshly spawned topic instantly evictable.
    const key: ConversationKey = { chatId: GROUP, threadId: 11 };
    const s = registry.get(key);
    expect(s.lastActivity).toBeNull();

    expect(evictIdleSessions(NOW)).toEqual([]);
    expect(registry.peek(key)).toBe(s);
  });

  test("evicting is not killing — the SDK session id survives on the instance", () => {
    // Eviction must be invisible: the instance is forgotten, never cleared, so
    // nothing on disk is invalidated and tryAutoResume can hand it straight back.
    const s = seedSession(11, (EVICT_MINUTES + 1) * MIN);
    s.sessionId = "sess-11";

    evictIdleSessions(NOW);

    expect(s.sessionId).toBe("sess-11");
  });

  test("an evicted conversation comes back on its next message", () => {
    // The claim eviction rests on. registry.get() builds a fresh instance for
    // the same key, and tryAutoResume — filtered by that key — hands the SDK
    // session straight back, so the user sees nothing.
    const key: ConversationKey = { chatId: GROUP, threadId: 11 };
    const history = {
      sessions: [
        {
          session_id: "sess-11",
          saved_at: new Date(Date.now() - 60_000).toISOString(),
          working_dir: realConfig.WORKING_DIR,
          title: "the conversation",
          chat_id: GROUP,
          thread_id: 11,
        },
      ],
    };
    const before = seedSession(11, (EVICT_MINUTES + 1) * MIN);
    before.sessionId = "sess-11";

    evictIdleSessions(NOW);

    const after = registry.get(key);
    expect(after).not.toBe(before);
    expect(after.sessionId).toBeNull();

    (after as unknown as { loadSessionHistory: () => typeof history }).loadSessionHistory =
      () => history;
    after.tryAutoResume();

    expect(after.sessionId).toBe("sess-11");
    expect(after.conversationTitle).toBe("the conversation");
  });

  test("only the idle ones go", () => {
    seedSession(11, (EVICT_MINUTES + 5) * MIN);
    seedSession(22, 1 * MIN);
    seedSession(33, (EVICT_MINUTES + 5) * MIN, true);

    expect(evictIdleSessions(NOW).sort()).toEqual([`${GROUP}:11`]);
    expect(registry.peek({ chatId: GROUP, threadId: 22 })).toBeDefined();
    expect(registry.peek({ chatId: GROUP, threadId: 33 })).toBeDefined();
  });

  test("peek does not count as activity", () => {
    // If it did, the reaper's own "is this topic busy?" check would keep alive
    // exactly the topics it is scanning to collect.
    seedSession(11, (EVICT_MINUTES + 1) * MIN);

    registry.peek({ chatId: GROUP, threadId: 11 });

    expect(evictIdleSessions(NOW)).toEqual([`${GROUP}:11`]);
  });
});

// ---------------------------------------------------------------------------
// 2. Idle topic auto-close
// ---------------------------------------------------------------------------

describe("closeIdleTopics", () => {
  test("closes a topic past TOPIC_IDLE_CLOSE_DAYS and marks the store", async () => {
    await topicsStore.upsert(
      topic(11, { last_active_at: new Date(NOW - (CLOSE_DAYS + 1) * DAY).toISOString() })
    );
    const f = fakeApi();

    expect(await closeIdleTopics(f.api, NOW)).toBe(1);
    expect(f.closed).toEqual([11]);
    expect((await topicsStore.get(11))!.closed).toBe(true);
  });

  test("posts the notice into the topic BEFORE closing it", async () => {
    // A closed topic may refuse new messages, and the note is the only place
    // the user learns the conversation is still resumable.
    await topicsStore.upsert(
      topic(11, { last_active_at: new Date(NOW - (CLOSE_DAYS + 1) * DAY).toISOString() })
    );
    const f = fakeApi();
    const order: string[] = [];
    const realClose = f.api.closeForumTopic.bind(f.api);
    const realSend = f.api.sendMessage.bind(f.api);
    (f.api as unknown as Record<string, unknown>).closeForumTopic = async (
      ...a: unknown[]
    ) => {
      order.push("close");
      return (realClose as (...x: unknown[]) => unknown)(...a);
    };
    (f.api as unknown as Record<string, unknown>).sendMessage = async (
      ...a: unknown[]
    ) => {
      order.push("notice");
      return (realSend as (...x: unknown[]) => unknown)(...a);
    };

    await closeIdleTopics(f.api, NOW);

    expect(order).toEqual(["notice", "close"]);
    expect(f.messages[0]!.threadId).toBe(11);
    expect(f.messages[0]!.text).toContain("Reopen it");
  });

  test("leaves a topic inside the window alone", async () => {
    await topicsStore.upsert(
      topic(11, { last_active_at: new Date(NOW - (CLOSE_DAYS - 1) * DAY).toISOString() })
    );
    const f = fakeApi();

    expect(await closeIdleTopics(f.api, NOW)).toBe(0);
    expect(f.closed).toEqual([]);
  });

  test("skips topics already marked closed", async () => {
    await topicsStore.upsert(
      topic(11, {
        closed: true,
        last_active_at: new Date(NOW - 90 * DAY).toISOString(),
      })
    );
    const f = fakeApi();

    expect(await closeIdleTopics(f.api, NOW)).toBe(0);
    expect(f.closed).toEqual([]);
    // And no courtesy note into a topic that is already gone.
    expect(f.messages).toEqual([]);
  });

  test("never closes a topic with a query in flight", async () => {
    await topicsStore.upsert(
      topic(11, { last_active_at: new Date(NOW - 90 * DAY).toISOString() })
    );
    seedSession(11, 90 * DAY, true);
    const f = fakeApi();

    expect(await closeIdleTopics(f.api, NOW)).toBe(0);
    expect(f.closed).toEqual([]);
  });

  test("leaves a topic with an unparseable last_active_at alone", async () => {
    // Deciding to take something away from the user on the strength of a
    // corrupted field is the wrong default.
    await topicsStore.upsert(topic(11, { last_active_at: "not a date" }));
    const f = fakeApi();

    expect(await closeIdleTopics(f.api, NOW)).toBe(0);
  });

  test("a Telegram refusal leaves the store untouched", async () => {
    await topicsStore.upsert(
      topic(11, { last_active_at: new Date(NOW - 90 * DAY).toISOString() })
    );
    const f = fakeApi();
    f.refuse.add(11);

    expect(await closeIdleTopics(f.api, NOW)).toBe(0);
    expect((await topicsStore.get(11))!.closed).toBeUndefined();
  });

  test("an already-closed topic is reconciled instead of retried forever", async () => {
    await topicsStore.upsert(
      topic(11, { last_active_at: new Date(NOW - 90 * DAY).toISOString() })
    );
    const f = fakeApi();
    f.alreadyClosed.add(11);

    expect(await closeIdleTopics(f.api, NOW)).toBe(1);
    expect((await topicsStore.get(11))!.closed).toBe(true);
  });

  test("evicts the closed topic's session too", async () => {
    await topicsStore.upsert(
      topic(11, { last_active_at: new Date(NOW - 90 * DAY).toISOString() })
    );
    seedSession(11, 1 * MIN);
    const f = fakeApi();

    await closeIdleTopics(f.api, NOW);

    expect(registry.peek({ chatId: GROUP, threadId: 11 })).toBeUndefined();
  });

  test("TOPIC_IDLE_CLOSE_DAYS=0 disables auto-close entirely", async () => {
    mock.module("../src/config", () => ({
      ...realConfig,
      GROUP_CHAT_ID: GROUP,
      SESSION_IDLE_EVICT_MINUTES: EVICT_MINUTES,
      TOPIC_IDLE_CLOSE_DAYS: 0,
      MAX_ACTIVE_TOPICS: CAP,
    }));
    const { closeIdleTopics: disabled } = await import("../src/topic-reaper");

    try {
      await topicsStore.upsert(
        topic(11, { last_active_at: new Date(NOW - 900 * DAY).toISOString() })
      );
      const f = fakeApi();

      expect(await disabled(f.api, NOW)).toBe(0);
      expect(f.closed).toEqual([]);
    } finally {
      mock.module("../src/config", () => ({
        ...realConfig,
        GROUP_CHAT_ID: GROUP,
        SESSION_IDLE_EVICT_MINUTES: EVICT_MINUTES,
        TOPIC_IDLE_CLOSE_DAYS: CLOSE_DAYS,
        MAX_ACTIVE_TOPICS: CAP,
      }));
    }
  });
});

// ---------------------------------------------------------------------------
// 3. MAX_ACTIVE_TOPICS cap
// ---------------------------------------------------------------------------

describe("enforceTopicCap", () => {
  async function seedTopics(n: number, idleDaysByThread: Record<number, number> = {}) {
    for (let i = 1; i <= n; i++) {
      const id = i * 11;
      await topicsStore.upsert(
        topic(id, {
          last_active_at: new Date(
            NOW - (idleDaysByThread[id] ?? i) * DAY
          ).toISOString(),
        })
      );
    }
  }

  test("does nothing while there is room", async () => {
    await seedTopics(CAP - 1);
    const f = fakeApi();

    await enforceTopicCap(f.api, NOW);

    expect(f.closed).toEqual([]);
  });

  test("closes the oldest-idle topic when the cap would be exceeded", async () => {
    // thread 11 idle 1d, 22 idle 2d, 33 idle 3d → 33 goes.
    await seedTopics(CAP);
    const f = fakeApi();

    await enforceTopicCap(f.api, NOW);

    expect(f.closed).toEqual([33]);
    expect((await topicsStore.get(33))!.closed).toBe(true);
    expect((await topicsStore.get(11))!.closed).toBeUndefined();
  });

  test("tells the topic why it's being closed before closing it", async () => {
    await seedTopics(CAP);
    const f = fakeApi();

    await enforceTopicCap(f.api, NOW);

    expect(f.messages.length).toBe(1);
    expect(f.messages[0]!.threadId).toBe(33);
    expect(f.messages[0]!.text).toContain(`${CAP}-topic limit`);
  });

  test("closed topics don't count toward the cap", async () => {
    await seedTopics(CAP);
    await topicsStore.markClosed(33);
    const f = fakeApi();

    await enforceTopicCap(f.api, NOW);

    expect(f.closed).toEqual([]);
  });

  test("never closes a topic with a running session", async () => {
    await seedTopics(CAP);
    seedSession(33, 3 * DAY, true); // the oldest-idle one is busy
    const f = fakeApi();

    await enforceTopicCap(f.api, NOW);

    expect(f.closed).toEqual([22]); // next oldest instead
  });

  test("refuses the spawn rather than exceeding the cap when everything is busy", async () => {
    await seedTopics(CAP);
    for (const id of [11, 22, 33]) seedSession(id, 3 * DAY, true);
    const f = fakeApi();

    await expect(enforceTopicCap(f.api, NOW)).rejects.toThrow(/every topic has a query running/);
    expect(f.closed).toEqual([]);
  });

  test("frees several at once when the store is already over the cap", async () => {
    await seedTopics(CAP + 2); // 5 open, cap 3 → must close 3 to leave room for 1
    const f = fakeApi();

    await enforceTopicCap(f.api, NOW);

    expect(f.closed.sort((a, b) => a - b)).toEqual([33, 44, 55]);
  });

  test("a refused close fails the spawn instead of silently over-running", async () => {
    await seedTopics(CAP);
    const f = fakeApi();
    f.refuse.add(33);

    await expect(enforceTopicCap(f.api, NOW)).rejects.toThrow(/couldn't be closed/);
  });

  test("MAX_ACTIVE_TOPICS=0 disables the cap", async () => {
    mock.module("../src/config", () => ({
      ...realConfig,
      GROUP_CHAT_ID: GROUP,
      SESSION_IDLE_EVICT_MINUTES: EVICT_MINUTES,
      TOPIC_IDLE_CLOSE_DAYS: CLOSE_DAYS,
      MAX_ACTIVE_TOPICS: 0,
    }));
    const { enforceTopicCap: uncapped } = await import("../src/topics");

    try {
      await seedTopics(CAP + 3);
      const f = fakeApi();

      await uncapped(f.api, NOW);

      expect(f.closed).toEqual([]);
    } finally {
      mock.module("../src/config", () => ({
        ...realConfig,
        GROUP_CHAT_ID: GROUP,
        SESSION_IDLE_EVICT_MINUTES: EVICT_MINUTES,
        TOPIC_IDLE_CLOSE_DAYS: CLOSE_DAYS,
        MAX_ACTIVE_TOPICS: CAP,
      }));
    }
  });
});

// ---------------------------------------------------------------------------
// 4. closeTopic, the shared primitive
// ---------------------------------------------------------------------------

describe("closeTopic", () => {
  test("closes, evicts the session, and marks the store — in that order of effect", async () => {
    await topicsStore.upsert(topic(11));
    seedSession(11, 1 * MIN);
    const f = fakeApi();

    const res = await closeTopic(f.api, { chat_id: GROUP, thread_id: 11 }, "user");

    expect(res.ok).toBe(true);
    expect(f.closed).toEqual([11]);
    expect(registry.peek({ chatId: GROUP, threadId: 11 })).toBeUndefined();
    expect((await topicsStore.get(11))!.closed).toBe(true);
  });

  test("a refusal changes nothing locally", async () => {
    // A store that claims "closed" about a topic the user can still type in is
    // worse than one that is merely out of date.
    await topicsStore.upsert(topic(11));
    const s = seedSession(11, 1 * MIN);
    const f = fakeApi();
    f.refuse.add(11);

    const res = await closeTopic(f.api, { chat_id: GROUP, thread_id: 11 }, "user");

    expect(res.ok).toBe(false);
    expect(res.error).toContain("not enough rights");
    expect(registry.peek({ chatId: GROUP, threadId: 11 })).toBe(s);
    expect((await topicsStore.get(11))!.closed).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. The tick, and the flag-off gate
// ---------------------------------------------------------------------------

describe("topicReaperTick", () => {
  test("does both jobs in one pass", async () => {
    await topicsStore.upsert(
      topic(11, { last_active_at: new Date(NOW - 90 * DAY).toISOString() })
    );
    seedSession(22, (EVICT_MINUTES + 1) * MIN);
    const f = fakeApi();

    await topicReaperTick(f.api, NOW);

    expect(f.closed).toEqual([11]);
    expect(registry.peek({ chatId: GROUP, threadId: 22 })).toBeUndefined();
  });
});

describe("with TELEGRAM_GROUP_CHAT_ID unset", () => {
  test("every job is a no-op", async () => {
    mock.module("../src/config", () => ({ ...realConfig, GROUP_CHAT_ID: null }));
    const off = await import("../src/topic-reaper");
    const offTopics = await import("../src/topics");

    try {
      await topicsStore.upsert(
        topic(11, { last_active_at: new Date(NOW - 900 * DAY).toISOString() })
      );
      seedSession(11, 900 * DAY);
      const f = fakeApi();

      expect(off.evictIdleSessions(NOW)).toEqual([]);
      expect(await off.closeIdleTopics(f.api, NOW)).toBe(0);
      await off.topicReaperTick(f.api, NOW);
      off.startTopicReaper(f.api);

      expect(f.closed).toEqual([]);
      expect(registry.peek({ chatId: GROUP, threadId: 11 })).toBeDefined();

      // The cap is the exception that proves the rule: it can only run from
      // spawnTopicSession, which itself refuses before this point when the flag
      // is off, so it is gated one level up rather than here.
      expect(typeof offTopics.enforceTopicCap).toBe("function");
    } finally {
      mock.module("../src/config", () => ({
        ...realConfig,
        GROUP_CHAT_ID: GROUP,
        SESSION_IDLE_EVICT_MINUTES: EVICT_MINUTES,
        TOPIC_IDLE_CLOSE_DAYS: CLOSE_DAYS,
        MAX_ACTIVE_TOPICS: CAP,
      }));
    }
  });
});
