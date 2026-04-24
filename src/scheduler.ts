import cron, { type ScheduledTask } from "node-cron";
import { watch, type FSWatcher } from "fs";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { ClaudeSession } from "./session";
import { session as mainSession } from "./session";
import { PROMPTS } from "./scheduler-prompts";
import { ALLOWED_USERS, SCHEDULES_FILE } from "./config";
import { escapeHtml } from "./formatting";
import * as schedulesStore from "./mode2/schedules-store";
import * as notifStore from "./mode2/notifications-store";
import type { Schedule, Notification } from "./mode2/types";

const DEFAULT_SCHEDULES: Omit<Schedule, "last_fired">[] = [
  { id: "daily-focus",      cron: "0 9 * * *",    tz: "Europe/Moscow", prompt_key: "daily_focus" },
  { id: "weekly-curator",   cron: "0 20 * * 0",   tz: "Europe/Moscow", prompt_key: "weekly_curator" },
  { id: "monthly-audit",    cron: "0 10 1 * *",   tz: "Europe/Moscow", prompt_key: "monthly_audit" },
  { id: "quarterly-review", cron: "0 10 1 1,4,7,10 *", tz: "Europe/Moscow", prompt_key: "quarterly_review" },
];

const CADENCE_WINDOWS_MS: Record<string, number> = {
  "daily-focus":      23 * 60 * 60 * 1000,
  "weekly-curator":   8 * 24 * 60 * 60 * 1000,
  "monthly-audit":    32 * 24 * 60 * 60 * 1000,
  "quarterly-review": 95 * 24 * 60 * 60 * 1000,
};

const cronHandles: ScheduledTask[] = [];
const oneShotTimers: ReturnType<typeof setTimeout>[] = [];
const registeredOneShotIds = new Set<string>();
let fileWatcher: FSWatcher | null = null;
let botInstance: Bot | null = null;

function noopStatusCallback(): Promise<void> {
  return Promise.resolve();
}

async function waitForIdle(maxWaitMs = 60_000): Promise<void> {
  const interval = 2000;
  let waited = 0;
  while (mainSession.isRunning && waited < maxWaitMs) {
    await new Promise((r) => setTimeout(r, interval));
    waited += interval;
  }
}

function notificationKeyboard(notifId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Show", `notif:show:${notifId}`)
    .text("New session", `notif:new:${notifId}`)
    .row()
    .text("Delete", `notif:del:${notifId}`)
    .text("Remind later", `notif:remind:${notifId}`);
}

async function fire(schedule: Schedule): Promise<void> {
  const promptEntry = PROMPTS[schedule.prompt_key];
  if (!promptEntry) {
    console.error(`[scheduler] unknown prompt_key: ${schedule.prompt_key}`);
    return;
  }

  console.log(`[scheduler] firing ${schedule.id} (prompt_key=${schedule.prompt_key})`);

  await waitForIdle();

  const ephemeral = new ClaudeSession({ persist: false });
  let content: string;
  try {
    content = await ephemeral.sendMessageStreaming(
      promptEntry.body,
      "scheduler",
      0,
      noopStatusCallback,
    );
  } catch (err) {
    console.error(`[scheduler] fire ${schedule.id} failed:`, err);
    return;
  }

  const notif: Notification = {
    id: crypto.randomUUID(),
    fired_at: new Date().toISOString(),
    prompt_key: schedule.prompt_key,
    title: promptEntry.title,
    content,
    status: "unread",
  };
  await notifStore.append(notif);

  await schedulesStore.touch(schedule.id, new Date().toISOString());

  if (schedule.one_shot) {
    await schedulesStore.remove(schedule.id);
  }

  if (!botInstance) return;

  const chatId = ALLOWED_USERS[0];
  if (!chatId) return;

  try {
    const msg = await botInstance.api.sendMessage(
      chatId,
      `📬 <b>Notification</b> · ${promptEntry.title}`,
      {
        parse_mode: "HTML",
        reply_markup: notificationKeyboard(notif.id),
      },
    );
    await notifStore.patchMessageMeta(notif.id, msg.message_id, chatId);
  } catch (err) {
    console.error(`[scheduler] telegram send failed:`, err);
  }
}

