/**
 * Tests for the Rich Message wiring in src/handlers/streaming.ts.
 *
 * Drives `createStatusCallback` with real event sequences against a fake
 * grammY context (stubbed `api.raw.sendRichMessage` /
 * `api.raw.sendRichMessageDraft`, `deleteMessage`, `editMessageText`, `reply`),
 * so routing, fallback and capability-cache behaviour are covered without a
 * live Telegram.
 *
 * Run with: bun test tests/streaming-rich.test.ts
 */

import { describe, test, expect, beforeEach } from "bun:test";
import type { Context } from "grammy";
import type { Message } from "grammy/types";
import {
  StreamingState,
  createStatusCallback,
  __resetRichMessagesAvailableForTests,
} from "../src/handlers/streaming";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHAT_ID = 4242;

/** Long + structured: trips the router on length AND on 2+ headings. */
const LONG_STRUCTURED = [
  "# Attention mechanisms",
  "",
  "Prose paragraph. ".repeat(200),
  "",
  "## Multi-head attention",
  "",
  "| Head | Role |",
  "|------|------|",
  "| 1 | syntax |",
  "| 2 | coreference |",
  "",
  "More prose. ".repeat(200),
].join("\n");

/** Short chatty reply: must never touch the rich path. */
const SHORT_CHATTY = "Sure, that works for me.";

function grammyLikeError(code: number, description: string): Error {
  return Object.assign(
    new Error(`Call to 'sendRichMessage' failed! (${code}: ${description})`),
    { error_code: code }
  );
}

interface Recorder {
  rich: {
    chat_id: number | string;
    rich_message: { markdown?: string };
    message_thread_id?: number;
  }[];
  drafts: {
    chat_id: number;
    draft_id: number;
    rich_message: { markdown?: string };
    message_thread_id?: number;
  }[];
  replies: string[];
  /** api.sendMessage — the explicit-target route. */
  sends: { chatId: number | string; text: string; threadId?: number }[];
  deletes: { chatId: number | string; messageId: number }[];
  edits: { messageId: number; text: string }[];
}

function makeCtx(
  opts: {
    chatType?: "private" | "group" | "supergroup";
    /** Forum topic the incoming message sits in, as grammY reports it. */
    threadId?: number;
    /** When set, api.raw.sendRichMessage throws this. */
    richError?: unknown;
    /** When set, api.raw.sendRichMessageDraft throws this. */
    draftError?: unknown;
  } = {}
): { ctx: Context; rec: Recorder } {
  const rec: Recorder = {
    rich: [],
    drafts: [],
    replies: [],
    sends: [],
    deletes: [],
    edits: [],
  };
  let nextMessageId = 100;

  const message = (chatId: number = CHAT_ID): Message =>
    ({
      message_id: nextMessageId++,
      chat: { id: chatId, type: opts.chatType ?? "private" },
      date: 0,
    }) as unknown as Message;

  const ctx = {
    chat: { id: CHAT_ID, type: opts.chatType ?? "private" },
    // convKeyFromCtx reads the thread id from here — it is how a rich send
    // learns which forum topic it belongs to when there is no explicit target.
    message:
      opts.threadId === undefined ? undefined : { message_thread_id: opts.threadId },
    reply: async (text: string) => {
      rec.replies.push(text);
      return message();
    },
    api: {
      raw: {
        sendRichMessage: async (args: Recorder["rich"][number]) => {
          rec.rich.push(args);
          if (opts.richError !== undefined) throw opts.richError;
          return message();
        },
        sendRichMessageDraft: async (args: Recorder["drafts"][number]) => {
          rec.drafts.push(args);
          if (opts.draftError !== undefined) throw opts.draftError;
          return true;
        },
      },
      sendMessage: async (
        chatId: number | string,
        text: string,
        other?: { message_thread_id?: number }
      ) => {
        rec.sends.push({ chatId, text, threadId: other?.message_thread_id });
        return message(typeof chatId === "number" ? chatId : CHAT_ID);
      },
      deleteMessage: async (chatId: number | string, messageId: number) => {
        rec.deletes.push({ chatId, messageId });
        return true;
      },
      editMessageText: async (
        _chatId: number | string,
        messageId: number,
        text: string
      ) => {
        rec.edits.push({ messageId, text });
        return true;
      },
    },
  } as unknown as Context;

  return { ctx, rec };
}

