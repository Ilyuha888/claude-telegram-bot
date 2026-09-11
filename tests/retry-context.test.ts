/**
 * Regression tests for the context /retry replays a message through.
 *
 * The old implementation built it with `{ ...ctx, message: {...} }`. grammY
 * puts `chat`, `from`, `msg`, `message` and `reply` on `Context.prototype` as
 * accessors and methods, and object spread copies neither — so the "context"
 * handed to handleText had no `reply` to answer with and no `chat`/`from` to
 * key or authorise on. /retry threw on its first real line, every time.
 *
 * These tests assert against a genuine grammY `Context`, not a stand-in: the
 * whole bug was that the stand-in looked close enough.
 *
 * Run with: bun test tests/retry-context.test.ts
 */

import { describe, test, expect } from "bun:test";
import { Api, Context } from "grammy";
import type { Update, UserFromGetMe } from "@grammyjs/types";
import { buildRetryContext } from "../src/handlers/commands";

const CHAT = -1002222222222;
const USER = 751936510;
const THREAD = 77;

const ME = {
  id: 1,
  is_bot: true,
  first_name: "bot",
  username: "testbot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as UserFromGetMe;

function commandUpdate(over: { threadId?: number } = {}): Update {
  return {
    update_id: 1,
    message: {
      message_id: 100,
      date: 1_785_000_000,
      chat: { id: CHAT, type: "supergroup", title: "sessions" },
      from: { id: USER, is_bot: false, first_name: "tester", username: "tester" },
      text: "/retry",
      // The entity that describes "/retry" — meaningless once the text is
      // replaced, and actively wrong if it survives.
      entities: [{ type: "bot_command" as const, offset: 0, length: 6 }],
      ...(over.threadId !== undefined
        ? { message_thread_id: over.threadId, is_topic_message: true as const }
        : {}),
    },
  } as Update;
}

function ctxFor(update: Update): Context {
  return new Context(update, new Api("0:fake"), ME);
}

// ---------------------------------------------------------------------------

describe("buildRetryContext", () => {
  test("the retried context still exposes chat, from and reply", () => {
    // The three prototype members the spread dropped, in the order they used
    // to blow up: convKeyFromCtx reads chat, the auth check reads from, every
    // error path calls reply.
    const retried = buildRetryContext(ctxFor(commandUpdate()), "do the thing");

    expect(retried.chat?.id).toBe(CHAT);
    expect(retried.from?.id).toBe(USER);
    expect(typeof retried.reply).toBe("function");
    expect(retried.msg?.message_id).toBe(100);
  });

  test("it is a real grammy Context, not an object shaped like one", () => {
    const retried = buildRetryContext(ctxFor(commandUpdate()), "do the thing");

    expect(retried).toBeInstanceOf(Context);
  });

  test("the message text is the one being retried", () => {
    const retried = buildRetryContext(ctxFor(commandUpdate()), "do the thing");

    expect(retried.message?.text).toBe("do the thing");
  });

  test("the /retry command entity does not survive onto the new text", () => {
    const retried = buildRetryContext(ctxFor(commandUpdate()), "do the thing");

    expect(retried.message?.entities).toBeUndefined();
  });

  test("the forum topic is preserved, so the retry stays in its own session", () => {
    const retried = buildRetryContext(ctxFor(commandUpdate({ threadId: THREAD })), "again");

    expect(retried.message?.message_thread_id).toBe(THREAD);
  });

  test("the original context is not mutated", () => {
    const ctx = ctxFor(commandUpdate());

    buildRetryContext(ctx, "do the thing");

    expect(ctx.message?.text).toBe("/retry");
    expect(ctx.message?.entities?.length).toBe(1);
  });

  test("api and me are carried over, so the new context can actually send", () => {
    const ctx = ctxFor(commandUpdate());

    const retried = buildRetryContext(ctx, "do the thing");

    expect(retried.api).toBe(ctx.api);
    expect(retried.me).toBe(ctx.me);
  });

  test("the old spread approach is what this replaces", () => {
    // Kept as an executable statement of the bug: spread the same context and
    // the prototype members are gone. If grammy ever makes these own
    // properties, this test fails and the workaround can be reconsidered.
    const ctx = ctxFor(commandUpdate());
    const spread = { ...ctx, message: { ...ctx.message, text: "x" } } as unknown as Context;

    expect(spread.chat).toBeUndefined();
    expect(spread.from).toBeUndefined();
    expect(spread.reply).toBeUndefined();
  });
});
