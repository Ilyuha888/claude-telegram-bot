import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { registry } from "../../session-registry";
import { convKeyFromCtx } from "../../conversation";
import { escapeHtml, convertMarkdownToHtml } from "../../formatting";
import * as notifStore from "../../mode2/notifications-store";
import * as schedulesStore from "../../mode2/schedules-store";
import { scheduleOneShot, notificationKeyboard, newSessionLabel } from "../../scheduler";
import { spawnTopicSession, topicsEnabled, topicLink } from "../../topics";
import type { Notification, Schedule } from "../../mode2/types";
import { StreamingState, createStatusCallback } from "../streaming";
import { startTypingIndicator } from "../../utils";
import { runExclusive } from "../../turn/dispatcher";

// ── Helpers ───────────────────────────────────────────────────────────────────

const REMINDER_DURATIONS: Record<string, { label: string; ms: number }> = {
  "1h": { label: "1 hour",  ms:        60 * 60 * 1000 },
  "6h": { label: "6 hours", ms:    6 * 60 * 60 * 1000 },
  "1d": { label: "1 day",   ms:   24 * 60 * 60 * 1000 },
  "1w": { label: "1 week",  ms: 7 * 24 * 60 * 60 * 1000 },
};

function reminderPickerKeyboard(notifId: string, source?: string): InlineKeyboard {
  const suffix = source ? `:${source}` : "";
  return new InlineKeyboard()
    .text("1 hour",  `notif:remind-set:${notifId}:1h${suffix}`)
    .text("6 hours", `notif:remind-set:${notifId}:6h${suffix}`)
    .row()
    .text("1 day",   `notif:remind-set:${notifId}:1d${suffix}`)
    .text("1 week",  `notif:remind-set:${notifId}:1w${suffix}`)
    .row()
    .text("‹ Cancel", `notif:remind-cancel:${notifId}${suffix}`);
}

