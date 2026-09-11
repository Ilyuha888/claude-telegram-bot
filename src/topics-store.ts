/**
 * Atomic JSON store for the forum topics the bot has spawned.
 *
 * Lives in src/ rather than src/mode2/ (where the other three stores sit)
 * because topics belong to the core conversation layer — src/conversation.ts,
 * src/session-registry.ts, src/topics.ts — not to mode-2's work-session
 * feature. The *pattern* is deliberately identical to
 * mode2/schedules-store.ts: one serial write queue, tmp-write + rename, empty
 * default on ENOENT, corrupted file moved aside rather than thrown at callers.
 */

import { readFile, writeFile, rename } from "fs/promises";
import { TOPICS_FILE } from "./config";

export interface TopicEntry {
  thread_id: number;
  chat_id: number;
  name: string;
  created_at: string;      // ISO
  session_id: string | null;
  last_active_at: string;  // ISO — drives the idle timers
  closed?: boolean;
}

export interface TopicsFile {
  topics: TopicEntry[];
}

/**
 * Test seam: point the store at a scratch file so tests don't write into the
 * real BOT_DATA_DIR. Not called by the bot.
 */
let topicsFile: string = TOPICS_FILE;
export function __setTopicsFileForTests(path: string): void {
  topicsFile = path;
}

let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn);
  queue = result.catch(() => {});
  return result;
}

async function load(): Promise<TopicsFile> {
  try {
    const raw = await readFile(topicsFile, "utf-8");
    const parsed = JSON.parse(raw) as TopicsFile;
    if (!Array.isArray(parsed.topics)) return { topics: [] };
    return parsed;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { topics: [] };
    }
    const corrupted = `${topicsFile}.corrupted-${Date.now()}`;
    try {
      await rename(topicsFile, corrupted);
    } catch {
      /* best effort */
    }
    console.error(`[topics-store] corrupted, backed up to ${corrupted}`);
    return { topics: [] };
  }
}

async function save(data: TopicsFile): Promise<void> {
  const tmp = `${topicsFile}.tmp-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmp, topicsFile);
}

export function list(): Promise<TopicEntry[]> {
  return enqueue(async () => {
    const data = await load();
    return data.topics;
  });
}

export function get(threadId: number): Promise<TopicEntry | undefined> {
  return enqueue(async () => {
    const data = await load();
    return data.topics.find((t) => t.thread_id === threadId);
  });
}

export function upsert(entry: TopicEntry): Promise<void> {
  return enqueue(async () => {
    const data = await load();
    const idx = data.topics.findIndex((t) => t.thread_id === entry.thread_id);
    if (idx !== -1) {
      data.topics[idx] = entry;
    } else {
      data.topics.push(entry);
    }
    await save(data);
  });
}

/**
 * Record activity in a topic: bump `last_active_at` and clear `closed`.
 * No-op for an unknown thread.
 *
 * Clearing `closed` is how the store recovers from a reopen done in the
 * Telegram UI, which the bot is not told about in any way it currently
 * listens for. A turn arriving in a topic we believe closed is proof that
 * belief is wrong, and leaving it would strand the topic: closed entries are
 * skipped by the idle auto-close and don't count toward MAX_ACTIVE_TOPICS, so
 * a reopened conversation would be invisible to both.
 */
export function touch(threadId: number, at = new Date().toISOString()): Promise<void> {
  return enqueue(async () => {
    const data = await load();
    const t = data.topics.find((t) => t.thread_id === threadId);
    if (t) {
      t.last_active_at = at;
      delete t.closed;
      await save(data);
    }
  });
}

export function markClosed(threadId: number): Promise<void> {
  return enqueue(async () => {
    const data = await load();
    const t = data.topics.find((t) => t.thread_id === threadId);
    if (t) {
      t.closed = true;
      await save(data);
    }
  });
}

/** Record the SDK session id so a later boot can resume this topic. */
export function setSessionId(threadId: number, sessionId: string): Promise<void> {
  return enqueue(async () => {
    const data = await load();
    const t = data.topics.find((t) => t.thread_id === threadId);
    if (t) {
      t.session_id = sessionId;
      await save(data);
    }
  });
}
