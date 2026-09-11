/**
 * Tests for where a fired notification is delivered (src/scheduler.ts).
 *
 * Both send sites used to hardcode `chatId = ALLOWED_USER` — the user's id, so
 * their DM — which meant that with a forum group configured every routine and
 * reminder landed in the private chat while the buttons on those cards
 * ("Open in new chat") acted on the group. The card and the conversation it
 * spawns belong in the same place.
 *
 * The DM stays as a fallback: a notification has no user action behind it, so an
 * unreachable group has nobody to report the failure to, and losing the daily
 * routine silently is worse than delivering it to the old address.
 *
 * Run with: bun test tests/notification-delivery.test.ts
 */

import { describe, test, expect } from "bun:test";
import { InlineKeyboard } from "grammy";
import { notificationTargets, deliverCard } from "../src/scheduler";

const GROUP = -1004415407520;
const USER = 751936510;
const TEXT = "📬 Notification · Daily focus";
const KB = new InlineKeyboard().text("Show", "notif:show:x");

/** A sender that succeeds for the listed chats and throws for the rest. */
function sender(...accepts: number[]) {
  const calls: number[] = [];
  const send = async (chatId: number) => {
    calls.push(chatId);
    if (!accepts.includes(chatId)) throw new Error(`Forbidden: bot is not a member of ${chatId}`);
    return { message_id: 1000 + calls.length };
  };
  return { send, calls };
}

describe("notificationTargets", () => {
  test("prefers the group, keeps the DM as fallback", () => {
    expect(notificationTargets(GROUP, USER)).toEqual([GROUP, USER]);
  });

  test("falls back to the DM alone when no group is configured", () => {
    // The single-DM deployment: unchanged behaviour, which is the whole
    // contract around TELEGRAM_GROUP_CHAT_ID being unset.
    expect(notificationTargets(null, USER)).toEqual([USER]);
  });

  test("never lists the same chat twice", () => {
    // Pathological but cheap to rule out: a duplicate would send the card twice
    // and record only the second message id.
    expect(notificationTargets(USER, USER)).toEqual([USER]);
  });

  test("yields nothing when there is nowhere to deliver", () => {
    expect(notificationTargets(null, null)).toEqual([]);
    expect(notificationTargets(null, NaN)).toEqual([]);
  });
});

describe("deliverCard", () => {
  test("delivers to the group and reports it, without touching the DM", () => {
    const { send, calls } = sender(GROUP, USER);

    return deliverCard(send, [GROUP, USER], TEXT, KB).then((res) => {
      expect(res).toEqual({ messageId: 1001, chatId: GROUP });
      expect(calls).toEqual([GROUP]);
    });
  });

  test("falls back to the DM when the group rejects", async () => {
    const { send, calls } = sender(USER);

    const res = await deliverCard(send, [GROUP, USER], TEXT, KB);

    // The reported chatId must be the DM, not the group that refused: it is
    // what patchMessageMeta stores, and the callback buttons edit that message.
    expect(res).toEqual({ messageId: 1002, chatId: USER });
    expect(calls).toEqual([GROUP, USER]);
  });

  test("returns null when every target refuses", async () => {
    const { send, calls } = sender();

    expect(await deliverCard(send, [GROUP, USER], TEXT, KB)).toBeNull();
    expect(calls).toEqual([GROUP, USER]);
  });

  test("returns null for an empty target list without calling the API", async () => {
    const { send, calls } = sender(GROUP);

    expect(await deliverCard(send, [], TEXT, KB)).toBeNull();
    expect(calls).toEqual([]);
  });
});
