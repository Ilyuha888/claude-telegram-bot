/**
 * Tests for `/close` (src/handlers/commands.ts).
 *
 * Four contracts:
 *   - in a forum topic → abort any query in flight, confirm, then close the
 *     topic and retire its session;
 *   - in a DM or the General topic → refuse with something actionable, and
 *     close nothing;
 *   - with a slug argument → hand off to mode-2's work-session close, which
 *     owned this verb first.
 *
 * `topics` (for the shared closeTopic primitive), `topics-store`, the session
 * registry and mode-2's close handler are module-mocked; the dispatcher and the
 * topic handler run for real.
 *
 * Bun's module mocks are process-wide and keyed by resolved path — they do NOT
 * end with this file. Two precautions, both load-bearing: each mock spreads the
 * real module so no export goes missing, and afterAll puts the real namespaces
 * back. (See tests/notification-new-session.test.ts for the same dance.)
 *
 * Run with: bun test tests/close-command.test.ts
 */

import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import type { Context } from "grammy";
import type { CloseTopicResult } from "../src/topics";

const GROUP = -1002222222222;
const THREAD = 77;

/**
 * The authorized user is fixed here rather than read from config, because
 * config resolves TELEGRAM_ALLOWED_USER from the ambient environment: these
 * tests used to pass only on a machine with a populated .env, and any value
 * that makes `isAuthorized` unable to succeed took the whole file down with it.
 * CI sets TELEGRAM_ALLOWED_USER=0, and isAuthorized() rejects a zero
 * allowedUser outright (src/security.ts), so every authorized path here failed
 * there while passing locally. Pinning it makes the file hermetic.
 */
const TEST_USER = 751936510;

const realTopics = { ...(await import("../src/topics")) };
const realTopicsStore = { ...(await import("../src/topics-store")) };
const realRegistry = { ...(await import("../src/session-registry")) };
const realWorkClose = { ...(await import("../src/handlers/mode2/close")) };
const realConfig = { ...(await import("../src/config")) };

mock.module("../src/config", () => ({ ...realConfig, ALLOWED_USER: TEST_USER }));

afterAll(() => {
  mock.module("../src/topics", () => ({ ...realTopics }));
  mock.module("../src/topics-store", () => ({ ...realTopicsStore }));
  mock.module("../src/session-registry", () => ({ ...realRegistry }));
  mock.module("../src/handlers/mode2/close", () => ({ ...realWorkClose }));
  mock.module("../src/config", () => ({ ...realConfig }));
});

let topicsOn = true;
const closes: { chat_id: number; thread_id: number; reason: string }[] = [];
let closeResult: CloseTopicResult = { ok: true };

mock.module("../src/topics", () => ({
  ...realTopics,
  topicsEnabled: () => topicsOn,
  closeTopic: async (
    _api: unknown,
    topic: { chat_id: number; thread_id: number },
    reason: string
  ) => {
    trace.push("close");
    closes.push({ ...topic, reason });
    return closeResult;
  },
}));

mock.module("../src/topics-store", () => ({
  ...realTopicsStore,
  get: async (threadId: number) =>
    threadId === THREAD
      ? {
          thread_id: THREAD,
          chat_id: GROUP,
          name: "Visa paperwork",
          created_at: "2026-07-20T10:00:00.000Z",
          session_id: "sess-1",
          last_active_at: "2026-07-20T10:00:00.000Z",
        }
      : undefined,
}));

/** Ordered log of everything the handler does, so ordering can be asserted. */
const trace: string[] = [];
/** A session in the registry for THREAD, or null for "nothing in memory". */
let liveSession: {
  isRunning: boolean;
  stop: () => Promise<"stopped" | "pending" | false>;
  clearStopRequested: () => void;
} | null = null;
const peeked: (number | undefined)[] = [];
let gets = 0;

mock.module("../src/session-registry", () => ({
  ...realRegistry,
  registry: {
    get: () => {
      gets++;
      return liveSession;
    },
    peek: (key: { threadId?: number }) => {
      peeked.push(key.threadId);
      return liveSession ?? undefined;
    },
    kill: async () => {},
    isAnyRunning: () => false,
    evictIdle: () => [],
  },
}));

