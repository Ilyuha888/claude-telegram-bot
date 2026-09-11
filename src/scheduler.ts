import cron, { type ScheduledTask } from "node-cron";
import { watch, type FSWatcher } from "fs";
import { basename } from "path";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { ClaudeSession } from "./session";
import { registry } from "./session-registry";
import { hasAnyPending } from "./turn/collector";
import { PROMPTS, ROUTINE_ERROR_PREFIX } from "./scheduler-prompts";
import { ALLOWED_USER, BOT_DATA_DIR, GROUP_CHAT_ID, SCHEDULES_FILE } from "./config";
import { escapeHtml } from "./formatting";
import { isTransientClaudeError } from "./utils";
import * as schedulesStore from "./mode2/schedules-store";
import * as notifStore from "./mode2/notifications-store";
import type { Schedule, Notification } from "./mode2/types";

const DEFAULT_SCHEDULES: Omit<Schedule, "last_fired">[] = [
  { id: "daily-focus",      cron: "0 9 * * *",    tz: "Europe/Moscow", prompt_key: "daily_focus" },
  { id: "weekly-curator",   cron: "0 20 * * 0",   tz: "Europe/Moscow", prompt_key: "weekly_curator" },
  { id: "monthly-audit",    cron: "0 10 * * 0#1", tz: "Europe/Moscow", prompt_key: "monthly_audit" },
  { id: "quarterly-review", cron: "0 10 1 1,4,7,10 *", tz: "Europe/Moscow", prompt_key: "quarterly_review" },
];

