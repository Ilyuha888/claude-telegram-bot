import { readFile, writeFile, rename } from "fs/promises";
import { SESSIONS_FILE } from "../config";
import type { WorkSession, SessionsFile } from "./types";

let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn);
  queue = result.catch(() => {});
  return result;
}

async function load(): Promise<SessionsFile> {
  try {
    const raw = await readFile(SESSIONS_FILE, "utf-8");
    return JSON.parse(raw) as SessionsFile;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { sessions: [] };
    }
    const corrupted = `${SESSIONS_FILE}.corrupted-${Date.now()}`;
    try {
      await rename(SESSIONS_FILE, corrupted);
    } catch {
      /* best effort */
    }
    console.error(`[mode2/store] sessions.json corrupted, backed up to ${corrupted}`);
    return { sessions: [] };
  }
}

async function save(data: SessionsFile): Promise<void> {
  const tmp = `${SESSIONS_FILE}.tmp-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmp, SESSIONS_FILE);
}

export function list(): Promise<WorkSession[]> {
  return enqueue(async () => {
    const data = await load();
    return data.sessions;
  });
}

export function get(slug: string): Promise<WorkSession | undefined> {
  return enqueue(async () => {
    const data = await load();
    return data.sessions.find((s) => s.slug === slug);
  });
}

export function append(session: WorkSession): Promise<void> {
  return enqueue(async () => {
    const data = await load();
    data.sessions.push(session);
    await save(data);
  });
}

export function markClosed(
  slug: string,
  reason: WorkSession["close_reason"]
): Promise<void> {
  return enqueue(async () => {
    const data = await load();
    const s = data.sessions.find((s) => s.slug === slug);
    if (s) {
      s.closed = true;
      s.close_reason = reason;
      await save(data);
    }
  });
}

export function touch(slug: string): Promise<void> {
  return enqueue(async () => {
    const data = await load();
    const s = data.sessions.find((s) => s.slug === slug);
    if (s) {
      s.last_attached_at = new Date().toISOString();
      await save(data);
    }
  });
}
