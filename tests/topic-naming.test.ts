/**
 * Tests for topic name disambiguation (uniqueTopicName in src/topics.ts).
 *
 * Telegram allows two topics with the same name and nothing in this codebase
 * breaks when that happens — topics.json keys on thread_id, the registry keys on
 * (chatId, threadId), and no lookup resolves a topic by name. The problem is
 * purely legibility: pressing "Open in new chat" on the daily-focus notification
 * every morning fills the sidebar with identical "Daily focus" rows.
 *
 * The contract is therefore narrow: leave unique names ALONE (a typed
 * `/topic refactor auth` must not acquire a date), and stamp only real
 * collisions.
 *
 * `topics-store` is module-mocked. Bun's mocks are process-wide and keyed by
 * resolved path, so per the discipline in tests/notification-new-session.test.ts
 * the mock spreads the real module and afterAll restores it.
 *
 * Run with: bun test tests/topic-naming.test.ts
 */

import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import type { TopicEntry } from "../src/topics-store";

const realStore = { ...(await import("../src/topics-store")) };

afterAll(() => {
  mock.module("../src/topics-store", () => ({ ...realStore }));
});

let entries: TopicEntry[] = [];
let listThrows = false;

mock.module("../src/topics-store", () => ({
  ...realStore,
  list: async () => {
    if (listThrows) throw new Error("topics.json unreadable");
    return entries;
  },
}));

const { uniqueTopicName } = await import("../src/topics");

/** 29 Jul 2026, 19:41 Moscow time. */
const NOW = new Date("2026-07-29T16:41:00Z");

function topic(name: string, closed = false): TopicEntry {
  return {
    thread_id: name.length + (closed ? 1000 : 0),
    chat_id: -1002222222222,
    name,
    created_at: NOW.toISOString(),
    session_id: null,
    last_active_at: NOW.toISOString(),
    ...(closed ? { closed: true } : {}),
  };
}

beforeEach(() => {
  entries = [];
  listThrows = false;
});

describe("uniqueTopicName", () => {
  test("leaves a name nobody is using completely alone", async () => {
    entries = [topic("Daily focus")];
    // The main thing this must not do: uglify every name just because
    // disambiguation exists.
    expect(await uniqueTopicName("refactor auth", NOW)).toBe("refactor auth");
  });

  test("stamps the date on a collision with an open topic", async () => {
    entries = [topic("Daily focus")];
    // The reported scenario: tomorrow's daily-focus notification, [Open in new
    // chat], while yesterday's topic is still open.
    expect(await uniqueTopicName("Daily focus", NOW)).toBe("Daily focus · 29 Jul");
  });

  test("adds the time when the date is already taken too", async () => {
    entries = [topic("Daily focus"), topic("Daily focus · 29 Jul")];
    expect(await uniqueTopicName("Daily focus", NOW)).toBe("Daily focus · 29 Jul, 19:41");
  });

  test("falls back to a counter for two spawns in the same minute", async () => {
    entries = [
      topic("Daily focus"),
      topic("Daily focus · 29 Jul"),
      topic("Daily focus · 29 Jul, 19:41"),
    ];
    expect(await uniqueTopicName("Daily focus", NOW)).toBe("Daily focus · 29 Jul, 19:41 (2)");
  });

  test("a closed topic does not reserve its name", async () => {
    // Closing a topic is how the user says they're done with it; the name
    // becomes reusable, which is what keeps "Daily focus" stable for someone who
    // closes each one when finished.
    entries = [topic("Daily focus", true)];
    expect(await uniqueTopicName("Daily focus", NOW)).toBe("Daily focus");
  });

  test("keeps the stamp inside Telegram's 128-char limit", async () => {
    const long = "x".repeat(128);
    entries = [topic(long)];

    const out = await uniqueTopicName(long, NOW);

    expect(out.length).toBeLessThanOrEqual(128);
    // The base is trimmed to make room rather than the suffix being truncated
    // away — a cut-off stamp would defeat the whole point.
    expect(out.endsWith("· 29 Jul")).toBe(true);
    expect(out).not.toBe(long);
  });

  test("a store read failure spawns with the plain name instead of throwing", async () => {
    // A duplicate name is cosmetic; failing here would cost the user a session.
    listThrows = true;
    expect(await uniqueTopicName("Daily focus", NOW)).toBe("Daily focus");
  });
});
