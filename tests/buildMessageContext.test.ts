/**
 * Unit tests for buildMessageContext in src/utils.ts.
 *
 * Run with: bun test tests/buildMessageContext.test.ts
 */

import { describe, it, expect } from "bun:test";

// Prevent OpenAI client creation side-effect; no key = no client, which is fine
process.env.OPENAI_API_KEY = "";

import type { Context } from "grammy";
const { buildMessageContext, unhandledContentKind } = await import("../src/utils");

// Minimal Context stub — buildMessageContext only reads ctx.message
function makeCtx(msg: Record<string, unknown> | undefined): Context {
  return { message: msg } as unknown as Context;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const TEXT = "Hello world";
const TRANSCRIPT = "Um, like, add a reminder for tomorrow";
const VOICE_NOTICE_PREFIX = "[Voice transcript";

/**
 * A message carrying Rich Message content, in the shape Telegram ACTUALLY sends:
 * content lives in `blocks[].text`, and there is no flat `rich_message.text`.
 * Verified against a real forwarded payload — an earlier version of these tests
 * used the flat field the docs describe, and passed while production was broken.
 */
function RICH(body: string) {
  return { rich_message: { blocks: [{ type: "paragraph", text: body }] } };
}

// ── plain text (regression) ───────────────────────────────────────────────────

describe("plain text (no opts, no metadata)", () => {
  it("returns just the text", () => {
    const result = buildMessageContext(makeCtx({ text: TEXT }));
    expect(result).toBe(TEXT);
  });

  it("returns empty string when ctx.message is undefined", () => {
    const result = buildMessageContext(makeCtx(undefined));
    expect(result).toBe("");
  });

  it("falls back to caption when text is absent", () => {
    const result = buildMessageContext(makeCtx({ caption: "photo caption" }));
    expect(result).toBe("photo caption");
  });

  it("returns empty string when text and caption are both absent", () => {
    const result = buildMessageContext(makeCtx({ voice: {} }));
    expect(result).toBe("");
  });
});

// ── forward_origin variants ───────────────────────────────────────────────────

describe("forward_origin", () => {
  it("prepends @username for user origin with username", () => {
    const result = buildMessageContext(
      makeCtx({
        text: TEXT,
        forward_origin: { type: "user", sender_user: { username: "alice", first_name: "Alice" } },
      })
    );
    expect(result).toBe(`[Forwarded from @alice]\n${TEXT}`);
  });

  it("falls back to first_name when username absent", () => {
    const result = buildMessageContext(
      makeCtx({
        text: TEXT,
        forward_origin: { type: "user", sender_user: { first_name: "Bob" } },
      })
    );
    expect(result).toBe(`[Forwarded from Bob]\n${TEXT}`);
  });

  it("uses sender_user_name for hidden_user origin", () => {
    const result = buildMessageContext(
      makeCtx({
        text: TEXT,
        forward_origin: { type: "hidden_user", sender_user_name: "Hidden Person" },
      })
    );
    expect(result).toBe(`[Forwarded from Hidden Person]\n${TEXT}`);
  });

  it("uses chat title for channel origin", () => {
    const result = buildMessageContext(
      makeCtx({
        text: TEXT,
        forward_origin: { type: "channel", chat: { title: "Tech News" } },
      })
    );
    expect(result).toBe(`[Forwarded from Tech News]\n${TEXT}`);
  });
});

// ── reply_to_message ──────────────────────────────────────────────────────────

describe("reply_to_message", () => {
  it("prepends snippet from replied message text", () => {
    const result = buildMessageContext(
      makeCtx({ text: TEXT, reply_to_message: { text: "What time is it?" } })
    );
    expect(result).toBe(`[Replying to: "What time is it?"]\n${TEXT}`);
  });

  it("falls back to caption in replied message", () => {
    const result = buildMessageContext(
      makeCtx({ text: TEXT, reply_to_message: { caption: "a photo" } })
    );
    expect(result).toBe(`[Replying to: "a photo"]\n${TEXT}`);
  });

  it("truncates long replied text to ~500 chars with ellipsis", () => {
    const longText = "x".repeat(600);
    const result = buildMessageContext(
      makeCtx({ text: TEXT, reply_to_message: { text: longText } })
    );
    const snippetLine = result.split("\n")[0]!;
    expect(snippetLine.length).toBeLessThan(520);
    expect(snippetLine).toContain("…");
  });

  it("uses placeholder for non-text replied message", () => {
    const result = buildMessageContext(
      makeCtx({ text: TEXT, reply_to_message: {} })
    );
    expect(result).toContain("[non-text message]");
  });

  // The bug this file exists to prevent a repeat of: the bot sends any answer
  // over 4096 chars (or with a table/headings/math) as a Rich Message, which
  // carries no `text` at all. Replying to one used to quote "[non-text
  // message]", so the bot could not read back its own long output and told the
  // user their message hadn't arrived.
  it("reads rich_message.text when the replied message is a Rich Message", () => {
    const result = buildMessageContext(
      makeCtx({
        text: TEXT,
        reply_to_message: RICH("unwinds the stack until someone catches it"),
      })
    );
    expect(result).toBe(
      `[Replying to: "unwinds the stack until someone catches it"]\n${TEXT}`
    );
    expect(result).not.toContain("[non-text message]");
  });

  it("prefers plain text over rich_message when both are present", () => {
    const result = buildMessageContext(
      makeCtx({
        text: TEXT,
        reply_to_message: { text: "plain wins", ...RICH("rich loses") },
      })
    );
    expect(result).toContain("plain wins");
    expect(result).not.toContain("rich loses");
  });

  it("ignores a blank rich_message.text and falls back to the placeholder", () => {
    const result = buildMessageContext(
      makeCtx({ text: TEXT, reply_to_message: RICH("   ") })
    );
    expect(result).toContain("[non-text message]");
  });

  // Telegram reports the topic's own creation service message as the reply
  // target for messages in a forum topic, so this used to stamp a bogus
  // `[Replying to: "[non-text message]"]` on the first turn of every topic.
  it("does not treat a forum_topic_created service message as a reply target", () => {
    const result = buildMessageContext(
      makeCtx({
        text: TEXT,
        reply_to_message: { forum_topic_created: { name: "Daily focus" } },
      })
    );
    expect(result).toBe(TEXT);
    expect(result).not.toContain("Replying to");
  });
});

// ── rich message as the message body ─────────────────────────────────────────

describe("rich_message body", () => {
  it("reads a forwarded Rich Message's own content", () => {
    const result = buildMessageContext(
      makeCtx({
        ...RICH("T4-D7 — Error Handling"),
        forward_origin: { type: "user", sender_user: { username: "bot", first_name: "Bot" } },
      })
    );
    expect(result).toBe("[Forwarded from @bot]\nT4-D7 — Error Handling");
  });

  it("returns non-empty for a bare Rich Message, so handleText does not drop it", () => {
    // handleText returns early on a falsy message. Before rich_message was read,
    // that early return is where forwarded long answers vanished.
    const result = buildMessageContext(makeCtx(RICH("content")));
    expect(result).toBe("content");
  });
});

// ── quote ─────────────────────────────────────────────────────────────────────

describe("quote", () => {
  it("prepends quoted fragment", () => {
    const result = buildMessageContext(
      makeCtx({ text: TEXT, quote: { text: "important bit" } })
    );
    expect(result).toBe(`[Quoting: "important bit"]\n${TEXT}`);
  });
});

// ── combined metadata ─────────────────────────────────────────────────────────

describe("combined metadata", () => {
  it("emits forward + reply + quote + text in order", () => {
    const result = buildMessageContext(
      makeCtx({
        text: TEXT,
        forward_origin: { type: "hidden_user", sender_user_name: "Someone" },
        reply_to_message: { text: "original" },
        quote: { text: "fragment" },
      })
    );
    const lines = result.split("\n");
    expect(lines[0]).toContain("Forwarded from Someone");
    expect(lines[1]).toContain("Replying to");
    expect(lines[2]).toContain("Quoting");
    expect(lines[3]).toBe(TEXT);
  });
});

// ── voice transcript branch ───────────────────────────────────────────────────

describe("voice transcript (opts.voiceTranscript)", () => {
  it("prepends voice notice and transcript when voiceTranscript provided", () => {
    const result = buildMessageContext(makeCtx({ voice: {} }), {
      voiceTranscript: TRANSCRIPT,
    });
    const lines = result.split("\n");
    expect(lines[0]).toContain(VOICE_NOTICE_PREFIX);
    expect(lines[1]).toBe(TRANSCRIPT);
  });

  it("voice notice instructs intent-mode interpretation", () => {
    const result = buildMessageContext(makeCtx({ voice: {} }), {
      voiceTranscript: TRANSCRIPT,
    });
    expect(result).toContain("interpret for intent");
  });

  it("handles empty transcript string without crashing", () => {
    const result = buildMessageContext(makeCtx({ voice: {} }), {
      voiceTranscript: "",
    });
    expect(result).toContain(VOICE_NOTICE_PREFIX);
  });

  it("also fires forward_origin when voice message is a forward", () => {
    const result = buildMessageContext(
      makeCtx({
        voice: {},
        forward_origin: { type: "hidden_user", sender_user_name: "Sender" },
      }),
      { voiceTranscript: TRANSCRIPT }
    );
    expect(result).toContain("Forwarded from Sender");
    expect(result).toContain(VOICE_NOTICE_PREFIX);
    expect(result).toContain(TRANSCRIPT);
  });

  it("also fires reply_to_message when voice message is a reply", () => {
    const result = buildMessageContext(
      makeCtx({
        voice: {},
        reply_to_message: { text: "previous message" },
      }),
      { voiceTranscript: TRANSCRIPT }
    );
    expect(result).toContain("[Replying to");
    expect(result).toContain(VOICE_NOTICE_PREFIX);
    expect(result).toContain(TRANSCRIPT);
  });
});

// ── negative: voice notice must NOT appear on typed text ──────────────────────

describe("voice notice absence on typed messages", () => {
  it("does not include voice notice when opts is undefined", () => {
    const result = buildMessageContext(makeCtx({ text: TEXT }));
    expect(result).not.toContain(VOICE_NOTICE_PREFIX);
  });

  it("does not include voice notice when opts has no voiceTranscript key", () => {
    const result = buildMessageContext(makeCtx({ text: TEXT }), {});
    expect(result).not.toContain(VOICE_NOTICE_PREFIX);
  });
});

// ── unhandled content types ──────────────────────────────────────────────────

describe("unhandledContentKind", () => {
  it("names content types the bot has no handler for", () => {
    expect(unhandledContentKind({ sticker: {} })).toBe("sticker");
    expect(unhandledContentKind({ location: {} })).toBe("location");
    expect(unhandledContentKind({ animation: {} })).toBe("GIF");
  });

  it("stays silent for content types that DO have handlers", () => {
    // These reach a real handler earlier in the middleware chain, so the
    // fallback must never fire for them.
    for (const field of ["text", "photo", "voice", "audio", "document", "video", "video_note"]) {
      expect(unhandledContentKind({ [field]: {} })).toBeNull();
    }
    expect(unhandledContentKind(RICH("x"))).toBeNull();
  });

  it("stays silent for service messages", () => {
    // The reason this enumerates content rather than service fields: the
    // service list grows with every Bot API release, and a stale one would emit
    // "I can't read that" into every topic the bot opens.
    for (const field of [
      "forum_topic_created",
      "forum_topic_closed",
      "new_chat_members",
      "pinned_message",
      "message_auto_delete_timer_changed",
      "boost_added",
    ]) {
      expect(unhandledContentKind({ [field]: {} })).toBeNull();
    }
  });

  it("does not throw on absent or non-object input", () => {
    expect(unhandledContentKind(undefined)).toBeNull();
    expect(unhandledContentKind(null)).toBeNull();
    expect(unhandledContentKind("nope")).toBeNull();
  });
});