function relativeTime(isoOrNull: string | null): string {
  if (!isoOrNull) return "never";
  const mins = Math.floor((Date.now() - new Date(isoOrNull).getTime()) / 60_000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / (60 * 24))}d ago`;
}

function fireTimeLabel(isoOrNull: string | null): string {
  if (!isoOrNull) return "unknown";
  const d = new Date(isoOrNull);
  const now = new Date();
  const msk = { timeZone: "Europe/Moscow" } as const;
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", ...msk });
  const todayStr = now.toLocaleDateString("en-GB", msk);
  const dStr = d.toLocaleDateString("en-GB", msk);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toLocaleDateString("en-GB", msk);
  if (dStr === todayStr) return `today ${time}`;
  if (dStr === tomorrowStr) return `tomorrow ${time}`;
  return d.toLocaleDateString("en-GB", { month: "short", day: "numeric", ...msk }) + ` ${time}`;
}

async function reminderTitle(s: { prompt_key: string; payload?: { notification_id?: string; reminder_message?: string } }): Promise<string> {
  if (s.payload?.reminder_message) return s.payload.reminder_message;
  if (s.payload?.notification_id) {
    const orig = await notifStore.get(s.payload.notification_id);
    if (orig) return orig.title;
  }
  return s.prompt_key;
}

const SCHEDULE_LABELS: Record<string, string> = {
  "daily-focus":      "Daily · 09:00 MSK",
  "weekly-curator":   "Every Sunday · 20:00 MSK",
  "monthly-audit":    "1st of month · 10:00 MSK",
  "quarterly-review": "Quarterly · 10:00 MSK",
};

const SCHEDULE_TITLES: Record<string, string> = {
  "daily-focus":      "Daily focus",
  "weekly-curator":   "Weekly curator",
  "monthly-audit":    "Monthly audit",
  "quarterly-review": "Quarterly review",
};

async function editOrReply(
  ctx: Context,
  text: string,
  kb: InlineKeyboard,
  html = true,
): Promise<void> {
  const opts = { reply_markup: kb, ...(html ? { parse_mode: "HTML" as const } : {}) };
  try {
    await ctx.editMessageText(text, opts);
  } catch {
    await ctx.reply(text, opts);
  }
}

// ── Callback router ───────────────────────────────────────────────────────────

export async function handleNotificationCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const parts = data.split(":");
  const action = parts[1];
  const arg = parts[2];  // notif id for show/new/del/remind; "fired"|"scheduled" for tab

  if (!action) {
    await ctx.answerCallbackQuery({ text: "Invalid notification callback" });
    return;
  }

  switch (action) {
    case "show":          if (arg) return handleShow(ctx, arg); break;
    case "new":           if (arg) return handleNewSession(ctx, arg); break;
    case "del":           if (arg) return handleDelete(ctx, arg, parts[3]); break;
    case "remind":        if (arg) return handleRemindLater(ctx, arg, parts[3]); break;
    case "remind-set":    if (arg && parts[3]) return handleRemindSet(ctx, arg, parts[3], parts[4]); break;
    case "remind-cancel": if (arg) return handleRemindCancel(ctx, arg, parts[3]); break;
    case "sched-del":     if (arg) return handleSchedDel(ctx, arg); break;
    case "tab":
      if (arg === "fired") return renderFiredTab(ctx);
      return renderScheduledTab(ctx);
    default:
      await ctx.answerCallbackQuery({ text: "Unknown action" });
  }
}

// ── Scheduled tab (planned routines) ─────────────────────────────────────────

async function renderScheduledTab(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});

  const all = await schedulesStore.list();
  const routines = all.filter((s) => !s.one_shot);
  const reminders = all.filter((s) => s.one_shot);

  const lines: string[] = [];
  for (const s of routines) {
    const title = SCHEDULE_TITLES[s.id] ?? s.prompt_key;
    const label = SCHEDULE_LABELS[s.id] ?? s.cron;
    lines.push(`<b>${escapeHtml(title)}</b>  <i>${escapeHtml(label)}</i>\n   last: ${relativeTime(s.last_fired)}`);
  }

  const kb = new InlineKeyboard();

  if (reminders.length > 0) {
    lines.push(`\n🔔 <b>Pending reminders</b>`);
    for (const r of reminders) {
      const title = await reminderTitle(r);
      lines.push(`• ${escapeHtml(title)} — ${fireTimeLabel(r.last_fired)}`);
      kb.text(`🗑 ${title.slice(0, 30)}`, `notif:sched-del:${r.id}`).row();
    }
  }

  const firedCount = (await notifStore.list()).length;
  const firedLabel = firedCount > 0 ? `📬 Fired  (${firedCount})` : "📬 Fired";

  kb.text(firedLabel, "notif:tab:fired").row()
    .text("‹ Menu", "m2:menu");

  await editOrReply(
    ctx,
    `📅 <b>Scheduled routines</b>\n\n${lines.join("\n\n")}`,
    kb,
  );
}

// ── Fired tab (delivered notifications) ──────────────────────────────────────

async function renderFiredTab(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});

  const all = await notifStore.list();
  const recent = all.slice(0, 10);

  if (recent.length === 0) {
    await editOrReply(
      ctx,
      "No fired notifications yet.",
      new InlineKeyboard()
        .text("📅 Scheduled", "notif:tab:scheduled").row()
        .text("‹ Menu", "m2:menu"),
    );
    return;
  }

  const lines = recent.map((n) => {
    const icon = n.status === "unread" ? "●" : "○";
    return `${icon} <b>${escapeHtml(n.title)}</b> — ${relativeTime(n.fired_at)}`;
  });

  const kb = new InlineKeyboard();
  for (const n of recent) {
    kb.text(
      `${n.status === "unread" ? "● " : ""}${n.title.slice(0, 28)}`,
      `notif:show:${n.id}`,
    ).row();
  }
  kb.text("📅 Scheduled", "notif:tab:scheduled").text("‹ Menu", "m2:menu");

  await editOrReply(
    ctx,
    `📬 <b>Fired notifications</b>\n\n${lines.join("\n")}`,
    kb,
  );
}

// ── Entry point (called from /menu) ──────────────────────────────────────────

export async function renderNotificationsTab(ctx: Context): Promise<void> {
  return renderScheduledTab(ctx);
}

// ── Individual notification actions ──────────────────────────────────────────

async function handleShow(ctx: Context, notifId: string): Promise<void> {
  const notif = await notifStore.get(notifId);
  if (!notif || notif.status === "deleted") {
    await ctx.answerCallbackQuery({ text: "Notification not found" });
    return;
  }

  await notifStore.markRead(notifId);
  await ctx.answerCallbackQuery();

  const truncated = notif.content.length > 3800
    ? notif.content.slice(0, 3800) + "…"
    : notif.content;

  const body = convertMarkdownToHtml(truncated);
  // Delete and Remind later from the menu's show-view return to the fired
  // list so the user can keep working through their backlog. The :menu
  // suffix is read by the respective handlers to switch behaviour.
  const keyboard = new InlineKeyboard()
    .text(newSessionLabel(), `notif:new:${notifId}`)
    .text("Delete", `notif:del:${notifId}:menu`)
    .row()
    .text("Remind later", `notif:remind:${notifId}:menu`)
    .row()
    .text("‹ Back", "notif:tab:fired");

  await editOrReply(
    ctx,
    `📬 <b>${escapeHtml(notif.title)}</b>\n\n${body}`,
    keyboard,
  );
}

const SKILL_PRIMERS: Record<string, string> = {
  weekly_curator:   "/curator",
  monthly_audit:    "/curator",
  quarterly_review: "/curator",
};

/**
 * First message sent into the session a notification opens.
 *
 * Three shapes: a skill invocation carrying the last report (the V_rich
 * routines), an outcome-capture prompt for a Scribe reminder, and a generic
 * "help me act on this" for anything else.
 */
export function buildPrimingPrompt(notif: Notification): string {
  const skillPrimer = SKILL_PRIMERS[notif.prompt_key];
  if (skillPrimer) {
    return `${skillPrimer}\n\nLast report (${notif.fired_at}):\n---\n${notif.content}\n---\n\nIf actionable items exist (drafts to promote, MOCs to create, projects to archive), propose them one-by-one and wait for my confirmation before any vault write.`;
  }
  if (notif.prompt_key === "scribe_reminder") {
    return `My reminder just fired: "${notif.title}"\n\n${notif.content}\n\nI've done it. Read the note for context, then help me capture what I learned.`;
  }
  return `Here is a scheduled notification I received. Please help me act on it:\n\n---\n${notif.content}\n---\n\nWhat would you suggest?`;
}

