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
    const parsed = JSON.parse(raw) as SchedulesFile;
    return migrate(parsed);
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

/**
 * One-shot schedules used to abuse `last_fired` as the fire-at timestamp.
 * The new schema has a dedicated `fire_at` field. Migrate any legacy row
 * (one_shot && last_fired && !fire_at) and persist if anything changed.
 * Idempotent: subsequent loads find nothing to migrate.
 */
function migrate(data: SchedulesFile): SchedulesFile {
  let changed = false;
  for (const s of data.schedules) {
    if (s.one_shot && s.last_fired && !s.fire_at) {
      s.fire_at = s.last_fired;
      s.last_fired = null;
      changed = true;
    }
  }
  if (changed) {
    // Persist the migration so future loads don't repeat the work. Fire-and-forget
    // because save() is async and load() is called from inside the enqueue lock.
    save(data).catch((err) =>
      console.error("[schedules-store] migration save failed:", err),
    );
    console.log("[schedules-store] migrated legacy one-shots last_fired → fire_at");
  }
  return data;
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
