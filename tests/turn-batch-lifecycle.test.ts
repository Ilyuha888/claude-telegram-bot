/**
 * The lifecycle layer vs. a conversation that is mid-burst.
 *
 * Both reapers judge idleness from things the collector doesn't touch:
 * `session.isRunning` and `topics.json`'s `last_active_at`. A conversation
 * collecting a burst has no running query — that is what the collection window
 * *is* — and `last_active_at` isn't written until the turn starts. So without
 * an explicit pin, both would act on a conversation in the middle of a user's
 * forward: the session evicted out from under a batch about to dispatch, or the
 * topic closed while messages for it sit in a buffer.
 *
 * The pin is passed *down* from the reaper rather than read by the registry:
 * `collector → dispatcher → session-registry` already exists, so the reverse
 * import would close a cycle.
 *
 * Run with: bun test tests/turn-batch-lifecycle.test.ts
 */

import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Api, Context } from "grammy";
import type { ConversationKey } from "../src/conversation";
import type { TopicEntry } from "../src/topics-store";
import type { TurnPart } from "../src/turn/part";

const GROUP = -1002222222222;
const EVICT_MINUTES = 120;
const CLOSE_DAYS = 7;

const realConfig = { ...(await import("../src/config")) };

afterAll(() => {
  mock.module("../src/config", () => ({ ...realConfig }));
});

mock.module("../src/config", () => ({
  ...realConfig,
  GROUP_CHAT_ID: GROUP,
  SESSION_IDLE_EVICT_MINUTES: EVICT_MINUTES,
  TOPIC_IDLE_CLOSE_DAYS: CLOSE_DAYS,
  // Long enough that nothing dispatches on its own during a test, and no card
  // is posted to a fake api that doesn't expect one.
  TURN_BATCH_WINDOW_MS: 60_000,
  TURN_BATCH_MAX_WAIT_MS: 60_000,
  TURN_BATCH_CARD: "off",
}));

const topicsStore = await import("../src/topics-store");
const { registry } = await import("../src/session-registry");
const collector = await import("../src/turn/collector");
const { evictIdleSessions, closeIdleTopics } = await import("../src/topic-reaper");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DIR = join(tmpdir(), `ctb-batch-lifecycle-test-${process.pid}`);
let fileN = 0;

const NOW = Date.parse("2026-07-30T12:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function fakeCtx(): Context {
  return {
    api: {} as Api,
    chat: { id: GROUP },
    message: { message_id: 1 },
    reply: async () => ({ message_id: 2, chat: { id: GROUP } }),
  } as unknown as Context;
}

function part(seq: number, over: Partial<TurnPart> = {}): TurnPart {
  return {
    kind: "text",
    seq,
    text: "hello",
    media: [],
    audit: { kind: "TEXT", summary: "hello" },
    titleSeed: "hello",
    bytes: 5,
    ...over,
  };
}

/** A message that has arrived and been buffered, but not yet dispatched. */
function buffer(key: ConversationKey): void {
  const seq = collector.beginArrival(key);
  collector.submitPart(fakeCtx(), key, part(seq));
  collector.endArrival(key);
}

function seedSession(threadId: number, idleMs: number) {
  const key: ConversationKey = { chatId: GROUP, threadId };
  const s = registry.get(key);
  s.lastActivity = new Date(NOW - idleMs);
  const entries = (
    registry as unknown as {
      sessions: Map<string, { session: unknown; lastAccess: number }>;
    }
  ).sessions;
  for (const e of entries.values()) {
    if (e.session === s) e.lastAccess = NOW - idleMs;
  }
  return s;
}

function clearRegistry() {
  (registry as unknown as { sessions: Map<string, unknown> }).sessions.clear();
}

interface FakeApi {
  api: Api;
  closed: number[];
}

function fakeApi(): FakeApi {
  const f: FakeApi = { closed: [], api: null as unknown as Api };
  f.api = {
    closeForumTopic: async (_chatId: number, threadId: number) => {
      f.closed.push(threadId);
      return true;
    },
    sendMessage: async () => ({ message_id: 1 }),
  } as unknown as Api;
  return f;
}