async function handleNewSession(ctx: Context, notifId: string): Promise<void> {
  const notif = await notifStore.get(notifId);
  if (!notif || notif.status === "deleted") {
    await ctx.answerCallbackQuery({ text: "Notification not found" });
    return;
  }

  await notifStore.markRead(notifId);
  const priming = buildPrimingPrompt(notif);

  if (topicsEnabled()) {
    await ctx.answerCallbackQuery({ text: "Opening in new topic…" });
    await markOpened(ctx, notif.title, "opened in a new topic");
    try {
      await spawnTopicSession(ctx.api, {
        name: notif.title,
        primingPrompt: priming,
        ctx,
        // Fired before the priming turn, which can run for minutes — the link
        // is only useful if it arrives when the topic does.
        onTopicCreated: async (key) => {
          const link = key.threadId !== undefined
            ? topicLink(key.chatId, key.threadId)
            : null;
          if (!link) return;
          await ctx.reply(`🧵 <a href="${link}">${escapeHtml(notif.title)}</a>`, {
            parse_mode: "HTML",
          });
        },
      });
    } catch (err) {
      console.error("[notifications] topic spawn failed:", err);
      await ctx.reply(`❌ ${String(err instanceof Error ? err.message : err).slice(0, 400)}`);
    }
    return;
  }

  // No forum group configured: there is nowhere else to put the conversation,
  // so this stays exactly what it was — clear the current session and prime a
  // fresh one in place. The kill() is deliberate here and only here: the
  // button promises a *new* session, and without a second chat the only way
  // to keep that promise is to end the current one.
  const convKey = convKeyFromCtx(ctx);
  const session = registry.get(convKey);

  await ctx.answerCallbackQuery({ text: "Starting new session…" });
  await markOpened(ctx, notif.title, "opened in new session");

  await session.kill();

  const typing = startTypingIndicator(ctx);
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  try {
    const userId = ctx.from?.id ?? 0;
    const username = ctx.from?.username ?? "unknown";
    await runExclusive(convKey, () =>
      session.sendMessageStreaming(
        priming,
        username,
        userId,
        statusCallback,
        ctx.chat?.id,
        ctx,
        convKey.threadId,
      )
    );
  } catch (err) {
    console.error("[notifications] new session error:", err);
    await ctx.reply("Failed to start session.");
  } finally {
    typing.stop();
  }
}