function runningSession() {
  return {
    isRunning: true,
    stop: async () => {
      trace.push("stop");
      return "stopped" as const;
    },
    clearStopRequested: () => {
      trace.push("clearStopRequested");
    },
  };
}

const workCloses: string[] = [];
mock.module("../src/handlers/mode2/close", () => ({
  ...realWorkClose,
  handleClose: async (ctx: Context) => {
    workCloses.push(String(ctx.match ?? ""));
  },
}));

const { handleCloseTopic, handleCloseCommand } = await import("../src/handlers/commands");

// ---------------------------------------------------------------------------

interface Rec {
  replies: string[];
}

function makeCtx(
  opts: { threadId?: number; chatId?: number; match?: string; userId?: number } = {}
): { ctx: Context; rec: Rec } {
  const rec: Rec = { replies: [] };
  const ctx = {
    chat: { id: opts.chatId ?? GROUP, type: "supergroup" },
    from: { id: opts.userId ?? TEST_USER, username: "tester" },
    match: opts.match,
    message: {
      message_id: 5,
      message_thread_id: opts.threadId,
      text: opts.match ? `/close ${opts.match}` : "/close",
    },
    api: {},
    reply: async (text: string) => {
      trace.push("reply");
      rec.replies.push(text);
      return { message_id: 6 };
    },
  } as unknown as Context;
  return { ctx, rec };
}

beforeEach(() => {
  topicsOn = true;
  closes.length = 0;
  workCloses.length = 0;
  trace.length = 0;
  peeked.length = 0;
  gets = 0;
  liveSession = null;
  closeResult = { ok: true };
});

// ---------------------------------------------------------------------------

describe("in a forum topic", () => {
  test("closes the topic it was sent in", async () => {
    const { ctx, rec } = makeCtx({ threadId: THREAD });

    await handleCloseTopic(ctx);

    expect(closes).toEqual([{ chat_id: GROUP, thread_id: THREAD, reason: "user" }]);
    expect(rec.replies[0]).toContain("Visa paperwork");
    expect(rec.replies[0]).toContain("closed");
  });

  test("confirms BEFORE closing, so the confirmation can't land in a closed topic", async () => {
    const { ctx, rec } = makeCtx({ threadId: THREAD });

    await handleCloseTopic(ctx);

    expect(trace).toEqual(["reply", "close"]);
    expect(rec.replies.length).toBe(1);
  });

  test("tells the user the conversation survives", async () => {
    // The SDK session is deliberately left on disk, and this line is the only
    // place the user is told reopening resumes it.
    const { ctx, rec } = makeCtx({ threadId: THREAD });

    await handleCloseTopic(ctx);

    expect(rec.replies[0]).toMatch(/[Rr]eopen/);
  });

  test("falls back to the thread id when the store has never seen the topic", async () => {
    const { ctx, rec } = makeCtx({ threadId: 12345 });

    await handleCloseTopic(ctx);

    expect(closes[0]!.thread_id).toBe(12345);
    expect(rec.replies[0]).toContain("thread 12345");
  });

  test("a refusal is corrected, with the missing permission named", async () => {
    closeResult = { ok: false, error: "not enough rights to manage topics" };
    const { ctx, rec } = makeCtx({ threadId: THREAD });

    await handleCloseTopic(ctx);

    expect(rec.replies.length).toBe(2);
    expect(rec.replies[1]).toContain("still open");
    expect(rec.replies[1]).toContain("Manage Topics");
    expect(rec.replies[1]).toContain("not enough rights");
  });

  test("aborts a query in flight before closing", async () => {
    // registry.kill() clears session state but never signals the abort
    // controller. Without an explicit stop the claude subprocess outlives the
    // close and keeps streaming edits into a topic Telegram has locked — which
    // the bot, as an admin with "Manage Topics", is uniquely able to do.
    liveSession = runningSession();
    const { ctx } = makeCtx({ threadId: THREAD });

    await handleCloseTopic(ctx);

    expect(trace).toEqual(["stop", "clearStopRequested", "reply", "close"]);
    expect(closes.length).toBe(1);
  });

  test("says so, rather than silently binning the work", async () => {
    liveSession = runningSession();
    const { ctx, rec } = makeCtx({ threadId: THREAD });

    await handleCloseTopic(ctx);

    expect(rec.replies[0]).toContain("interrupted");
  });

  test("stop-and-close, not refuse-if-busy", async () => {
    // The cap and the idle reaper skip a busy topic because they are choosing
    // among topics and can pick another. /close names one and has no
    // alternative — refusing would mean typing /stop and /close for one intent.
    liveSession = runningSession();
    const { ctx } = makeCtx({ threadId: THREAD });

    await handleCloseTopic(ctx);

    expect(closes).toEqual([{ chat_id: GROUP, thread_id: THREAD, reason: "user" }]);
  });

  test("an idle session is left alone — no stop, no interruption notice", async () => {
    liveSession = { ...runningSession(), isRunning: false };
    const { ctx, rec } = makeCtx({ threadId: THREAD });

    await handleCloseTopic(ctx);

    expect(trace).toEqual(["reply", "close"]);
    expect(rec.replies[0]).not.toContain("interrupted");
  });

  test("a topic with nothing in memory closes without materialising a session", async () => {
    // peek, not get: /close must not create the very thing it is retiring.
    liveSession = null;
    const { ctx } = makeCtx({ threadId: THREAD });

    await handleCloseTopic(ctx);

    expect(peeked).toEqual([THREAD]);
    expect(gets).toBe(0);
    expect(trace).toEqual(["reply", "close"]);
  });

  test("an unauthorized user closes nothing", async () => {
    const { ctx, rec } = makeCtx({ threadId: THREAD, userId: TEST_USER + 1 });

    await handleCloseTopic(ctx);

    expect(closes).toEqual([]);
    expect(rec.replies).toEqual(["Unauthorized."]);
  });
});