async function fireReminder(schedule: Schedule): Promise<void> {
  registeredOneShotIds.delete(schedule.id);
  await schedulesStore.remove(schedule.id);

  if (!botInstance) return;
  const chatId = ALLOWED_USERS[0];
  if (!chatId) return;

  // Scribe-created reminder — direct alert with note context
  if (schedule.payload?.reminder_message) {
    const newNotif: Notification = {
      id: crypto.randomUUID(),
      fired_at: new Date().toISOString(),
      prompt_key: "scribe_reminder",
      title: schedule.payload.reminder_message,
      content: schedule.payload.note_path
        ? `Reminder: ${schedule.payload.reminder_message}\n\nNote: ${schedule.payload.note_path}`
        : `Reminder: ${schedule.payload.reminder_message}`,
      status: "unread",
    };
    await notifStore.append(newNotif);
    const reminderKeyboard = new InlineKeyboard()
      .text("Log outcome", `notif:new:${newNotif.id}`)
      .text("Delete", `notif:del:${newNotif.id}`)
      .row()
      .text("Remind later", `notif:remind:${newNotif.id}`);
    try {
      const msg = await botInstance.api.sendMessage(
        chatId,
        `⏰ <b>Reminder</b> · ${escapeHtml(newNotif.title)}`,
        { parse_mode: "HTML", reply_markup: reminderKeyboard },
      );
      await notifStore.patchMessageMeta(newNotif.id, msg.message_id, chatId);
    } catch (err) {
      console.error(`[scheduler] scribe reminder send failed:`, err);
    }
    return;
  }

  // [Remind later] — re-surface an existing notification
  const notifId = schedule.payload?.notification_id;
  if (!notifId) {
    console.error(`[scheduler] remind schedule ${schedule.id} missing payload`);
    return;
  }

  const original = await notifStore.get(notifId);
  if (!original || original.status === "deleted") return;

  const newNotif: Notification = {
    id: crypto.randomUUID(),
    fired_at: new Date().toISOString(),
    prompt_key: original.prompt_key,
    title: `${original.title} (reminder)`,
    content: original.content,
    status: "unread",
  };
  await notifStore.append(newNotif);

  try {
    const msg = await botInstance.api.sendMessage(
      chatId,
      `🔔 <b>Reminder</b> · ${escapeHtml(newNotif.title)}`,
      { parse_mode: "HTML", reply_markup: notificationKeyboard(newNotif.id) },
    );
    await notifStore.patchMessageMeta(newNotif.id, msg.message_id, chatId);
  } catch (err) {
    console.error(`[scheduler] reminder telegram send failed:`, err);
  }
}

async function seedDefaults(): Promise<void> {
  const existing = await schedulesStore.list();
  const existingIds = new Set(existing.map((s) => s.id));

  for (const def of DEFAULT_SCHEDULES) {
    if (!existingIds.has(def.id)) {
      await schedulesStore.upsert({ ...def, last_fired: null });
    }
  }
}

function registerOneShot(schedule: Schedule): void {
  if (registeredOneShotIds.has(schedule.id)) return;
  registeredOneShotIds.add(schedule.id);

  const fireAt = schedule.last_fired
    ? new Date(schedule.last_fired).getTime()
    : Date.now();
  const delayMs = Math.max(0, fireAt - Date.now());

  const timer = setTimeout(() => {
    fireReminder(schedule).catch((err) =>
      console.error(`[scheduler] one-shot ${schedule.id} error:`, err),
    );
  }, delayMs);
  oneShotTimers.push(timer);
}

async function reloadOneShots(): Promise<void> {
  const all = await schedulesStore.list();
  for (const s of all) {
    if (s.one_shot && !registeredOneShotIds.has(s.id)) {
      registerOneShot(s);
      console.log(`[scheduler] registered new one-shot ${s.id}`);
    }
  }
}

export async function scheduleOneShot(schedule: Schedule): Promise<void> {
  await schedulesStore.upsert(schedule);
  registerOneShot(schedule);
}

export async function startScheduler(bot: Bot): Promise<void> {
  botInstance = bot;

  await seedDefaults();
  const schedules = await schedulesStore.list();

  let catchUpCount = 0;

  for (const schedule of schedules) {
    if (schedule.one_shot) {
      registerOneShot(schedule);
      continue;
    }

    const windowMs = CADENCE_WINDOWS_MS[schedule.id];
    if (windowMs && schedule.last_fired) {
      const elapsed = Date.now() - new Date(schedule.last_fired).getTime();
      if (elapsed > windowMs) {
        catchUpCount++;
        fire(schedule).catch((err) =>
          console.error(`[scheduler] catch-up fire ${schedule.id} error:`, err),
        );
      }
    } else if (!schedule.last_fired && windowMs) {
      catchUpCount++;
      fire(schedule).catch((err) =>
        console.error(`[scheduler] initial fire ${schedule.id} error:`, err),
      );
    }

    const task = cron.schedule(schedule.cron, () => {
      fire(schedule).catch((err) =>
        console.error(`[scheduler] cron fire ${schedule.id} error:`, err),
      );
    }, { timezone: schedule.tz });
    cronHandles.push(task);
  }

  // Watch for new one-shot entries written at runtime (e.g. by Scribe skill)
  fileWatcher = watch(SCHEDULES_FILE, { persistent: false }, () => {
    reloadOneShots().catch((err) =>
      console.error("[scheduler] reloadOneShots error:", err),
    );
  });

  console.log(
    `[scheduler] started: ${schedules.length} schedule(s) registered, ${catchUpCount} catch-up fire(s)`,
  );
}

export async function stopScheduler(): Promise<void> {
  for (const task of cronHandles) {
    task.stop();
  }
  cronHandles.length = 0;

  for (const timer of oneShotTimers) {
    clearTimeout(timer);
  }
  oneShotTimers.length = 0;

  if (fileWatcher) {
    fileWatcher.close();
    fileWatcher = null;
  }
  registeredOneShotIds.clear();
  botInstance = null;
  console.log("[scheduler] stopped");
}