function topic(threadId: number, idleMs: number): TopicEntry {
  return {
    thread_id: threadId,
    chat_id: GROUP,
    name: `Topic ${threadId}`,
    created_at: new Date(NOW - 30 * DAY).toISOString(),
    session_id: `sess-${threadId}`,
    last_active_at: new Date(NOW - idleMs).toISOString(),
  };
}

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  topicsStore.__setTopicsFileForTests(join(DIR, `topics-${fileN++}.json`));
  clearRegistry();
  collector.__resetCollectorForTests();
  // Nothing in this file should reach a real turn; if the window ever changes
  // out from under the fixture, this fails loudly instead of spawning Claude.
  collector.__setRunTurnForTests(async () => {
    throw new Error("runTurn must not be reached by a lifecycle test");
  });
});

afterAll(() => {
  collector.__resetCollectorForTests();
  rmSync(DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("idle session eviction vs a pending burst", () => {
  test("a conversation holding buffered messages is not evicted", () => {
    const key: ConversationKey = { chatId: GROUP, threadId: 11 };
    seedSession(11, (EVICT_MINUTES + 1) * MIN);
    buffer(key);

    expect(collector.pendingCount(key)).toBe(1);
    expect(evictIdleSessions(NOW)).toEqual([]);
    expect(registry.peek(key)).toBeDefined();
  });

  test("a conversation with a message still being prepared is not evicted", () => {
    // The case no other check can see: a voice note six seconds into
    // transcription has nothing buffered, no running query, and a session whose
    // last turn was hours ago.
    const key: ConversationKey = { chatId: GROUP, threadId: 11 };
    seedSession(11, (EVICT_MINUTES + 1) * MIN);
    collector.beginArrival(key);

    expect(collector.pendingCount(key)).toBe(0);
    expect(evictIdleSessions(NOW)).toEqual([]);
    expect(registry.peek(key)).toBeDefined();

    collector.endArrival(key);
  });

  test("the pin lifts once the buffer is drained", async () => {
    const key: ConversationKey = { chatId: GROUP, threadId: 11 };
    seedSession(11, (EVICT_MINUTES + 1) * MIN);
    buffer(key);
    expect(evictIdleSessions(NOW)).toEqual([]);

    await collector.dropPending(key, "test");

    expect(evictIdleSessions(NOW)).toEqual([`${GROUP}:11`]);
    expect(registry.peek(key)).toBeUndefined();
  });

  test("only the collecting conversation is pinned", () => {
    // A single global flag here would freeze eviction for every topic whenever
    // any one of them was mid-burst.
    const busy: ConversationKey = { chatId: GROUP, threadId: 11 };
    seedSession(11, (EVICT_MINUTES + 1) * MIN);
    seedSession(12, (EVICT_MINUTES + 1) * MIN);
    buffer(busy);

    expect(evictIdleSessions(NOW)).toEqual([`${GROUP}:12`]);
    expect(registry.peek(busy)).toBeDefined();
  });
});

describe("idle topic auto-close vs a pending burst", () => {
  test("a topic collecting a burst is left open", async () => {
    const f = fakeApi();
    await topicsStore.upsert(topic(11, (CLOSE_DAYS + 1) * DAY));
    buffer({ chatId: GROUP, threadId: 11 });

    expect(await closeIdleTopics(f.api, NOW)).toBe(0);
    expect(f.closed).toEqual([]);
    expect((await topicsStore.get(11))?.closed).toBeFalsy();
  });

  test("the same topic closes once nothing is pending", async () => {
    const f = fakeApi();
    await topicsStore.upsert(topic(11, (CLOSE_DAYS + 1) * DAY));

    expect(await closeIdleTopics(f.api, NOW)).toBe(1);
    expect(f.closed).toEqual([11]);
  });
});
