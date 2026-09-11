/**
 * Tests for the notif:new action (src/handlers/mode2/notifications.ts).
 *
 * The two branches have opposite contracts and both matter:
 *   - forum group configured → spawn a topic, kill NOTHING;
 *   - not configured        → today's behaviour, kill the current session and
 *     prime a fresh one in place.
 *
 * `topics`, `session-registry` and the notifications store are module-mocked
 * so the handler runs for real without Telegram, the SDK, or bot-data on disk.
 *
 * Bun's module mocks are process-wide and keyed by resolved path — they do NOT
 * end with this file. Two precautions, both load-bearing: each mock spreads the
 * real module so no export goes missing (a missing one is a link error in
 * whichever file imports it next), and afterAll puts the real namespaces back.
 * Without them `tests/topics.test.ts` fails with
 * "Export named 'defaultTopicName' not found".
 *
 * Run with: bun test tests/notification-new-session.test.ts
 */

import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import type { Context } from "grammy";
import type { Notification } from "../src/mode2/types";
import type { ConversationKey } from "../src/conversation";

// ---------------------------------------------------------------------------
// Mocked collaborators
// ---------------------------------------------------------------------------

// Snapshots, not the namespace objects: mock.module mutates the live
// namespace, so holding a reference to it would hand back the *mocked*
// functions in afterAll and restore nothing.
const realTopics = { ...(await import("../src/topics")) };
const realRegistry = { ...(await import("../src/session-registry")) };
const realNotifStore = { ...(await import("../src/mode2/notifications-store")) };

afterAll(() => {
  mock.module("../src/topics", () => ({ ...realTopics }));
  mock.module("../src/session-registry", () => ({ ...realRegistry }));
  mock.module("../src/mode2/notifications-store", () => ({ ...realNotifStore }));
});

let topicsOn = false;
const spawns: {
  name: string;
  primingPrompt?: string;
  onTopicCreated?: (k: ConversationKey) => void | Promise<void>;
}[] = [];
const SPAWNED_KEY: ConversationKey = { chatId: -1002222222222, threadId: 77 };
/** Set to make the next spawn throw, the way Telegram does without rights. */
let spawnError: Error | null = null;

mock.module("../src/topics", () => ({
  ...realTopics,
  topicsEnabled: () => topicsOn,
  topicLink: (_chatId: number, threadId: number) => `https://t.me/c/2222222222/${threadId}`,
  spawnTopicSession: async (_api: unknown, opts: (typeof spawns)[number]) => {
    spawns.push(opts);
    if (spawnError) throw spawnError;
    await opts.onTopicCreated?.(SPAWNED_KEY);
    return SPAWNED_KEY;
  },
}));

const kills: number[] = [];
const streamed: unknown[][] = [];
const fakeSession = {
  isRunning: false,
  isActive: true,
  kill: async () => {
    kills.push(Date.now());
  },
  sendMessageStreaming: async (...args: unknown[]) => {
    streamed.push(args);
    return "ok";
  },
};

mock.module("../src/session-registry", () => ({
  ...realRegistry,
  registry: {
    get: () => fakeSession,
    kill: async () => {},
    isAnyRunning: () => false,
  },
}));

let stored: Notification | undefined;
const readIds: string[] = [];

mock.module("../src/mode2/notifications-store", () => ({
  ...realNotifStore,
  get: async (id: string) => (stored && stored.id === id ? stored : undefined),
  markRead: async (id: string) => {
    readIds.push(id);
  },
  list: async () => (stored ? [stored] : []),
  markDeleted: async () => {},
  append: async () => {},
  unreadCount: async () => 0,
  patchMessageMeta: async () => {},
}));

