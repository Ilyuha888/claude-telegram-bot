import { readFile, writeFile, rename } from "fs/promises";
import { NOTIFICATIONS_FILE } from "../config";
import type { Notification, NotificationsFile } from "./types";

const MAX_NOTIFICATIONS = 200;

let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn);
  queue = result.catch(() => {});
  return result;
}

async function load(): Promise<NotificationsFile> {
  try {
    const raw = await readFile(NOTIFICATIONS_FILE, "utf-8");
    return JSON.parse(raw) as NotificationsFile;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { notifications: [] };
    }
    const corrupted = `${NOTIFICATIONS_FILE}.corrupted-${Date.now()}`;
    try {
      await rename(NOTIFICATIONS_FILE, corrupted);
    } catch {
      /* best effort */
    }
    console.error(`[notifications-store] corrupted, backed up to ${corrupted}`);
    return { notifications: [] };
  }
}

async function save(data: NotificationsFile): Promise<void> {
  const tmp = `${NOTIFICATIONS_FILE}.tmp-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmp, NOTIFICATIONS_FILE);
}

export function list(): Promise<Notification[]> {
  return enqueue(async () => {
    const data = await load();
    return data.notifications.filter((n) => n.status !== "deleted");
  });
}

export function get(id: string): Promise<Notification | undefined> {
  return enqueue(async () => {
    const data = await load();
    return data.notifications.find((n) => n.id === id);
  });
}

export function append(notification: Notification): Promise<void> {
  return enqueue(async () => {
    const data = await load();
    data.notifications.unshift(notification);
    if (data.notifications.length > MAX_NOTIFICATIONS) {
      data.notifications = data.notifications.slice(0, MAX_NOTIFICATIONS);
    }
    await save(data);
  });
}

export function markRead(id: string): Promise<void> {
  return enqueue(async () => {
    const data = await load();
    const n = data.notifications.find((n) => n.id === id);
    if (n) {
      n.status = "read";
      await save(data);
    }
  });
}

export function markDeleted(id: string): Promise<void> {
  return enqueue(async () => {
    const data = await load();
    const n = data.notifications.find((n) => n.id === id);
    if (n) {
      n.status = "deleted";
      await save(data);
    }
  });
}

export function unreadCount(): Promise<number> {
  return enqueue(async () => {
    const data = await load();
    return data.notifications.filter((n) => n.status === "unread").length;
  });
}

export function patchMessageMeta(
  id: string,
  messageId: number,
  chatId: number,
): Promise<void> {
  return enqueue(async () => {
    const data = await load();
    const n = data.notifications.find((n) => n.id === id);
    if (n) {
      n.telegram_message_id = messageId;
      n.telegram_chat_id = chatId;
      await save(data);
    }
  });
}
