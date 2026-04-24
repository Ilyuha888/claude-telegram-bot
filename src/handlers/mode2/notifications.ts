import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { session } from "../../session";
import { escapeHtml, convertMarkdownToHtml } from "../../formatting";
import * as notifStore from "../../mode2/notifications-store";
import * as schedulesStore from "../../mode2/schedules-store";
import type { Schedule } from "../../mode2/types";
import { StreamingState, createStatusCallback } from "../streaming";
import { startTypingIndicator } from "../../utils";

function notificationKeyboard(notifId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Show", `notif:show:${notifId}`)
    .text("New session", `notif:new:${notifId}`)
    .row()
    .text("Delete", `notif:del:${notifId}`)
    .text("Remind later", `notif:remind:${notifId}`);
}

export async function handleNotificationCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const parts = data.split(":");
  const action = parts[1];
  const notifId = parts[2];

  if (!action || !notifId) {
    await ctx.answerCallbackQuery({ text: "Invalid notification callback" });
    return;
  }

  switch (action) {
    case "show":
      return handleShow(ctx, notifId);
    case "new":
      return handleNewSession(ctx, notifId);
    case "del":
      return handleDelete(ctx, notifId);
    case "remind":
      return handleRemindLater(ctx, notifId);
    case "tab":
      return renderNotificationsTab(ctx);
    default:
      await ctx.answerCallbackQuery({ text: "Unknown action" });
  }
}

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
    .text("‹ Back", "m2:notifications");

  try {
    await ctx.editMessageText(
      `📬 <b>${escapeHtml(notif.title)}</b>\n\n${body}`,
      { parse_mode: "HTML", reply_markup: keyboard },
    );
  } catch {
    await ctx.reply(
      `📬 <b>${escapeHtml(notif.title)}</b>\n\n${body}`,
      { parse_mode: "HTML", reply_markup: keyboard },
    );
  }
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

  const priming = `Here is a scheduled notification I received. Please help me act on it:\n\n---\n${notif.content}\n---\n\nWhat would you suggest?`;

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
  await schedulesStore.upsert(schedule);

  await ctx.answerCallbackQuery({ text: "Will remind in 1 hour" });

  try {
    await ctx.editMessageText(
      `🔔 <b>${escapeHtml(notif.title)}</b> — reminder set for 1h`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard() },
    );
  } catch { /* non-critical */ }
}

export async function renderNotificationsTab(ctx: Context): Promise<void> {
  const all = await notifStore.list();
  const recent = all.slice(0, 10);

  if (recent.length === 0) {
    try {
      await ctx.editMessageText("No notifications.", {
        reply_markup: new InlineKeyboard().text("‹ Back", "m2:menu"),
      });
    } catch {
      await ctx.reply("No notifications.", {
        reply_markup: new InlineKeyboard().text("‹ Back", "m2:menu"),
      });
    }
    return;
  }

  const lines = recent.map((n) => {
    const icon = n.status === "unread" ? "●" : "○";
    const age = Math.floor((Date.now() - new Date(n.fired_at).getTime()) / 60_000);
    const ageStr = age < 60 ? `${age}m` : `${Math.floor(age / 60)}h`;
    return `${icon} <b>${escapeHtml(n.title)}</b> — ${ageStr} ago`;
  });

  const kb = new InlineKeyboard();
  for (const n of recent) {
    kb.text(
      `${n.status === "unread" ? "● " : ""}${n.title.slice(0, 25)}`,
      `notif:show:${n.id}`,
    ).row();
  }
  kb.text("‹ Back", "m2:menu");

  const text = `<b>Notifications</b>\n\n${lines.join("\n")}`;

  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  } catch {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }
}
