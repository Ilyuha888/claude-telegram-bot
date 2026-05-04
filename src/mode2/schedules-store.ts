import { readFile, writeFile, rename } from "fs/promises";
import { SCHEDULES_FILE } from "../config";
import type { Schedule, SchedulesFile } from "./types";

let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn);
  queue = result.catch(() => {});
  return result;
}

async function load(): Promise<SchedulesFile> {
  try {
    const raw = await readFile(SCHEDULES_FILE, "utf-8");
    return JSON.parse(raw) as SchedulesFile;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { schedules: [] };
    }
    const corrupted = `${SCHEDULES_FILE}.corrupted-${Date.now()}`;
    try {
      await rename(SCHEDULES_FILE, corrupted);
    } catch {
      /* best effort */
    }
    console.error(`[schedules-store] corrupted, backed up to ${corrupted}`);
    return { schedules: [] };
  }
}

async function save(data: SchedulesFile): Promise<void> {
  const tmp = `${SCHEDULES_FILE}.tmp-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmp, SCHEDULES_FILE);
}

export function list(): Promise<Schedule[]> {
  return enqueue(async () => {
    const data = await load();
    return data.schedules;
  });
}

export function get(id: string): Promise<Schedule | undefined> {
  return enqueue(async () => {
    const data = await load();
    return data.schedules.find((s) => s.id === id);
  });
}

export function upsert(schedule: Schedule): Promise<void> {
  return enqueue(async () => {
    const data = await load();
    const idx = data.schedules.findIndex((s) => s.id === schedule.id);
    if (idx !== -1) {
      data.schedules[idx] = schedule;
    } else {
      data.schedules.push(schedule);
    }
    await save(data);
  });
}

export function remove(id: string): Promise<void> {
  return enqueue(async () => {
    const data = await load();
    data.schedules = data.schedules.filter((s) => s.id !== id);
    await save(data);
  });
}

export function touch(id: string, lastFired: string): Promise<void> {
  return enqueue(async () => {
    const data = await load();
    const s = data.schedules.find((s) => s.id === id);
    if (s) {
      s.last_fired = lastFired;
      await save(data);
    }
  });
}
