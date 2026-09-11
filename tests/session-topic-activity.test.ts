/**
 * Tests for the per-turn bookkeeping a topic's session owes topics.json:
 * `last_active_at` on every turn, and `session_id` on every new session.
 *
 * This is the choke point the whole lifecycle layer stands on. Until it
 * existed, `last_active_at` was written once at spawn and never again, so
 * "idle for 7 days" actually meant "created 7 days ago" and the reaper would
 * close topics mid-conversation.
 *
 * A turn is driven for real through `sendMessageStreaming` with the Agent SDK's
 * `query` module-mocked to yield a scripted event stream. Asserting on the
 * private helpers alone would prove they work and not that anything calls them,
 * which was precisely the old bug.
 *
 * Bun's module mocks are process-wide and keyed by resolved path — they do NOT
 * end with this file. Two precautions, both load-bearing: the mock spreads the
 * real module so no export goes missing, and afterAll puts the real namespace
 * back. (See tests/notification-new-session.test.ts for the same dance.)
 *
 * Run with: bun test tests/session-topic-activity.test.ts
 */

import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ConversationKey } from "../src/conversation";
import type { TopicEntry } from "../src/topics-store";

const GROUP = -1002222222222;

const realSdk = { ...(await import("@anthropic-ai/claude-agent-sdk")) };

afterAll(() => {
  mock.module("@anthropic-ai/claude-agent-sdk", () => ({ ...realSdk }));
});

/** Event stream the next query() call will replay. */
let events: Record<string, unknown>[] = [];
let queryCalls = 0;

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  ...realSdk,
  query: () => {
    queryCalls++;
    const scripted = events;
    return {
      async *[Symbol.asyncIterator]() {
        for (const e of scripted) yield e;
      },
    };
  },
}));

const topicsStore = await import("../src/topics-store");
const sessionStore = await import("../src/session-store");
const { ClaudeSession } = await import("../src/session");

// ---------------------------------------------------------------------------

const DIR = join(tmpdir(), `ctb-topic-activity-test-${process.pid}`);
let n = 0;

const SPAWNED_AT = "2026-07-20T10:00:00.000Z";

function topic(threadId: number, over: Partial<TopicEntry> = {}): TopicEntry {
  return {
    thread_id: threadId,
    chat_id: GROUP,
    name: `Topic ${threadId}`,
    created_at: SPAWNED_AT,
    session_id: null,
    last_active_at: SPAWNED_AT,
    ...over,
  };
}

/** Run one turn to completion. `sessionId` is what the SDK reports back. */
async function runTurn(
  key: ConversationKey | undefined,
  opts: { sessionId?: string; persist?: boolean } = {}
) {
  events = [
    { type: "system", subtype: "init", session_id: opts.sessionId ?? "sess-1" },
    {
      type: "assistant",
      session_id: opts.sessionId ?? "sess-1",
      message: { content: [{ type: "text", text: "hi" }] },
    },
    { type: "result", subtype: "success", session_id: opts.sessionId ?? "sess-1" },
  ];
  const s = new ClaudeSession({ key, persist: opts.persist });
  // Empty history, so tryAutoResume can never fire. Without this the session id
  // is sometimes already set when the first SDK event arrives — a previous
  // test's fire-and-forget saveSession landing in this test's history file —
  // and `noteTopicSession` correctly declines to re-record an unchanged id,
  // failing the test for a reason that has nothing to do with the code.
  (s as unknown as { loadSessionHistory: () => { sessions: [] } }).loadSessionHistory =
    () => ({ sessions: [] });
  // No chatId and no ctx: the MCP delivery plumbing and the post-result sweeps
  // are all gated on them, so the turn reduces to exactly what's under test.
  await s.sendMessageStreaming("hello", "tester", 42, async () => {});
  return s;
}

/** The store writes are fire-and-forget; let the queue drain. */
async function settle() {
  await topicsStore.list();
  await Bun.sleep(5);
  await topicsStore.list();
}

// Created once, not per test: `saveSession` is fire-and-forget, so a write
// from the previous test can still be in flight when the next one starts.
// Fresh *filenames* isolate the tests; deleting the directory under an
// in-flight rename just produces ENOENT noise.
mkdirSync(DIR, { recursive: true });

