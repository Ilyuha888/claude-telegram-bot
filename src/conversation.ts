/**
 * Conversation keying for Claude Telegram Bot.
 *
 * A ConversationKey identifies one independent Claude session: a chat, plus
 * an optional forum topic thread within that chat. DMs and the General topic
 * both normalize to threadId=undefined, so they share the exact same key —
 * that's what keeps single-DM behavior unchanged when forum topics aren't in use.
 */

import type { Context } from "grammy";

export type ConversationKey = { chatId: number; threadId: number | undefined };

export function convKeyStr(k: ConversationKey): string {
  return k.threadId !== undefined ? `${k.chatId}:${k.threadId}` : `${k.chatId}`;
}

export function convKeyFromCtx(ctx: Context): ConversationKey {
  if (!ctx.chat) {
    throw new Error("convKeyFromCtx: ctx.chat is undefined");
  }
  const raw = ctx.message?.message_thread_id
    ?? ctx.callbackQuery?.message?.message_thread_id;
  // General topic reports thread_id=1 on some clients, undefined on others — normalize both to undefined
  // so General/DM always resolve to ONE implicit key per chat (today's behavior).
  const threadId = raw === undefined || raw === 1 ? undefined : raw;
  return { chatId: ctx.chat.id, threadId };
}

/**
 * Extra send options that pin a delivery to a forum topic.
 *
 * Returns `{}` — not `{ message_thread_id: undefined }` — when there is no
 * topic, for two reasons. The payload stays clean: no key is emitted for a
 * value that doesn't exist. And these objects are spread into `ctx.reply` /
 * `ctx.replyWith*`, which build their payload as
 * `{ ...(msg?.is_topic_message ? { message_thread_id: msg.message_thread_id } : {}), ...other }`
 * (grammy/out/context.js, `reply()`); an explicit `undefined` in `other` would
 * overwrite that auto-threading, whereas an absent key leaves it intact.
 */
export function threadOpts(threadId?: number): { message_thread_id?: number } {
  return threadId === undefined ? {} : { message_thread_id: threadId };
}

/**
 * An explicit delivery destination: a chat, plus the forum topic inside it.
 *
 * Used when output must go somewhere other than where the triggering update
 * came from — the spawn path creates a topic and streams the primed session's
 * answer into it, while `ctx` still points at the chat the button was pressed
 * in.
 */
export interface DeliveryTarget {
  chatId: number;
  threadId?: number;
}

/**
 * The delivery target for a turn, or undefined when `ctx.reply` is already right.
 *
 * A turn carries the conversation it belongs to (`chatId`/`threadId`) *and* the
 * update that triggered it. Normally those are the same conversation and
 * `ctx.reply` is correct — it also injects business/direct-message fields and
 * auto-threads, so it must be left alone. They diverge on the spawn path: the
 * turn runs in a freshly created topic while `ctx` is the button press from
 * somewhere else, and every send has to be addressed explicitly instead.
 *
 * Note this compares the *thread* too, not just the chat: spawning a topic
 * from the General topic of the same supergroup produces a matching chatId and
 * still needs routing.
 */
export function deliveryTargetFor(
  ctx: Context,
  chatId?: number,
  threadId?: number
): DeliveryTarget | undefined {
  if (chatId === undefined) return undefined;
  // No originating chat means there is nothing for ctx.reply to reply to.
  if (!ctx.chat) return { chatId, threadId };
  const own = convKeyFromCtx(ctx);
  if (own.chatId === chatId && own.threadId === threadId) return undefined;
  return { chatId, threadId };
}