describe("outside a topic", () => {
  test("refuses in a DM and points at /new", async () => {
    const { ctx, rec } = makeCtx({ chatId: TEST_USER, threadId: undefined });

    await handleCloseTopic(ctx);

    expect(closes).toEqual([]);
    expect(rec.replies[0]).toContain("No topic to close");
    expect(rec.replies[0]).toContain("/new");
  });

  test("refuses in the General topic, which reports thread 1", async () => {
    // convKeyFromCtx normalizes thread 1 to "no thread"; General is the
    // supergroup's root and cannot be closed.
    const { ctx, rec } = makeCtx({ threadId: 1 });

    await handleCloseTopic(ctx);

    expect(closes).toEqual([]);
    expect(rec.replies[0]).toContain("General topic");
  });

  test("still explains the work-session form of the command", async () => {
    const { ctx, rec } = makeCtx({ chatId: TEST_USER, threadId: undefined });

    await handleCloseTopic(ctx);

    expect(rec.replies[0]).toContain("/close &lt;slug&gt;");
  });

  test("with topics unconfigured it doesn't dangle /topic in front of the user", async () => {
    topicsOn = false;
    const { ctx, rec } = makeCtx({ chatId: TEST_USER, threadId: undefined });

    await handleCloseTopic(ctx);

    expect(rec.replies[0]).not.toContain("/topic");
    expect(rec.replies[0]).toContain("/new");
  });
});

describe("dispatch between the two objects named /close", () => {
  test("a slug goes to the work-session handler, not the topic one", async () => {
    const { ctx } = makeCtx({ threadId: THREAD, match: "data-style-feat-x" });

    await handleCloseCommand(ctx);

    expect(workCloses).toEqual(["data-style-feat-x"]);
    expect(closes).toEqual([]);
  });

  test("no argument closes the topic", async () => {
    const { ctx } = makeCtx({ threadId: THREAD });

    await handleCloseCommand(ctx);

    expect(workCloses).toEqual([]);
    expect(closes.length).toBe(1);
  });

  test("whitespace is not an argument", async () => {
    const { ctx } = makeCtx({ threadId: THREAD, match: "   " });

    await handleCloseCommand(ctx);

    expect(workCloses).toEqual([]);
    expect(closes.length).toBe(1);
  });
});