beforeEach(async () => {
  // Let the previous test's fire-and-forget writes land in the previous test's
  // files, before the names rotate underneath them.
  await Bun.sleep(10);
  topicsStore.__setTopicsFileForTests(join(DIR, `topics-${n}.json`));
  sessionStore.__setSessionFileForTests(join(DIR, `history-${n}.json`));
  n++;
  queryCalls = 0;
});

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("last_active_at on every turn", () => {
  test("a turn in a topic bumps it off the spawn timestamp", async () => {
    await topicsStore.upsert(topic(11));

    await runTurn({ chatId: GROUP, threadId: 11 });
    await settle();

    const t = (await topicsStore.get(11))!;
    expect(t.last_active_at).not.toBe(SPAWNED_AT);
    expect(Date.parse(t.last_active_at)).toBeGreaterThan(Date.parse(SPAWNED_AT));
    // Only that field moves.
    expect(t.created_at).toBe(SPAWNED_AT);
  });

  test("only the conversation's own topic is touched", async () => {
    await topicsStore.upsert(topic(11));
    await topicsStore.upsert(topic(22));

    await runTurn({ chatId: GROUP, threadId: 11 });
    await settle();

    expect((await topicsStore.get(22))!.last_active_at).toBe(SPAWNED_AT);
  });

  test("a DM or General turn touches nothing — there is no topic", async () => {
    await topicsStore.upsert(topic(11));

    await runTurn({ chatId: GROUP, threadId: undefined });
    await settle();

    expect((await topicsStore.get(11))!.last_active_at).toBe(SPAWNED_AT);
  });

  test("the scheduler's keyless ephemeral session touches nothing", async () => {
    await topicsStore.upsert(topic(11));

    const s = await runTurn(undefined, { persist: false });
    await settle();

    expect(s.convKey).toBeUndefined();
    expect((await topicsStore.get(11))!.last_active_at).toBe(SPAWNED_AT);
  });

  test("a turn in a topic the store has never heard of is a silent no-op", async () => {
    await runTurn({ chatId: GROUP, threadId: 999 });
    await settle();

    expect(await topicsStore.list()).toEqual([]);
  });

  test("a store failure costs a timer, not the message", async () => {
    // The user's turn must complete even if topics.json is unwritable.
    await topicsStore.upsert(topic(11));
    topicsStore.__setTopicsFileForTests("/proc/definitely/not/writable/topics.json");

    const s = await runTurn({ chatId: GROUP, threadId: 11 });
    await Bun.sleep(5);

    expect(s.sessionId).toBe("sess-1");
    expect(queryCalls).toBe(1);
  });

  test("it fires before the answer, not after", async () => {
    // A turn can run for minutes; a reaper tick landing mid-turn must not read
    // the topic as idle since the previous message.
    await topicsStore.upsert(topic(11));
    const seen: string[] = [];

    events = [
      { type: "system", subtype: "init", session_id: "sess-1" },
      { type: "result", subtype: "success", session_id: "sess-1" },
    ];
    const s = new ClaudeSession({ key: { chatId: GROUP, threadId: 11 } });
    const turn = s.sendMessageStreaming("hello", "tester", 42, async (kind) => {
      if (kind === "done") {
        seen.push((await topicsStore.get(11))!.last_active_at);
      }
    });
    await turn;

    expect(seen[0]).not.toBe(SPAWNED_AT);
  });
});

describe("session_id recorded on every session, not just the spawn", () => {
  test("the first turn writes the SDK session id into topics.json", async () => {
    await topicsStore.upsert(topic(11));

    await runTurn({ chatId: GROUP, threadId: 11 }, { sessionId: "sess-first" });
    await settle();

    expect((await topicsStore.get(11))!.session_id).toBe("sess-first");
  });

  test("a second session in the same topic replaces the recorded id", async () => {
    // The /new-inside-a-topic case. The recorded id used to be frozen at spawn,
    // so boot-resume would revive the conversation the user had abandoned.
    await topicsStore.upsert(topic(11, { session_id: "sess-abandoned" }));

    await runTurn({ chatId: GROUP, threadId: 11 }, { sessionId: "sess-current" });
    await settle();

    expect((await topicsStore.get(11))!.session_id).toBe("sess-current");
  });

  test("a DM session records nothing", async () => {
    await topicsStore.upsert(topic(11, { session_id: "sess-topic" }));

    await runTurn({ chatId: GROUP, threadId: undefined }, { sessionId: "sess-dm" });
    await settle();

    expect((await topicsStore.get(11))!.session_id).toBe("sess-topic");
  });
});

describe("saved_at tracks the last turn, not the first", () => {
  test("a second turn on the same session moves saved_at forward", async () => {
    // What makes idle eviction safe: the 24h auto-resume TTL has to count from
    // the last message, or a conversation that has been running all day gets
    // silently dropped the first time the reaper collects it.
    const key: ConversationKey = { chatId: GROUP, threadId: 11 };
    await topicsStore.upsert(topic(11));

    const entries = () =>
      sessionStore.loadHistorySync().sessions.filter((e) => e.session_id === "sess-long");

    const s = new ClaudeSession({ key });
    (s as unknown as { loadSessionHistory: () => { sessions: [] } }).loadSessionHistory =
      () => ({ sessions: [] });
    events = [
      { type: "system", subtype: "init", session_id: "sess-long" },
      { type: "result", subtype: "success", session_id: "sess-long" },
    ];
    await s.sendMessageStreaming("first", "tester", 42, async () => {});
    await Bun.sleep(5);
    const first = entries()[0]!.saved_at;

    await Bun.sleep(5);
    await s.sendMessageStreaming("second", "tester", 42, async () => {});
    await Bun.sleep(5);
    const second = entries()[0]!.saved_at;

    // Upserted, not appended: one entry per SDK session, re-stamped.
    expect(entries().length).toBe(1);
    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first));
  });
});
