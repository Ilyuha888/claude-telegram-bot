/**
 * Unit tests for buildMessageContext in src/utils.ts.
 *
 * Run with: bun test tests/buildMessageContext.test.ts
 */

import { describe, it, expect } from "bun:test";

// Prevent OpenAI client creation side-effect; no key = no client, which is fine
process.env.OPENAI_API_KEY = "";

import type { Context } from "grammy";
const { buildMessageContext } = await import("../src/utils");

// Minimal Context stub — buildMessageContext only reads ctx.message
function makeCtx(msg: Record<string, unknown> | undefined): Context {
  return { message: msg } as unknown as Context;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const TEXT = "Hello world";
const TRANSCRIPT = "Um, like, add a reminder for tomorrow";
const VOICE_NOTICE_PREFIX = "[Voice transcript";

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
    const snippetLine = result.split("\n")[0];
    expect(snippetLine.length).toBeLessThan(520);
    expect(snippetLine).toContain("…");
  });

  it("uses placeholder for non-text replied message", () => {
    const result = buildMessageContext(
      makeCtx({ text: TEXT, reply_to_message: {} })
    );
    expect(result).toContain("[non-text message]");
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
