import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { session } from "../../session";
import { escapeHtml, convertMarkdownToHtml } from "../../formatting";
import * as notifStore from "../../mode2/notifications-store";
import * as schedulesStore from "../../mode2/schedules-store";
import { scheduleOneShot } from "../../scheduler";
import type { Schedule } from "../../mode2/types";
import { StreamingState, createStatusCallback } from "../streaming";
import { startTypingIndicator } from "../../utils";

// ── Helpers ───────────────────────────────────────────────────────────────────

function notificationKeyboard(notifId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Show", `notif:show:${notifId}`)
    .text("New session", `notif:new:${notifId}`)
    .row()
    .text("Delete", `notif:del:${notifId}`)
    .text("Remind later", `notif:remind:${notifId}`);
}

function relativeTime(isoOrNull: string | null): string {
  if (!isoOrNull) return "never";
  const mins = Math.floor((Date.now() - new Date(isoOrNull).getTime()) / 60_000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / (60 * 24))}d ago`;
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
    case "show":   if (arg) return handleShow(ctx, arg); break;
    case "new":    if (arg) return handleNewSession(ctx, arg); break;
    case "del":    if (arg) return handleDelete(ctx, arg); break;
    case "remind": if (arg) return handleRemindLater(ctx, arg); break;
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

  if (reminders.length > 0) {
    lines.push(`\n🔔 <b>Pending reminders</b>`);
    for (const r of reminders) {
      const fireAt = r.last_fired ? new Date(r.last_fired) : null;
      const inMs = fireAt ? fireAt.getTime() - Date.now() : 0;
      const inMin = Math.max(0, Math.round(inMs / 60_000));
      lines.push(`   fires in ~${inMin}m`);
    }
  }

  const firedCount = (await notifStore.list()).length;
  const firedLabel = firedCount > 0 ? `📬 Fired  (${firedCount})` : "📬 Fired";

  const kb = new InlineKeyboard()
    .text(firedLabel, "notif:tab:fired").row()
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
  const keyboard = new InlineKeyboard()
    .text("New session", `notif:new:${notifId}`)
    .text("Delete", `notif:del:${notifId}`)
    .row()
    .text("Remind later", `notif:remind:${notifId}`)
    .row()
    .text("‹ Back", "notif:tab:fired");

  await editOrReply(
    ctx,
    `📬 <b>${escapeHtml(notif.title)}</b>\n\n${body}`,
    keyboard,
  );
}

async function handleNewSession(ctx: Context, notifId: string): Promise<void> {
  const notif = await notifStore.get(notifId);
  if (!notif || notif.status === "deleted") {
    await ctx.answerCallbackQuery({ text: "Notification not found" });
    return;
  }

  await notifStore.markRead(notifId);
  await ctx.answerCallbackQuery({ text: "Starting new session…" });

  try {
    await ctx.editMessageText(
      `📬 <b>${escapeHtml(notif.title)}</b> — opened in new session`,
      { parse_mode: "HTML" },
    );
  } catch { /* non-critical */ }

  await session.kill();

  const typing = startTypingIndicator(ctx);
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  const SKILL_PRIMERS: Record<string, string> = {
    weekly_curator:   "/curator",
    monthly_audit:    "/curator",
    quarterly_review: "/curator",
  };
  const skillPrimer = SKILL_PRIMERS[notif.prompt_key];

  let priming: string;
  if (skillPrimer) {
    priming = skillPrimer;
  } else if (notif.prompt_key === "scribe_reminder") {
    priming = `My reminder just fired: "${notif.title}"\n\n${notif.content}\n\nI've done it. Read the note for context, then help me capture what I learned.`;
  } else {
    priming = `Here is a scheduled notification I received. Please help me act on it:\n\n---\n${notif.content}\n---\n\nWhat would you suggest?`;
  }

  try {
    const userId = ctx.from?.id ?? 0;
    const username = ctx.from?.username ?? "unknown";
    await session.sendMessageStreaming(
      priming,
      username,
      userId,
      statusCallback,
      ctx.chat?.id,
      ctx,
    );
  } catch (err) {
    console.error("[notifications] new session error:", err);
    await ctx.reply("Failed to start session.");
  } finally {
    typing.stop();
  }
}

async function handleDelete(ctx: Context, notifId: string): Promise<void> {
  await notifStore.markDeleted(notifId);
  await ctx.answerCallbackQuery({ text: "Deleted" });

  try {
    await ctx.editMessageText("✕ Notification deleted", {
      reply_markup: new InlineKeyboard(),
    });
  } catch { /* non-critical */ }
}

async function handleRemindLater(ctx: Context, notifId: string): Promise<void> {
  const notif = await notifStore.get(notifId);
  if (!notif || notif.status === "deleted") {
    await ctx.answerCallbackQuery({ text: "Notification not found" });
    return;
  }

  const remindId = `remind-${crypto.randomUUID().slice(0, 8)}`;
  const fireAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const schedule: Schedule = {
    id: remindId,
    cron: "",
    tz: "Europe/Moscow",
    prompt_key: "remind_later",
    last_fired: fireAt,
    one_shot: true,
    payload: { notification_id: notifId },
  };
  await scheduleOneShot(schedule);

  await ctx.answerCallbackQuery({ text: "Will remind in 1 hour" });

  try {
    await ctx.editMessageText(
      `🔔 <b>${escapeHtml(notif.title)}</b> — reminder set for 1h`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard() },
    );
  } catch { /* non-critical */ }
}
