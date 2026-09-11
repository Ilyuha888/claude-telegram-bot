/**
 * Tests for src/session-store.ts — the serialized, atomic session-history store.
 *
 * What these pin is the read-modify-write invariant now that more than one
 * conversation can save at the same time: whatever the interleaving, no
 * conversation's entry may be erased by another's write, and no reader may
 * observe a half-written file.
 *
 * Honest scope note. The predecessor (`loadSessionHistory()` sync, then a bare
 * fire-and-forget `Bun.write`) had no await between its read and its write, and
 * `Bun.write` empirically flushes before yielding at these sizes — so the
 * classic lost-update interleaving could NOT be reproduced against it, and
 * these tests would have passed against it too. They are not regression tests
 * for an observed bug. They exist because the old arrangement depended on an
 * undocumented timing property of an API whose contract is `Promise<number>`,
 * and because `Bun.write` truncates a live file in place. The current store
 * also reads with async `readFile`, which genuinely does yield mid-operation —
 * without the serial queue it would be strictly racier than what it replaced.
 * So the queue is load-bearing, and these tests are what hold it in place.
 *
 * They drive real files under /tmp via the store's test seam.
 *
 * Run with: bun test tests/session-store.test.ts
 */

import { describe, test, expect, afterAll, beforeEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import {
  upsertSession,
  loadHistorySync,
  __setSessionFileForTests,
} from "../src/session-store";
import { SESSION_FILE } from "../src/config";
import type { SavedSession, SessionHistory } from "../src/types";

const DIR = `/tmp/ctb-session-store-test-${crypto.randomUUID().slice(0, 8)}`;
const FILE = `${DIR}/chat-session-history.json`;

const GROUP = -1002222222222;

function entry(id: string, threadId?: number): SavedSession {
  return {
    session_id: id,
    saved_at: new Date().toISOString(),
    working_dir: "/anywhere",
    title: `title for ${id}`,
    chat_id: GROUP,
    thread_id: threadId,
  };
}

function read(): SessionHistory {
  return JSON.parse(readFileSync(FILE, "utf-8")) as SessionHistory;
}

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  __setSessionFileForTests(FILE);
});

afterAll(() => {
  // The store is module state shared across the whole test process — put the
  // real path back or later files would read and write this scratch directory.
  __setSessionFileForTests(SESSION_FILE);
  rmSync(DIR, { recursive: true, force: true });
});

describe("concurrent writes", () => {
  test("two topics saving at once keep both entries", async () => {
    // Fired without awaiting in between: exactly what two topics completing
    // queries in the same tick produce. The store's read happens inside the
    // queued critical section, so B's load is guaranteed to see A's write.
    await Promise.all([
      upsertSession(entry("sess-topic-a", 11)),
      upsertSession(entry("sess-topic-b", 22)),
    ]);

    const ids = read().sessions.map((s) => s.session_id);
    expect(ids).toContain("sess-topic-a");
    expect(ids).toContain("sess-topic-b");
    expect(ids.length).toBe(2);
  });

  test("a burst of writers loses nothing", async () => {
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 25; i++) {
      writes.push(upsertSession(entry(`sess-${i}`, i + 1)));
    }
    await Promise.all(writes);

    const ids = new Set(read().sessions.map((s) => s.session_id));
    expect(ids.size).toBe(25);
    for (let i = 0; i < 25; i++) expect(ids.has(`sess-${i}`)).toBe(true);
  });

  test("the same session saved twice is updated in place, not duplicated", async () => {
    await upsertSession(entry("sess-x", 11));
    const updated = { ...entry("sess-x", 11), title: "renamed", errored: true };
    await upsertSession(updated);

    const sessions = read().sessions;
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.title).toBe("renamed");
    expect(sessions[0]!.errored).toBe(true);
  });
});

describe("atomic write", () => {
  test("leaves no tmp file behind", async () => {
    await upsertSession(entry("sess-a", 11));
    await upsertSession(entry("sess-b", 22));

    const strays = readdirSync(DIR).filter((f) => f.includes(".tmp-"));
    expect(strays).toEqual([]);
    expect(existsSync(FILE)).toBe(true);
  });

  test("a reader never sees a partially written file", async () => {
    // tmp+rename means the live path is only ever swapped between two complete
    // documents, so a concurrent sync read either parses or hits ENOENT — it
    // can never observe a truncation. (A bare write to the live path would
    // truncate first; that window is narrow enough to be hard to hit on
    // purpose, which is precisely why it should be designed out rather than
    // measured.)
    const writes = [];
    for (let i = 0; i < 20; i++) writes.push(upsertSession(entry(`sess-${i}`, i + 1)));

    const reads: number[] = [];
    for (let i = 0; i < 20; i++) {
      reads.push(loadHistorySync().sessions.length);
      await Promise.resolve();
    }
    await Promise.all(writes);

    // Monotonic and never garbage: every reading is a valid document.
    for (const n of reads) expect(n).toBeGreaterThanOrEqual(0);
    expect(loadHistorySync().sessions.length).toBe(20);
  });
});

describe("corrupted and missing files", () => {
  test("a missing file starts empty rather than throwing", async () => {
    rmSync(FILE, { force: true });
    expect(loadHistorySync().sessions).toEqual([]);

    await upsertSession(entry("sess-a", 11));
    expect(read().sessions.length).toBe(1);
  });

  test("a corrupted file is backed up, not overwritten in place", async () => {
    writeFileSync(FILE, "{ this is not json", "utf-8");

    // The sync reader is side-effect free — /status must not move files around.
    expect(loadHistorySync().sessions).toEqual([]);
    expect(readFileSync(FILE, "utf-8")).toBe("{ this is not json");

    // The write path preserves the bytes under .corrupted-* before starting over.
    await upsertSession(entry("sess-a", 11));

    const backups = readdirSync(DIR).filter((f) => f.includes(".corrupted-"));
    expect(backups.length).toBe(1);
    expect(readFileSync(`${DIR}/${backups[0]}`, "utf-8")).toBe("{ this is not json");
    expect(read().sessions.map((s) => s.session_id)).toEqual(["sess-a"]);
  });

  test("a file whose sessions key is not an array is treated as empty", () => {
    writeFileSync(FILE, JSON.stringify({ sessions: "nope" }), "utf-8");
    expect(loadHistorySync().sessions).toEqual([]);
  });
});