const { handleNotificationCallback } = await import(
  "../src/handlers/mode2/notifications"
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHAT_X = 555; // where the button is pressed

function notification(over: Partial<Notification> = {}): Notification {
  return {
    id: "n1",
    fired_at: "2026-07-26T20:00:00.000Z",
    prompt_key: "weekly_curator",
    title: "Weekly curator",
    content: "3 stale drafts.",
    status: "unread",
    ...over,
  };
}

interface Rec {
  answers: string[];
  edits: string[];
  replies: string[];
  chatActions: number;
}

function makeCtx(): { ctx: Context; rec: Rec } {
  const rec: Rec = { answers: [], edits: [], replies: [], chatActions: 0 };
  const ctx = {
    chat: { id: CHAT_X, type: "private" },
    from: { id: 42, username: "tester" },
    callbackQuery: {
      data: "notif:new:n1",
      message: { message_id: 9, chat: { id: CHAT_X } },
    },
    answerCallbackQuery: async (o?: { text?: string }) => {
      rec.answers.push(o?.text ?? "");
      return true;
    },
    editMessageText: async (text: string) => {
      rec.edits.push(text);
      return true;
    },
    reply: async (text: string) => {
      rec.replies.push(text);
      return { message_id: 1, chat: { id: CHAT_X } };
    },
    replyWithChatAction: async () => {
      rec.chatActions++;
      return true;
    },
    api: { sendMessage: async () => ({ message_id: 2, chat: { id: CHAT_X } }) },
  } as unknown as Context;
  return { ctx, rec };
}

beforeEach(() => {
  spawns.length = 0;
  kills.length = 0;
  streamed.length = 0;
  readIds.length = 0;
  stored = notification();
});

// ---------------------------------------------------------------------------

describe("with a forum group configured", () => {
  beforeEach(() => {
    topicsOn = true;
  });

  test("spawns a topic and kills nothing", async () => {
    const { ctx, rec } = makeCtx();

    await handleNotificationCallback(ctx);

    expect(spawns.length).toBe(1);
    expect(spawns[0]!.name).toBe("Weekly curator");
    // The whole point of the rewrite: whatever conversation is active in this
    // chat is left running.
    expect(kills.length).toBe(0);
    expect(streamed.length).toBe(0);
    expect(rec.answers[0]).toBe("Opening in new topic…");
    expect(rec.edits[0]).toContain("opened in a new topic");
    expect(readIds).toEqual(["n1"]);
  });

  test("primes the new topic with the same prompt the branching produces", async () => {
    const { ctx } = makeCtx();

    await handleNotificationCallback(ctx);

    expect(spawns[0]!.primingPrompt!.startsWith("/curator")).toBe(true);
    expect(spawns[0]!.primingPrompt).toContain("3 stale drafts.");
  });

  test("the topic link is posted back to the chat the button was pressed in", async () => {
    const { ctx, rec } = makeCtx();

    await handleNotificationCallback(ctx);

    expect(rec.replies.length).toBe(1);
    expect(rec.replies[0]).toContain("https://t.me/c/2222222222/77");
  });

  test("a spawn failure is reported, not swallowed", async () => {
    const { ctx, rec } = makeCtx();
    spawnError = new Error("not enough rights to manage topics");

    try {
      await handleNotificationCallback(ctx);
    } finally {
      spawnError = null;
    }

    expect(rec.replies.some((r) => r.includes("not enough rights"))).toBe(true);
    // A failed spawn must not fall back to trashing the current session.
    expect(kills.length).toBe(0);
    expect(streamed.length).toBe(0);
  });
});

describe("without a forum group", () => {
  beforeEach(() => {
    topicsOn = false;
  });

  test("keeps today's behaviour: kill the session, prime in place", async () => {
    const { ctx, rec } = makeCtx();

    await handleNotificationCallback(ctx);

    expect(spawns.length).toBe(0);
    expect(kills.length).toBe(1);
    expect(streamed.length).toBe(1);
    // (message, username, userId, statusCallback, chatId, ctx, threadId)
    expect(String(streamed[0]![0]).startsWith("/curator")).toBe(true);
    expect(streamed[0]![4]).toBe(CHAT_X);
    expect(rec.answers[0]).toBe("Starting new session…");
    expect(rec.edits[0]).toContain("opened in new session");
  });

  test("the kill happens before the priming turn, not after", async () => {
    const { ctx } = makeCtx();
    const order: string[] = [];
    const killOrig = fakeSession.kill;
    const sendOrig = fakeSession.sendMessageStreaming;
    fakeSession.kill = async () => {
      order.push("kill");
      await killOrig();
    };
    fakeSession.sendMessageStreaming = async (...a: unknown[]) => {
      order.push("send");
      return sendOrig(...a);
    };

    try {
      await handleNotificationCallback(ctx);
    } finally {
      fakeSession.kill = killOrig;
      fakeSession.sendMessageStreaming = sendOrig;
    }

    expect(order).toEqual(["kill", "send"]);
  });
});

describe("guards", () => {
  test("an unknown notification neither spawns nor kills", async () => {
    topicsOn = true;
    stored = undefined;
    const { ctx, rec } = makeCtx();

    await handleNotificationCallback(ctx);

    expect(spawns.length).toBe(0);
    expect(kills.length).toBe(0);
    expect(rec.answers[0]).toBe("Notification not found");
  });

  test("a deleted notification is refused in both modes", async () => {
    for (const flag of [true, false]) {
      topicsOn = flag;
      spawns.length = 0;
      kills.length = 0;
      stored = notification({ status: "deleted" });
      const { ctx } = makeCtx();

      await handleNotificationCallback(ctx);

      expect(spawns.length).toBe(0);
      expect(kills.length).toBe(0);
    }
  });
});
