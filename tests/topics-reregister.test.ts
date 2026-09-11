/**
 * Tests for `reregisterTopics` (src/topics.ts) — the boot path that hands an
 * open forum topic its SDK session back after a restart.
 *
 * It exists for exactly one case: a topic whose history entries have been
 * pruned away, leaving topics.json as the only record the conversation ever
 * happened. Everything else must be left to `tryAutoResume`, which runs when
 * the user actually posts and therefore judges the TTL and "newest wins"
 * against that moment rather than against boot. Getting that boundary wrong is
 * not a no-op: topics.json records the session id at *spawn*, so adopting it
 * unconditionally would resurrect a conversation the user abandoned with /new.
 *
 * `config` (for GROUP_CHAT_ID), `topics-store` and `session-registry` are
 * module-mocked; the ClaudeSession instances behind the fake registry are REAL,
 * with only their history stubbed, so `getSessionList` and `adoptSession` are
 * the genuine implementations rather than restatements of them.
 *
 * Bun's module mocks are process-wide and keyed by resolved path — they do NOT
 * end with this file. Two precautions, both load-bearing: each mock spreads the
 * real module so no export goes missing, and afterAll puts the real namespaces
 * back. (See tests/notification-new-session.test.ts for the same dance.)
 *
 * Run with: bun test tests/topics-reregister.test.ts
 */

import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import type { ConversationKey } from "../src/conversation";
import { convKeyStr } from "../src/conversation";
import type { SavedSession, SessionHistory } from "../src/types";
import type { TopicEntry } from "../src/topics-store";

const GROUP = -1002222222222;

// Snapshots, not the namespace objects: mock.module mutates the live namespace,
// so holding a reference would hand back the mocked functions in afterAll.
const realConfig = { ...(await import("../src/config")) };
const realTopicsStore = { ...(await import("../src/topics-store")) };
const realRegistry = { ...(await import("../src/session-registry")) };

afterAll(() => {
  mock.module("../src/config", () => ({ ...realConfig }));
  mock.module("../src/topics-store", () => ({ ...realTopicsStore }));
  mock.module("../src/session-registry", () => ({ ...realRegistry }));
});

// The whole point of the mock: GROUP_CHAT_ID is parsed from env at import time,
// and the test env has no TELEGRAM_GROUP_CHAT_ID, so reregisterTopics would
// return 0 on its first line.
mock.module("../src/config", () => ({ ...realConfig, GROUP_CHAT_ID: GROUP }));

let entries: TopicEntry[] = [];
mock.module("../src/topics-store", () => ({
  ...realTopicsStore,
  list: async () => entries,
}));

const { ClaudeSession } = await import("../src/session");

/** Real ClaudeSession, fixed history, no disk. */
function sessionWith(key: ConversationKey, history: SavedSession[]) {
  const s = new ClaudeSession({ key });
  (
    s as unknown as { loadSessionHistory: () => SessionHistory }
  ).loadSessionHistory = () => ({ sessions: history });
  return s;
}

const sessions = new Map<string, ReturnType<typeof sessionWith>>();
mock.module("../src/session-registry", () => ({
  ...realRegistry,
  registry: {
    get: (key: ConversationKey) => {
      const k = convKeyStr(key);
      let s = sessions.get(k);
      if (!s) {
        s = sessionWith(key, []);
        sessions.set(k, s);
      }
      return s;
    },
    kill: async () => {},
    isAnyRunning: () => false,
  },
}));

const { reregisterTopics } = await import("../src/topics");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-07-26T12:00:00Z");
const HOUR = 3_600_000;

function topic(overrides: Partial<TopicEntry> & { thread_id: number }): TopicEntry {
  return {
    chat_id: GROUP,
    name: `Topic ${overrides.thread_id}`,
    created_at: new Date(NOW - 2 * HOUR).toISOString(),
    session_id: `sess-${overrides.thread_id}`,
    last_active_at: new Date(NOW - HOUR).toISOString(),
    ...overrides,
  };
}

function saved(id: string, threadId: number): SavedSession {
  return {
    session_id: id,
    saved_at: new Date(NOW - HOUR).toISOString(),
    working_dir: realConfig.WORKING_DIR,
    title: `title for ${id}`,
    chat_id: GROUP,
    thread_id: threadId,
  };
}

/** Seed the registry with a real session carrying a fixed history. */
function seed(threadId: number, history: SavedSession[]) {
  const key: ConversationKey = { chatId: GROUP, threadId };
  const s = sessionWith(key, history);
  sessions.set(convKeyStr(key), s);
  return s;
}

beforeEach(() => {
  entries = [];
  sessions.clear();
});

// ---------------------------------------------------------------------------

