/**
 * Tests for src/topics-store.ts
 *
 * The store is exercised against a scratch file in /tmp (see
 * __setTopicsFileForTests) so nothing touches the real BOT_DATA_DIR.
 *
 * Run with: bun test tests/topics-store.test.ts
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as topicsStore from "../src/topics-store";
import type { TopicEntry } from "../src/topics-store";

const DIR = join(tmpdir(), `ctb-topics-test-${process.pid}`);
let file = "";
let n = 0;

function entry(threadId: number, over: Partial<TopicEntry> = {}): TopicEntry {
  return {
    thread_id: threadId,
    chat_id: -1001234567890,
    name: `Topic ${threadId}`,
    created_at: "2026-07-26T10:00:00.000Z",
    session_id: null,
    last_active_at: "2026-07-26T10:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  // Both calls are synchronous on purpose. The directory has to exist before
  // the first save(): an async recreate (Bun.write) races the store's own
  // writeFile and loses intermittently with ENOENT.
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  file = join(DIR, `topics-${n++}.json`);
  topicsStore.__setTopicsFileForTests(file);
});

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
});

describe("load defaults", () => {
  test("a missing file reads as no topics, and reading does not create it", async () => {
    expect(await topicsStore.list()).toEqual([]);
    expect(await topicsStore.get(1)).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  test("a corrupted file is moved aside instead of throwing at the caller", async () => {
    writeFileSync(file, "{not json");

    expect(await topicsStore.list()).toEqual([]);

    const backups = readdirSync(DIR).filter((f) => f.includes(".corrupted-"));
    expect(backups.length).toBe(1);
  });

  test("a file whose topics key is not an array degrades to empty", async () => {
    writeFileSync(file, JSON.stringify({ topics: null }));
    expect(await topicsStore.list()).toEqual([]);
  });
});

describe("CRUD", () => {
  test("upsert inserts, then updates in place by thread_id", async () => {
    await topicsStore.upsert(entry(10));
    await topicsStore.upsert(entry(11));
    expect((await topicsStore.list()).map((t) => t.thread_id)).toEqual([10, 11]);

    await topicsStore.upsert(entry(10, { name: "renamed" }));

    const all = await topicsStore.list();
    expect(all.length).toBe(2);
    expect((await topicsStore.get(10))!.name).toBe("renamed");
  });

  test("touch bumps last_active_at, and only for the named topic", async () => {
    await topicsStore.upsert(entry(10));
    await topicsStore.upsert(entry(11));

    await topicsStore.touch(10, "2026-07-27T12:00:00.000Z");

    expect((await topicsStore.get(10))!.last_active_at).toBe("2026-07-27T12:00:00.000Z");
    expect((await topicsStore.get(10))!.created_at).toBe("2026-07-26T10:00:00.000Z");
    expect((await topicsStore.get(11))!.last_active_at).toBe("2026-07-26T10:00:00.000Z");
  });

  test("touch also clears closed — a turn arriving proves the topic reopened", async () => {
    // Reopening from the Telegram UI is not something the bot is told about.
    // Left marked closed, the topic would be skipped by the idle auto-close and
    // wouldn't count toward MAX_ACTIVE_TOPICS: an active conversation invisible
    // to both halves of the lifecycle layer.
    await topicsStore.upsert(entry(10, { closed: true }));

    await topicsStore.touch(10, "2026-07-27T12:00:00.000Z");

    const t = (await topicsStore.get(10))!;
    expect(t.closed).toBeUndefined();
    expect(t.last_active_at).toBe("2026-07-27T12:00:00.000Z");
  });

  test("markClosed and setSessionId patch a single field", async () => {
    await topicsStore.upsert(entry(10));

    await topicsStore.setSessionId(10, "sess-abc");
    await topicsStore.markClosed(10);

    const t = (await topicsStore.get(10))!;
    expect(t.session_id).toBe("sess-abc");
    expect(t.closed).toBe(true);
    expect(t.name).toBe("Topic 10");
  });

  test("patching an unknown thread is a no-op, not an error", async () => {
    await topicsStore.upsert(entry(10));

    await topicsStore.touch(999);
    await topicsStore.markClosed(999);
    await topicsStore.setSessionId(999, "nope");

    expect((await topicsStore.list()).length).toBe(1);
  });
});

describe("atomicity", () => {
  test("concurrent writes are serialized — no lost updates", async () => {
    // Fired without awaiting: every one of these does its own
    // read-modify-write, so an unserialized store would drop most of them.
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => topicsStore.upsert(entry(i)))
    );

    const all = await topicsStore.list();
    expect(all.length).toBe(25);
    expect(new Set(all.map((t) => t.thread_id)).size).toBe(25);
  });

  test("interleaved upserts and patches all land", async () => {
    await topicsStore.upsert(entry(1));
    await Promise.all([
      topicsStore.setSessionId(1, "sess-1"),
      topicsStore.touch(1, "2026-07-28T00:00:00.000Z"),
      topicsStore.upsert(entry(2)),
      topicsStore.markClosed(1),
    ]);

    const one = (await topicsStore.get(1))!;
    expect(one.session_id).toBe("sess-1");
    expect(one.last_active_at).toBe("2026-07-28T00:00:00.000Z");
    expect(one.closed).toBe(true);
    expect(await topicsStore.get(2)).toBeDefined();
  });

  test("the file is replaced by rename — no .tmp- leftovers", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => topicsStore.upsert(entry(i)))
    );

    const leftovers = readdirSync(DIR).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
    // And what landed on disk is valid, complete JSON.
    const parsed = JSON.parse(await Bun.file(file).text());
    expect(parsed.topics.length).toBe(10);
  });
});