/** Rewrite the notification message so it can't be actioned twice. */
async function markOpened(ctx: Context, title: string, suffix: string): Promise<void> {
  try {
    await ctx.editMessageText(
      `📬 <b>${escapeHtml(title)}</b> — ${suffix}`,
      { parse_mode: "HTML" },
    );
  } catch { /* non-critical */ }
}

async function handleDelete(
  ctx: Context,
  notifId: string,
  source?: string,
): Promise<void> {
  await notifStore.markDeleted(notifId);

  // From the menu (Show → Delete), pop back to the Fired tab so the user
  // can keep clearing the backlog. From a direct notification message
  // (no :menu suffix), keep the original "✕ Notification deleted" terminal.
  if (source === "menu") {
    return renderFiredTab(ctx);
  }

  await ctx.answerCallbackQuery({ text: "Deleted" });
  try {
    await ctx.editMessageText("✕ Notification deleted", {
      reply_markup: new InlineKeyboard(),
    });
  } catch { /* non-critical */ }
}

async function handleRemindLater(
  ctx: Context,
  notifId: string,
  source?: string,
): Promise<void> {
  const notif = await notifStore.get(notifId);
  if (!notif || notif.status === "deleted") {
    await ctx.answerCallbackQuery({ text: "Notification not found" });
    return;
  }

  // Render a duration picker rather than scheduling immediately. The picker
  // keyboard's buttons all hit notif:remind-set with the chosen duration.
  await ctx.answerCallbackQuery();
  await editOrReply(
    ctx,
    `🔔 <b>${escapeHtml(notif.title)}</b>\n\nRemind me in:`,
    reminderPickerKeyboard(notifId, source),
  );
}

async function handleRemindSet(
  ctx: Context,
  notifId: string,
  duration: string,
  source?: string,
): Promise<void> {
  const spec = REMINDER_DURATIONS[duration];
  if (!spec) {
    await ctx.answerCallbackQuery({ text: "Unknown duration" });
    return;
  }

  const notif = await notifStore.get(notifId);
  if (!notif || notif.status === "deleted") {
    await ctx.answerCallbackQuery({ text: "Notification not found" });
    return;
  }

  const remindId = `remind-${crypto.randomUUID().slice(0, 8)}`;
  const fireAt = new Date(Date.now() + spec.ms).toISOString();

  const schedule: Schedule = {
    id: remindId,
    cron: "",
    tz: "Europe/Moscow",
    prompt_key: "remind_later",
    last_fired: null,
    fire_at: fireAt,
    one_shot: true,
    payload: { notification_id: notifId },
  };
  await scheduleOneShot(schedule);

  if (source === "menu") {
    await ctx.answerCallbackQuery({ text: `Will remind in ${spec.label}` });
    return renderFiredTab(ctx);
  }

  await ctx.answerCallbackQuery({ text: `Will remind in ${spec.label}` });
  try {
    await ctx.editMessageText(
      `🔔 <b>${escapeHtml(notif.title)}</b> — reminder set for ${spec.label}`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard() },
    );
  } catch { /* non-critical */ }
}

async function handleRemindCancel(
  ctx: Context,
  notifId: string,
  source?: string,
): Promise<void> {
  await ctx.answerCallbackQuery();

  // From the menu, return to the show view. From a direct notification
  // message, restore the original notification keyboard so the user can
  // pick again (or hit Show / Delete instead).
  if (source === "menu") {
    return handleShow(ctx, notifId);
  }

  const notif = await notifStore.get(notifId);
  if (!notif || notif.status === "deleted") return;

  // Match the original prefix so the message looks unchanged after Cancel.
  // Scribe reminders are surfaced as "⏰ Reminder", routine notifications as
  // "📬 Notification" (see scheduler.ts:fire and fireReminder).
  const prefix = notif.prompt_key === "scribe_reminder"
    ? "⏰ <b>Reminder</b> ·"
    : "📬 <b>Notification</b> ·";

  try {
    await ctx.editMessageText(
      `${prefix} ${escapeHtml(notif.title)}`,
      { parse_mode: "HTML", reply_markup: notificationKeyboard(notifId) },
    );
  } catch { /* non-critical */ }
}

async function handleSchedDel(ctx: Context, schedId: string): Promise<void> {
  await schedulesStore.remove(schedId);
  await ctx.answerCallbackQuery({ text: "Reminder cancelled" });
  return renderScheduledTab(ctx);
}