describe("reregisterTopics", () => {
  test("adopts the recorded session when the history has been pruned away", async () => {
    // The gap this function exists for: topics.json still knows, the history
    // no longer does, so tryAutoResume would find nothing and start fresh.
    entries = [topic({ thread_id: 11 })];
    const s = seed(11, []);

    expect(await reregisterTopics(NOW)).toBe(1);
    expect(s.sessionId).toBe("sess-11");
    expect(s.conversationTitle).toBe("Topic 11");

    // Idempotent: a second call finds the session already adopted and does not
    // double-count or re-point it.
    expect(await reregisterTopics(NOW)).toBe(0);
    expect(s.sessionId).toBe("sess-11");
  });

  test("skips a topic whose history still has entries — auto-resume owns that", async () => {
    // topics.json records the id at spawn only. Here the user later ran /new
    // and started sess-11b; adopting the recorded sess-11 would resurrect the
    // abandoned conversation and block the right one.
    entries = [topic({ thread_id: 11, session_id: "sess-11" })];
    const s = seed(11, [saved("sess-11b", 11)]);

    expect(await reregisterTopics(NOW)).toBe(0);
    expect(s.sessionId).toBeNull(); // left for tryAutoResume at message time
  });

  test("skips closed topics", async () => {
    entries = [topic({ thread_id: 11, closed: true })];
    const s = seed(11, []);

    expect(await reregisterTopics(NOW)).toBe(0);
    expect(s.sessionId).toBeNull();
  });

  test("skips a topic that never reached an SDK session", async () => {
    entries = [topic({ thread_id: 11, session_id: null })];
    const s = seed(11, []);

    expect(await reregisterTopics(NOW)).toBe(0);
    expect(s.sessionId).toBeNull();
  });

  test("re-registers a topic idle past the DM window but inside the topic one", async () => {
    // 48h is beyond AUTO_RESUME_TTL_HOURS (24) and well inside
    // TOPIC_AUTO_RESUME_TTL_HOURS (720). Reading the DM window here is the bug
    // this covers: boot would retire a topic that tryAutoResume then resumes
    // from history, so the same conversation continued or not depending purely
    // on whether the bot had restarted since.
    entries = [
      topic({
        thread_id: 11,
        last_active_at: new Date(NOW - 48 * HOUR).toISOString(),
      }),
    ];
    const s = seed(11, []);

    expect(await reregisterTopics(NOW)).toBe(1);
    expect(s.sessionId).toBe("sess-11");
  });

  test("skips a topic idle beyond the topic auto-resume TTL", async () => {
    entries = [
      topic({
        thread_id: 11,
        last_active_at: new Date(NOW - 800 * HOUR).toISOString(),
      }),
    ];
    const s = seed(11, []);

    expect(await reregisterTopics(NOW)).toBe(0);
    expect(s.sessionId).toBeNull();
  });

  test("skips a topic with an unparseable last_active_at rather than adopting blindly", async () => {
    entries = [topic({ thread_id: 11, last_active_at: "not a date" })];
    const s = seed(11, []);

    expect(await reregisterTopics(NOW)).toBe(0);
    expect(s.sessionId).toBeNull();
  });

  test("never clobbers a live session", async () => {
    // The instance is already mid-conversation (a reaper-evicted key that came
    // back, or a double call). adoptSession must refuse.
    entries = [topic({ thread_id: 11, session_id: "sess-recorded" })];
    const s = seed(11, []);
    s.sessionId = "sess-live";

    expect(await reregisterTopics(NOW)).toBe(0);
    expect(s.sessionId).toBe("sess-live");
  });

  test("refuses a recorded session the history marks as errored", async () => {
    // getSessionList drops errored entries, so the history reads as empty and
    // we reach adoptSession — which must still refuse, since resuming an
    // errored session just reproduces the failure.
    entries = [topic({ thread_id: 11, session_id: "sess-bad" })];
    const s = seed(11, [{ ...saved("sess-bad", 11), errored: true }]);

    expect(await reregisterTopics(NOW)).toBe(0);
    expect(s.sessionId).toBeNull();
  });

  test("handles several topics independently", async () => {
    entries = [
      topic({ thread_id: 11 }), // pruned history -> adopt
      topic({ thread_id: 22 }), // has history    -> skip
      topic({ thread_id: 33, closed: true }), // closed -> skip
    ];
    const a = seed(11, []);
    const b = seed(22, [saved("sess-22", 22)]);
    const c = seed(33, []);

    expect(await reregisterTopics(NOW)).toBe(1);
    expect(a.sessionId).toBe("sess-11");
    expect(b.sessionId).toBeNull();
    expect(c.sessionId).toBeNull();
  });

  test("a store read failure is contained, not thrown at boot", async () => {
    mock.module("../src/topics-store", () => ({
      ...realTopicsStore,
      list: async () => {
        throw new Error("disk on fire");
      },
    }));

    expect(await reregisterTopics(NOW)).toBe(0);

    mock.module("../src/topics-store", () => ({
      ...realTopicsStore,
      list: async () => entries,
    }));
  });
});