const CADENCE_WINDOWS_MS: Record<string, number> = {
  "daily-focus":      23 * 60 * 60 * 1000,
  "weekly-curator":   8 * 24 * 60 * 60 * 1000,
  "monthly-audit":    36 * 24 * 60 * 60 * 1000,
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

/**
 * Deliver a fired notification card, group-first.
 *
 * Every send site here used to be a bare `chatId = ALLOWED_USER` — the user's
 * *id*, i.e. their DM — so with a forum group configured the routines still
 * landed in the private chat while every button on them ("Open in new chat")
 * acted on the group. The group's General topic is the right home: it is where
 * the topics these cards spawn already live, so the notification and its
 * follow-up conversation stay in one place.
 *
 * General means "no `message_thread_id`", which is also why nothing here has to
 * thread: `convKeyFromCtx` normalizes General and DM to the same implicit key,
 * so a button pressed on either behaves identically.
 *
 * The DM is kept as a fallback rather than dropped, because a notification is
 * the one message class with no user action behind it — if the group is
 * unreachable (bot removed, demoted, group deleted, id changed) there is nobody
 * to report the failure to, and silently losing the daily routine is worse than
 * delivering it to the older address. The chat that actually took it is
 * returned so the caller records the right one for the callback buttons.
 *
 * Split into a pure target list and an injectable sender because GROUP_CHAT_ID
 * and ALLOWED_USER are module consts read from the environment at import time,
 * which a test can't vary.
 */
export function notificationTargets(
  groupChatId: number | null,
  allowedUser: number | null,
): number[] {
  const targets: number[] = [];
  if (groupChatId !== null && Number.isFinite(groupChatId)) targets.push(groupChatId);
  if (allowedUser && Number.isFinite(allowedUser) && !targets.includes(allowedUser)) {
    targets.push(allowedUser);
  }
  return targets;
}

/** Send to the first target that accepts it. Injectable for tests. */
export async function deliverCard(
  send: (chatId: number, text: string, keyboard: InlineKeyboard) => Promise<{ message_id: number }>,
  targets: number[],
  text: string,
  keyboard: InlineKeyboard,
): Promise<{ messageId: number; chatId: number } | null> {
  for (const [i, chatId] of targets.entries()) {
    try {
      const msg = await send(chatId, text, keyboard);
      if (i > 0) {
        console.warn(`[scheduler] delivered to fallback chat ${chatId} instead of the group`);
      }
      return { messageId: msg.message_id, chatId };
    } catch (err) {
      const last = i === targets.length - 1;
      console.error(
        `[scheduler] notification send to ${chatId} failed${last ? "" : ", trying fallback"}:`,
        err,
      );
    }
  }
  return null;
}

async function sendNotificationCard(
  text: string,
  keyboard: InlineKeyboard,
): Promise<{ messageId: number; chatId: number } | null> {
  const bot = botInstance;
  if (!bot) return null;
  return deliverCard(
    (chatId, body, reply_markup) =>
      bot.api.sendMessage(chatId, body, { parse_mode: "HTML", reply_markup }),
    notificationTargets(GROUP_CHAT_ID, ALLOWED_USER),
    text,
    keyboard,
  );
}

/**
 * Hold a routine back while the user is mid-conversation.
 *
 * `hasAnyPending` covers the gap `isAnyRunning` leaves: a burst that is still
 * collecting has no running query yet, and firing into that window is exactly
 * the interruption this gate exists to prevent.
 */
async function waitForIdle(maxWaitMs = 60_000): Promise<void> {
  const interval = 2000;
  let waited = 0;
  while ((registry.isAnyRunning() || hasAnyPending()) && waited < maxWaitMs) {
    await new Promise((r) => setTimeout(r, interval));
    waited += interval;
  }
}

/**
 * Labels for the `notif:new` action.
 *
 * The action itself is unchanged — prime a fresh session from this
 * notification — but with a forum group configured it lands in a NEW topic
 * instead of taking over the current conversation, and the label has to say
 * so. Deliberately a relabel rather than a second button: a separate
 * "Open in new chat" entry would fire the same callback and do the same
 * thing, since handleNewSession spawns a topic whenever one is available.
 */
export function newSessionLabel(): string {
  return GROUP_CHAT_ID !== null ? "🧵 Open in new chat" : "New session";
}

/** Same idea for the Scribe-reminder variant, whose wording is outcome-capture. */
export function logOutcomeLabel(): string {
  return GROUP_CHAT_ID !== null ? "🧵 Log outcome" : "Log outcome";
}

/**
 * Default keyboard for a freshly-fired notification message in Telegram.
 * Exported so handleRemindCancel can restore it after the user backs out
 * of the duration picker.
 */
export function notificationKeyboard(notifId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Show", `notif:show:${notifId}`)
    .text(newSessionLabel(), `notif:new:${notifId}`)
    .row()
    .text("Delete", `notif:del:${notifId}`)
    .text("Remind later", `notif:remind:${notifId}`);
}

/**
 * Backoff between attempts to generate a routine. Length of this array is the
 * retry count; `[]` disables retrying.
 *
 * Minutes, not seconds, because the failure being absorbed is upstream capacity
 * (529 Overloaded) and a routine has no reader waiting on it — nothing is
 * cheaper here than waiting. Worst case a fire occupies ~6 minutes of backoff
 * plus three generations, which still lands the daily card inside its own hour.
 */
const FIRE_RETRY_DELAYS_MS = [60_000, 300_000];

/**
 * Tell the user a routine failed.
 *
 * The bug this exists for: `fire()` used to `console.error` and return, so a
 * failed routine left no trace anywhere the user looks. On 2026-07-30 the daily
 * focus died on `API Error: 529 Overloaded` 3.5 minutes in, and the first sign
 * of it was the user noticing a missing card the next morning and asking whether
 * the scheduler was broken — then hunting a journal he couldn't easily read.
 * Silence is the wrong default for a scheduled job: nobody is watching the
 * process, so the delivery channel has to carry its own failures.
 *
 * Recorded as a real Notification, not just a Telegram message, so it shows up
 * in the Fired tab and survives a restart like every other card.
 *
 * `prompt_key` stays the failed routine's own key rather than a synthetic
 * "routine_failed": it keeps the card attributable in the Fired tab, and for the
 * three skill-backed routines `buildPrimingPrompt` then maps it to `/curator`,
 * so [New session] on a failure card re-runs the thing that failed — which is
 * exactly the recovery action.
 */
async function reportFireFailure(
  schedule: Schedule,
  title: string,
  error: unknown,
  attempts: number,
): Promise<void> {
  const detail = String(error).split("\n")[0]!.slice(0, 300);
  const notif: Notification = {
    id: crypto.randomUUID(),
    fired_at: new Date().toISOString(),
    prompt_key: schedule.prompt_key,
    title: `${title} — failed`,
    content:
      `This routine failed to generate and was not delivered.\n\n` +
      `Schedule: ${schedule.id} (prompt_key=${schedule.prompt_key})\n` +
      `Attempts: ${attempts}\n` +
      `Last error: ${detail}\n\n` +
      `Nothing was lost apart from this run — re-running the routine now produces ` +
      `the same report, just late.`,
    status: "unread",
  };
  await notifStore.append(notif);

  // No [Remind later]: re-surfacing a stale failure notice helps nobody, and
  // the useful action is regenerating the report, which [New session] does.
  const sent = await sendNotificationCard(
    `⚠️ <b>Routine failed</b> · ${escapeHtml(title)}`,
    new InlineKeyboard()
      .text("Show", `notif:show:${notif.id}`)
      .text(newSessionLabel(), `notif:new:${notif.id}`)
      .row()
      .text("Delete", `notif:del:${notif.id}`),
  );
  if (sent) {
    await notifStore.patchMessageMeta(notif.id, sent.messageId, sent.chatId);
  }
}

async function fire(schedule: Schedule): Promise<void> {
  const promptEntry = PROMPTS[schedule.prompt_key];
  if (!promptEntry) {
    console.error(`[scheduler] unknown prompt_key: ${schedule.prompt_key}`);
    return;
  }

  console.log(`[scheduler] firing ${schedule.id} (prompt_key=${schedule.prompt_key})`);

  await waitForIdle();

  // `null` rather than a falsy check, because a routine legitimately returning
  // an empty string is a successful (if useless) fire, not a failure to retry.
  let content: string | null = null;
  let lastError: unknown = null;
  let attempts = 0;

  for (let attempt = 0; attempt <= FIRE_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = FIRE_RETRY_DELAYS_MS[attempt - 1]!;
      console.warn(
        `[scheduler] ${schedule.id} retrying in ${delay / 1000}s ` +
          `(attempt ${attempt + 1}/${FIRE_RETRY_DELAYS_MS.length + 1})`,
      );
      await new Promise((r) => setTimeout(r, delay));
      // The user may well have started talking during the backoff.
      await waitForIdle();
    }

    attempts++;
    // A fresh session per attempt: the previous one may have half-built state,
    // and resuming a query that threw is not a thing the SDK supports.
    const ephemeral = new ClaudeSession({ persist: false });
    try {
      content = await ephemeral.sendMessageStreaming(
        promptEntry.body,
        "scheduler",
        0,
        noopStatusCallback,
      );
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      console.error(`[scheduler] fire ${schedule.id} attempt ${attempts} failed:`, err);
      if (!isTransientClaudeError(err)) {
        console.error(`[scheduler] ${schedule.id} error is not transient, not retrying`);
        break;
      }
    }
  }

  if (content === null) {
    // `last_fired` is deliberately left alone on failure, so the cadence-window
    // catch-up in startScheduler() re-fires this routine on the next restart.
    await reportFireFailure(schedule, promptEntry.title, lastError, attempts);
    return;
  }

  // Honour the prompt's FAILURE_CONTRACT. A routine that couldn't read its
  // inputs now says so on one line instead of emitting an empty report that
  // reads like good news; this is the branch that turns that line into a
  // visible failure instead of delivering it as the digest.
  const trimmed = content.trimStart();
  if (trimmed.startsWith(ROUTINE_ERROR_PREFIX)) {
    const reason = trimmed.slice(ROUTINE_ERROR_PREFIX.length).trim() || "(no reason given)";
    console.error(`[scheduler] ${schedule.id} reported a read failure: ${reason}`);
    await reportFireFailure(
      schedule,
      promptEntry.title,
      `the routine could not read its inputs — ${reason}`,
      attempts,
    );
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

  const sent = await sendNotificationCard(
    `📬 <b>Notification</b> · ${promptEntry.title}`,
    notificationKeyboard(notif.id),
  );
  if (sent) {
    await notifStore.patchMessageMeta(notif.id, sent.messageId, sent.chatId);
  }
}

async function fireReminder(schedule: Schedule): Promise<void> {
  // Do NOT delete from registeredOneShotIds. Once fired, the entry stays in
  // the Set for the process lifetime so reloadOneShots() can never re-register
  // a one-shot that's mid-removal from schedules.json. Race scenario before
  // this change: when ≥2 past-due one-shots fired near-simultaneously at boot,
  // each schedulesStore.remove() emitted an atomic-rename event that woke the
  // BOT_DATA_DIR fs.watch, which called reloadOneShots() during the window
  // between the Set delete and the file rewrite — a same-id !has() check
  // passed and the timer fired again.
  await schedulesStore.remove(schedule.id);

  if (!botInstance) return;

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
    console.log(`[scheduler] fired one-shot ${schedule.id} (scribe_reminder)`);
    const reminderKeyboard = new InlineKeyboard()
      .text(logOutcomeLabel(), `notif:new:${newNotif.id}`)
      .text("Delete", `notif:del:${newNotif.id}`)
      .row()
      .text("Remind later", `notif:remind:${newNotif.id}`);
    const sent = await sendNotificationCard(
      `⏰ <b>Reminder</b> · ${escapeHtml(newNotif.title)}`,
      reminderKeyboard,
    );
    if (sent) {
      await notifStore.patchMessageMeta(newNotif.id, sent.messageId, sent.chatId);
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
  console.log(`[scheduler] fired one-shot ${schedule.id} (remind-later)`);

  const sent = await sendNotificationCard(
    `🔔 <b>Reminder</b> · ${escapeHtml(newNotif.title)}`,
    notificationKeyboard(newNotif.id),
  );
  if (sent) {
    await notifStore.patchMessageMeta(newNotif.id, sent.messageId, sent.chatId);
  }
}

async function seedDefaults(): Promise<void> {
  const existing = await schedulesStore.list();
  const existingIds = new Set(existing.map((s) => s.id));

  // Seed with last_fired = now so a fresh install does NOT fire all routines
  // immediately on first boot. The next cron tick (per each schedule's cron
  // expression) is the first real fire. Surprise token spend on first launch
  // was a smoke-test finding.
  const now = new Date().toISOString();
  for (const def of DEFAULT_SCHEDULES) {
    if (!existingIds.has(def.id)) {
      await schedulesStore.upsert({ ...def, last_fired: now });
    }
  }
}

// setTimeout silently overflows at 2^31-1 ms (~24.8 days) and fires immediately.
const MAX_TIMEOUT_MS = 2_000_000_000; // ~23.1 days — safely under the limit

function registerOneShot(schedule: Schedule): void {
  if (registeredOneShotIds.has(schedule.id)) return;
  registeredOneShotIds.add(schedule.id);

  // Prefer `fire_at` (the new schema); fall back to `last_fired` for any
  // legacy entry that schedules-store.load() couldn't migrate (e.g. a row
  // that was written but the migration path raced).
  const fireAtSource = schedule.fire_at ?? schedule.last_fired;
  const fireAt = fireAtSource ? new Date(fireAtSource).getTime() : Date.now();
  const delayMs = Math.max(0, fireAt - Date.now());

  if (delayMs > MAX_TIMEOUT_MS) {
    // Too far out — wait MAX_TIMEOUT_MS then re-register with a fresh delay
    const timer = setTimeout(() => {
      registeredOneShotIds.delete(schedule.id);
      registerOneShot(schedule);
    }, MAX_TIMEOUT_MS);
    oneShotTimers.push(timer);
    return;
  }

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

  // Watch for new one-shot entries written at runtime (e.g. by Scribe skill).
  // We watch the parent directory rather than the file itself because
  // schedules-store.save() uses tmp + rename for atomicity, which swaps the
  // inode and detaches a file-level watcher after the first save. A directory
  // watch survives that and emits one event per affected filename.
  const schedulesBasename = basename(SCHEDULES_FILE);
  fileWatcher = watch(BOT_DATA_DIR, { persistent: false }, (_event, filename) => {
    if (!filename) return;
    if (filename !== schedulesBasename) return;
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