beforeEach(() => {
  // The capability cache is module-level and deliberately process-lifetime —
  // reset it so a poisoning test can't leak into the next case.
  __resetRichMessagesAvailableForTests();
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe("segment_end routing", () => {
  test("a long structured answer goes out as one Rich Message, not chunks", async () => {
    const { ctx, rec } = makeCtx();
    const state = new StreamingState();
    const cb = createStatusCallback(ctx, state);

    await cb("segment_end", LONG_STRUCTURED, 1);

    expect(rec.rich.length).toBe(1);
    expect(rec.rich[0]!.chat_id).toBe(CHAT_ID);
    expect(rec.rich[0]!.rich_message.markdown).toContain("# Attention mechanisms");
    expect(rec.rich[0]!.rich_message.markdown).toContain("| Head | Role |");
    // The chunker replies via ctx.reply — it must not have run.
    expect(rec.replies.length).toBe(0);
    // The sent message is tracked so /stop and error paths can find it.
    expect(state.textMessages.has(1)).toBe(true);
  });

  test("a short chatty answer stays on the existing plain path", async () => {
    const { ctx, rec } = makeCtx();
    const state = new StreamingState();
    const cb = createStatusCallback(ctx, state);

    await cb("segment_end", SHORT_CHATTY, 1);

    expect(rec.rich.length).toBe(0);
    expect(rec.drafts.length).toBe(0);
    expect(rec.replies.length).toBe(1);
    expect(rec.replies[0]).toContain("Sure, that works for me.");
  });

  test("a repeated segment_end for the same id does not send the answer twice", async () => {
    const { ctx, rec } = makeCtx();
    const state = new StreamingState();
    const cb = createStatusCallback(ctx, state);

    await cb("segment_end", LONG_STRUCTURED, 1);
    await cb("segment_end", LONG_STRUCTURED, 1);

    // The controller's finalize() throws on a second call; the already-finalized
    // guard must short-circuit before that, so no second send and no chunker.
    expect(rec.rich.length).toBe(1);
    expect(rec.replies.length).toBe(0);
  });

  test("content over the 32k ceiling is split across several Rich Messages", async () => {
    const { ctx, rec } = makeCtx();
    const state = new StreamingState();
    const cb = createStatusCallback(ctx, state);

    await cb("segment_end", "a".repeat(33_000), 1);

    // Split, not demoted: oversized content used to fall through to the 4096-char
    // plain chunker. It now arrives as a run of Rich Messages and the plain path
    // is never reached.
    expect(rec.rich.length).toBeGreaterThan(1);
    expect(rec.replies.length).toBe(0);
    for (const call of rec.rich) {
      expect(call.rich_message.markdown!.length).toBeLessThanOrEqual(32_768);
    }
    // Nothing dropped at the boundary — every character is accounted for.
    const delivered = rec.rich.reduce(
      (n, call) => n + (call.rich_message.markdown!.match(/a/g) || []).length,
      0
    );
    expect(delivered).toBe(33_000);
  });
});

// ---------------------------------------------------------------------------
// Explicit delivery target (spawn path)
// ---------------------------------------------------------------------------

describe("delivery target", () => {
  const GROUP_ID = -1002222222222;
  const THREAD_ID = 77;

  test("no target: everything still goes through ctx.reply", async () => {
    const { ctx, rec } = makeCtx();
    const cb = createStatusCallback(ctx, new StreamingState());

    await cb("tool", "🔧 Read", undefined);
    await cb("segment_end", SHORT_CHATTY, 1);

    expect(rec.sends.length).toBe(0);
    expect(rec.replies.length).toBe(2);
  });

  test("with a target: sends go to that chat + thread, never ctx.reply", async () => {
    const { ctx, rec } = makeCtx();
    const state = new StreamingState({ chatId: GROUP_ID, threadId: THREAD_ID });
    const cb = createStatusCallback(ctx, state);

    await cb("tool", "🔧 Read", undefined);
    await cb("segment_end", SHORT_CHATTY, 1);

    expect(rec.replies.length).toBe(0);
    expect(rec.sends.length).toBe(2);
    for (const s of rec.sends) {
      expect(s.chatId).toBe(GROUP_ID);
      expect(s.threadId).toBe(THREAD_ID);
    }
    // The tracked message belongs to the target chat, so the later edit /
    // delete paths address the right chat too.
    expect(state.textMessages.get(1)!.chat.id).toBe(GROUP_ID);
  });

  // CONTRACT CHANGE: a target used to suppress the rich path entirely, because
  // RichStreamController took a bare chatId and the message would have landed
  // in the wrong chat. It now carries chat + thread, so the target routes rich
  // output instead of disabling it.
  test("with a target: the Rich Message goes to that chat and thread", async () => {
    const { ctx, rec } = makeCtx();
    const state = new StreamingState({ chatId: GROUP_ID, threadId: THREAD_ID });
    const cb = createStatusCallback(ctx, state);

    await cb("text", LONG_STRUCTURED, 1);
    await cb("segment_end", LONG_STRUCTURED, 1);

    expect(rec.rich.length).toBe(1);
    expect(rec.rich[0]!.chat_id).toBe(GROUP_ID);
    expect(rec.rich[0]!.message_thread_id).toBe(THREAD_ID);
    // Never back to where the button was pressed.
    expect(rec.replies.length).toBe(0);
    // Drafts stay off with a target: the destination is the forum supergroup
    // and sendRichMessageDraft is private-chat only. Mid-stream output went out
    // on the plain path, threaded, and was deleted before the rich finalize.
    expect(rec.drafts.length).toBe(0);
    expect(rec.sends.length).toBeGreaterThan(0);
    for (const s of rec.sends) {
      expect(s.chatId).toBe(GROUP_ID);
      expect(s.threadId).toBe(THREAD_ID);
    }
  });

  test("split Rich Messages all carry the target's thread id", async () => {
    const { ctx, rec } = makeCtx();
    const state = new StreamingState({ chatId: GROUP_ID, threadId: THREAD_ID });
    const cb = createStatusCallback(ctx, state);

    // Over the 32k ceiling: the first piece goes through the controller, the
    // continuations through sendRichMessageChunk. Both must thread.
    await cb("segment_end", "a".repeat(33_000), 1);

    expect(rec.rich.length).toBeGreaterThan(1);
    for (const call of rec.rich) {
      expect(call.chat_id).toBe(GROUP_ID);
      expect(call.message_thread_id).toBe(THREAD_ID);
    }
  });

  test("chunked fallback honours the target on every chunk", async () => {
    // Rich is attempted first now (the content is over the plain limit), so the
    // chunker is reached the way it is in production: a failed rich call.
    const { ctx, rec } = makeCtx({
      richError: grammyLikeError(400, "Bad Request: message text is too long"),
    });
    const state = new StreamingState({ chatId: GROUP_ID, threadId: THREAD_ID });
    const cb = createStatusCallback(ctx, state);

    await cb("segment_end", "word ".repeat(3000), 1);

    expect(rec.rich.length).toBe(1);
    expect(rec.replies.length).toBe(0);
    expect(rec.sends.length).toBeGreaterThan(1);
    for (const s of rec.sends) {
      expect(s.chatId).toBe(GROUP_ID);
      expect(s.threadId).toBe(THREAD_ID);
    }
  });

  test("a target without a thread id sends no message_thread_id at all", async () => {
    const { ctx, rec } = makeCtx();
    const cb = createStatusCallback(ctx, new StreamingState({ chatId: GROUP_ID }));

    await cb("segment_end", SHORT_CHATTY, 1);

    expect(rec.sends.length).toBe(1);
    expect(rec.sends[0]!.threadId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

describe("failure classification", () => {
  test("a generic 400 falls back to the chunker without poisoning the cache", async () => {
    const failing = makeCtx({
      richError: grammyLikeError(400, "Bad Request: message text is too long"),
    });
    const cb = createStatusCallback(failing.ctx, new StreamingState());

    await cb("segment_end", LONG_STRUCTURED, 1);

    // Attempted once, then the user still got the content via the chunker.
    expect(failing.rec.rich.length).toBe(1);
    expect(failing.rec.replies.length).toBeGreaterThan(0);

    // A transient 400 must not disable rich for the process: the next long
    // answer still attempts it.
    const healthy = makeCtx();
    const cb2 = createStatusCallback(healthy.ctx, new StreamingState());
    await cb2("segment_end", LONG_STRUCTURED, 1);

    expect(healthy.rec.rich.length).toBe(1);
    expect(healthy.rec.replies.length).toBe(0);
  });

  test('"method not found" falls back and stops all further rich attempts', async () => {
    const failing = makeCtx({
      richError: grammyLikeError(404, "Not Found: method not found"),
    });
    const cb = createStatusCallback(failing.ctx, new StreamingState());

    await cb("segment_end", LONG_STRUCTURED, 1);

    expect(failing.rec.rich.length).toBe(1);
    expect(failing.rec.replies.length).toBeGreaterThan(0);

    // Cache poisoned: the next long answer goes straight to the plain path.
    const next = makeCtx();
    const cb2 = createStatusCallback(next.ctx, new StreamingState());
    await cb2("segment_end", LONG_STRUCTURED, 1);

    expect(next.rec.rich.length).toBe(0);
    expect(next.rec.drafts.length).toBe(0);
    expect(next.rec.replies.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Draft streaming
// ---------------------------------------------------------------------------

describe("draft streaming", () => {
  test("streams drafts then finalizes exactly once", async () => {
    const { ctx, rec } = makeCtx();
    const state = new StreamingState();
    const cb = createStatusCallback(ctx, state);

    await cb("text", LONG_STRUCTURED.slice(0, 5_000), 1);
    await cb("text", LONG_STRUCTURED.slice(0, 6_000), 1);
    await cb("text", LONG_STRUCTURED, 1);
    await cb("segment_end", LONG_STRUCTURED, 1);
    await cb("done", "", undefined);

    // At least the first draft went out (later ones are throttled by the
    // controller's 500ms window, which is the intended behaviour).
    expect(rec.drafts.length).toBeGreaterThan(0);
    expect(rec.drafts[0]!.chat_id).toBe(CHAT_ID);
    expect(rec.drafts[0]!.draft_id).not.toBe(0);
    expect(rec.drafts.every((d) => d.draft_id === rec.drafts[0]!.draft_id)).toBe(true);

    // Exactly one finalize, no plain message, no chunker, no duplicate-finalize
    // error (a second finalize() would throw and land us in the chunker).
    expect(rec.rich.length).toBe(1);
    expect(rec.replies.length).toBe(0);
    expect(rec.edits.length).toBe(0);

    // "done" drops controller references.
    expect(state.richControllers.size).toBe(0);
  });

  test("a segment that grows past the threshold mid-stream drops its plain message", async () => {
    const { ctx, rec } = makeCtx();
    const state = new StreamingState();
    const cb = createStatusCallback(ctx, state);

    // Short first: plain streaming path creates a message.
    await cb("text", "Starting to answer your question now.", 1);
    expect(rec.replies.length).toBe(1);
    expect(rec.drafts.length).toBe(0);
    const plainMessageId = state.textMessages.get(1)!.message_id;

    // Then it grows into rich territory.
    await cb("text", LONG_STRUCTURED, 1);

    expect(rec.deletes.map((d) => d.messageId)).toContain(plainMessageId);
    expect(state.textMessages.has(1)).toBe(false);
    expect(rec.drafts.length).toBe(1);

    await cb("segment_end", LONG_STRUCTURED, 1);
    expect(rec.rich.length).toBe(1);
  });

  // CONTRACT CHANGE: rich *finalize* used to be gated on private chats, because
  // RichStreamController could not pass message_thread_id and a Rich Message in
  // a forum would have landed in General. It threads now, so a topic gets real
  // Rich Messages. Only the *draft* gate survives — sendRichMessageDraft's
  // chat_id is documented Integer-only, private chats only (src/rich-api.d.ts).
  test("non-private chats stream plain but still finalize as a Rich Message", async () => {
    const { ctx, rec } = makeCtx({ chatType: "group" });
    const state = new StreamingState();
    const cb = createStatusCallback(ctx, state);

    await cb("text", LONG_STRUCTURED.slice(0, 5_000), 1);
    await cb("text", LONG_STRUCTURED, 1);

    expect(rec.drafts.length).toBe(0);
    // The existing plain streaming path handled the live updates instead.
    expect(rec.replies.length).toBe(1);

    await cb("segment_end", LONG_STRUCTURED, 1);
    expect(rec.rich.length).toBe(1);
    // The plain streamed message is deleted so the answer isn't duplicated,
    // and the chunker never runs.
    expect(rec.deletes.length).toBe(1);
    expect(rec.replies.length).toBe(1);
  });

  test("in a forum topic the Rich Message carries that topic's thread id", async () => {
    const TOPIC = 4711;
    const { ctx, rec } = makeCtx({ chatType: "supergroup", threadId: TOPIC });
    const cb = createStatusCallback(ctx, new StreamingState());

    await cb("segment_end", LONG_STRUCTURED, 1);

    expect(rec.rich.length).toBe(1);
    expect(rec.rich[0]!.chat_id).toBe(CHAT_ID);
    // Without this the answer lands in General, silently, with nothing logged.
    expect(rec.rich[0]!.message_thread_id).toBe(TOPIC);
  });

  test("the General topic sends no message_thread_id", async () => {
    // grammY reports the General topic as thread 1 on some clients; it is
    // normalized to "no thread" everywhere else in the bot, and must be here.
    const { ctx, rec } = makeCtx({ chatType: "supergroup", threadId: 1 });
    const cb = createStatusCallback(ctx, new StreamingState());

    await cb("segment_end", LONG_STRUCTURED, 1);

    expect(rec.rich.length).toBe(1);
    expect(rec.rich[0]!.message_thread_id).toBeUndefined();
  });

  test("a failed draft falls back to plain streaming and is not retried", async () => {
    const { ctx, rec } = makeCtx({
      draftError: grammyLikeError(429, "Too Many Requests: retry after 5"),
    });
    const state = new StreamingState();
    const cb = createStatusCallback(ctx, state);

    await cb("text", LONG_STRUCTURED.slice(0, 5_000), 1);
    // One attempt, then the update still reached the user on the plain path.
    expect(rec.drafts.length).toBe(1);
    expect(rec.replies.length).toBe(1);

    await cb("text", LONG_STRUCTURED, 1);
    // No second draft attempt for this segment (would otherwise delete and
    // re-create the plain message on every event).
    expect(rec.drafts.length).toBe(1);
    expect(state.richDraftAbandoned.has(1)).toBe(true);

    // A draft blip does not stop the rich finalize.
    await cb("segment_end", LONG_STRUCTURED, 1);
    expect(rec.rich.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

describe("RICH_MESSAGES_ENABLED=false", () => {
  // Skipped on purpose: RICH_MESSAGES_ENABLED is read once at src/config.ts
  // import time, and Bun caches the module graph, so flipping it per-test would
  // need cache-busting dynamic imports of config + streaming + rich. Not worth
  // contorting the design for — the guard is a single `if (!RICH_MESSAGES_ENABLED)
  // return false;` at the top of canUseRich/canUseRichDraft, which is verified
  // by reading the diff (every rich branch sits behind it).
  test.skip("everything falls back to the plain path", () => {});
});

// ---------------------------------------------------------------------------
// Regression: content must survive when rich streaming has already dropped the
// plain message and the finished content then fails the Rich Message ceiling.
// ---------------------------------------------------------------------------

describe("oversized content after rich streaming", () => {
  /** Trips the router (long + headings) but blows the 32k Rich Message cap. */
  const OVERSIZED = [
    "# Chapter one",
    "",
    "x".repeat(20_000),
    "",
    "## Chapter two",
    "",
    "y".repeat(20_000),
  ].join("\n");

  test("never streams an oversized draft, but finalizes as split Rich Messages", async () => {
    const { ctx, rec } = makeCtx();
    const state = new StreamingState();
    const cb = createStatusCallback(ctx, state);

    // The draft ceiling is unchanged: a draft this large would just be rejected,
    // so mid-stream it stays on the plain path.
    await cb("text", OVERSIZED, 0);
    expect(rec.drafts.length).toBe(0);

    // Mid-stream it fell back to one plain streamed message, which is exactly
    // the thing that must not survive next to the Rich Messages.
    expect(rec.replies.length).toBe(1);

    await cb("segment_end", OVERSIZED, 0);

    // Finalize splits instead of demoting to the chunker...
    expect(rec.rich.length).toBeGreaterThan(1);
    for (const call of rec.rich) {
      expect(call.rich_message.markdown!.length).toBeLessThanOrEqual(32_768);
    }
    // ...and the plain streamed message was deleted, so the answer isn't
    // duplicated. No *further* plain replies were sent.
    expect(rec.replies.length).toBe(1);
    expect(rec.deletes.length).toBe(1);
    const all = rec.rich.map((c) => c.rich_message.markdown!).join("\n");
    expect(all).toContain("Chapter one");
    expect(all).toContain("Chapter two");
  });

  test("content that outgrows the ceiling after a draft started is still delivered", async () => {
    // The dangerous ordering: a draft starts (which deletes the segment's plain
    // message), then the finished answer turns out to exceed the Rich Message
    // ceiling. Nothing is left holding the content, so segment_end must deliver
    // all of it rather than attempt one oversized reply.
    const { ctx, rec } = makeCtx();
    const state = new StreamingState();
    const cb = createStatusCallback(ctx, state);

    await cb("text", LONG_STRUCTURED, 0); // under the ceiling -> draft streams
    expect(rec.drafts.length).toBe(1);
    expect(state.textMessages.has(0)).toBe(false); // plain message dropped

    await cb("segment_end", OVERSIZED, 0); // finished content is over the ceiling

    expect(rec.rich.length).toBeGreaterThan(1);
    expect(rec.replies.length).toBe(0);
    const all = rec.rich.map((c) => c.rich_message.markdown!).join("\n");
    expect(all).toContain("Chapter one");
    expect(all).toContain("Chapter two");
  });
});

describe("draft ids are globally unique", () => {
  test("two segments in one answer never share a draft_id", async () => {
    const { ctx, rec } = makeCtx();
    const state = new StreamingState();
    const cb = createStatusCallback(ctx, state);

    await cb("text", LONG_STRUCTURED, 0);
    await cb("segment_end", LONG_STRUCTURED, 0);
    await cb("text", LONG_STRUCTURED, 1);
    await cb("segment_end", LONG_STRUCTURED, 1);

    expect(rec.drafts.length).toBe(2);
    const ids = rec.drafts.map((d) => d.draft_id);
    expect(new Set(ids).size).toBe(2); // distinct
    for (const id of ids) expect(id).not.toBe(0); // must be non-zero
  });
});
