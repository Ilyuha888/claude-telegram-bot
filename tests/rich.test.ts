/**
 * Tests for src/rich.ts — Rich Message router, renderer, and size gate.
 *
 * Run with: bun test tests/rich.test.ts
 */

import { describe, test, expect } from "bun:test";
import type { Api } from "grammy";
import {
  shouldUseRichMessage,
  convertToRichMarkdown,
  exceedsRichMessageLimits,
  splitForRichMessages,
  RichStreamController,
  incomingRichText,
  isRichMessage,
} from "../src/rich";

describe("shouldUseRichMessage", () => {
  test("short plain text stays on the plain path", () => {
    expect(shouldUseRichMessage("Hello, how are you today?")).toBe(false);
  });

  test("text over 4096 chars routes to rich", () => {
    const long = "a".repeat(4097);
    expect(shouldUseRichMessage(long)).toBe(true);
  });

  test("a GFM table routes to rich", () => {
    const content = ["| A | B |", "|---|:---:|", "| 1 | 2 |"].join("\n");
    expect(shouldUseRichMessage(content)).toBe(true);
  });

  test("2+ headings route to rich", () => {
    const content = ["# Heading 1", "some text", "## Heading 2", "more text"].join(
      "\n"
    );
    expect(shouldUseRichMessage(content)).toBe(true);
  });

  test("a single heading (only 1) stays on the plain path", () => {
    const content = "# Just one heading\nSome ordinary text follows.";
    // Precisely the "2 or more" rule: exactly one heading must NOT trigger rich.
    expect(shouldUseRichMessage(content)).toBe(false);
  });

  test("a fenced code block with a language tag routes to rich", () => {
    const content = "Here's some code:\n```python\nprint('hi')\n```";
    expect(shouldUseRichMessage(content)).toBe(true);
  });

  test("math routes to rich", () => {
    expect(shouldUseRichMessage("The formula is $E = mc^2$ for energy.")).toBe(
      true
    );
    expect(shouldUseRichMessage("Block math:\n```math\nx^2 + y^2 = z^2\n```")).toBe(
      true
    );
    expect(shouldUseRichMessage("Display math:\n$$\\int_0^1 x\\,dx$$")).toBe(true);
  });
});

describe("convertToRichMarkdown — thinking tag", () => {
  const input = "Before. <thinking>internal reasoning here</thinking> After.";

  test("forDraft: true rewrites <thinking> to <tg-thinking>", () => {
    const result = convertToRichMarkdown(input, { forDraft: true });
    expect(result).toContain("<tg-thinking>internal reasoning here</tg-thinking>");
    expect(result).not.toContain("<thinking>");
    expect(result).not.toContain("</thinking>");
    expect(result).toContain("Before.");
    expect(result).toContain("After.");
  });

  test("forDraft: false strips <thinking> entirely", () => {
    const result = convertToRichMarkdown(input, { forDraft: false });
    expect(result).not.toContain("thinking");
    expect(result).not.toContain("internal reasoning here");
    expect(result).toContain("Before.");
    expect(result).toContain("After.");
  });

  test("omitting opts behaves like forDraft: false (stripped)", () => {
    const result = convertToRichMarkdown(input);
    expect(result).not.toContain("internal reasoning here");
    expect(result).not.toContain("<tg-thinking>");
  });
});

describe("convertToRichMarkdown — code passthrough", () => {
  test("fenced code block content passes through byte-for-byte, including literal <, >, &", () => {
    const input = "Look:\n```html\n<div>a & b < c > d</div>\n```\nDone.";
    const result = convertToRichMarkdown(input);
    expect(result).toContain("```html\n<div>a & b < c > d</div>\n```");
  });

  test("inline code span content passes through unescaped", () => {
    const input = "Use `a < b && c > d` in your condition.";
    const result = convertToRichMarkdown(input);
    expect(result).toContain("`a < b && c > d`");
  });
});

describe("convertToRichMarkdown — stray HTML escaping", () => {
  test("stray <, >, & in plain prose are escaped", () => {
    const input = "Compare: 5 < 10 & 20 > 15";
    const result = convertToRichMarkdown(input);
    expect(result).toBe("Compare: 5 &lt; 10 &amp; 20 &gt; 15");
  });

  test("markdown syntax characters are not escaped", () => {
    const input = "*bold* _italic_ `code` # heading | table [link](http://x)";
    const result = convertToRichMarkdown(input);
    expect(result).toContain("*bold*");
    expect(result).toContain("_italic_");
    expect(result).toContain("`code`");
    expect(result).toContain("#");
    expect(result).toContain("|");
    expect(result).toContain("[link](http://x)");
  });

  test("blockquote markers are preserved, not escaped", () => {
    const input = "> a quoted line";
    const result = convertToRichMarkdown(input);
    expect(result).toBe("> a quoted line");
  });
});

describe("exceedsRichMessageLimits", () => {
  test("under-limit content is false", () => {
    expect(exceedsRichMessageLimits("Just a short reply.")).toBe(false);
  });

  test("a >32k-char string is true", () => {
    const huge = "a".repeat(33_000);
    expect(exceedsRichMessageLimits(huge)).toBe(true);
  });
});

// RichStreamController drives real Telegram API calls via api.raw. It isn't
// exercised against a live bot in this phase (wiring happens in a later
// phase, in src/handlers/streaming.ts) — these tests use a minimal mock of
// api.raw to check the call shape and throttle/finalize bookkeeping without
// any network I/O. Time-based behaviour (the ~25s expiry mark) is not
// asserted here since faking that cheaply isn't worth the complexity at
// this phase; isApproachingExpiry()'s immediate-false case is covered.
describe("RichStreamController", () => {
  function makeFakeApi() {
    const draftCalls: unknown[] = [];
    const finalizeCalls: unknown[] = [];
    const fakeApi = {
      raw: {
        sendRichMessageDraft: async (args: unknown) => {
          draftCalls.push(args);
          return true;
        },
        sendRichMessage: async (args: unknown) => {
          finalizeCalls.push(args);
          return { message_id: 42, chat: { id: 1 }, date: 0 };
        },
      },
    } as unknown as Api;
    return { fakeApi, draftCalls, finalizeCalls };
  }

  test("updateDraft calls sendRichMessageDraft with chat_id/draft_id/markdown", async () => {
    const { fakeApi, draftCalls } = makeFakeApi();
    const controller = new RichStreamController(123, fakeApi, 0);
    await controller.updateDraft("Hello world");

    expect(draftCalls.length).toBe(1);
    const call = draftCalls[0] as {
      chat_id: number;
      draft_id: number;
      rich_message: { markdown: string };
    };
    expect(call.chat_id).toBe(123);
    expect(typeof call.draft_id).toBe("number");
    expect(call.draft_id).not.toBe(0);
    expect(call.rich_message.markdown).toContain("Hello world");
  });

  test("updateDraft throttles calls inside the throttle window", async () => {
    const { fakeApi, draftCalls } = makeFakeApi();
    const controller = new RichStreamController(123, fakeApi, 60_000); // huge throttle window
    await controller.updateDraft("First");
    await controller.updateDraft("Second"); // inside the throttle window -> no-op

    expect(draftCalls.length).toBe(1);
  });

  test("updateDraft merges thinkingContent as a <tg-thinking> block", async () => {
    const { fakeApi, draftCalls } = makeFakeApi();
    const controller = new RichStreamController(123, fakeApi, 0);
    await controller.updateDraft("Body text", "some thought");

    const call = draftCalls[0] as { rich_message: { markdown: string } };
    expect(call.rich_message.markdown).toContain("<tg-thinking>some thought</tg-thinking>");
    expect(call.rich_message.markdown).toContain("Body text");
  });

  test("finalize calls sendRichMessage and sets finalized", async () => {
    const { fakeApi, finalizeCalls } = makeFakeApi();
    const controller = new RichStreamController(123, fakeApi, 0);
    expect(controller.finalized).toBe(false);

    const message = await controller.finalize("Final content");

    expect(finalizeCalls.length).toBe(1);
    expect(controller.finalized).toBe(true);
    expect(message.message_id).toBe(42);
  });

  test("isApproachingExpiry is false before any draft has been sent", () => {
    const { fakeApi } = makeFakeApi();
    const controller = new RichStreamController(123, fakeApi, 0);
    expect(controller.isApproachingExpiry()).toBe(false);
  });

  test("isApproachingExpiry is false immediately after the first draft", async () => {
    const { fakeApi } = makeFakeApi();
    const controller = new RichStreamController(123, fakeApi, 0);
    await controller.updateDraft("Hello");
    expect(controller.isApproachingExpiry()).toBe(false);
  });

  test("startSegment bumps the draft id and resets finalized", async () => {
    const { fakeApi, draftCalls } = makeFakeApi();
    const controller = new RichStreamController(123, fakeApi, 0);
    await controller.updateDraft("Segment 1");
    const firstDraftId = (draftCalls[0] as { draft_id: number }).draft_id;

    await controller.finalize("Segment 1 final");
    expect(controller.finalized).toBe(true);

    controller.startSegment();
    expect(controller.finalized).toBe(false);

    await controller.updateDraft("Segment 2");
    const secondDraftId = (draftCalls[1] as { draft_id: number }).draft_id;
    expect(secondDraftId).not.toBe(firstDraftId);
  });
});

// ---------------------------------------------------------------------------
// Regression tests for the review findings on the first cut of this module.
// ---------------------------------------------------------------------------

describe("currency vs. LaTeX math ($ handling)", () => {
  // Rich Markdown parses '$..$' as inline LaTeX, so bare '$' in prose used to
  // make "costs $5 and $10" render as a formula in Telegram.

  test("currency prose does not route to the rich path as math", () => {
    expect(shouldUseRichMessage("the plan costs $5 and the addon costs $10")).toBe(
      false
    );
    expect(shouldUseRichMessage("budget is $100-$200 per month")).toBe(false);
  });

  test("real inline math still routes to the rich path", () => {
    expect(shouldUseRichMessage("energy is $E = mc^2$ exactly")).toBe(true);
    expect(shouldUseRichMessage("the term $x_i$ matters")).toBe(true);
    expect(shouldUseRichMessage("growth of $2^n$ is fast")).toBe(true);
  });

  test("currency in prose is escaped so it is not read as a formula", () => {
    expect(convertToRichMarkdown("costs $5 and $10")).toBe(
      "costs \\$5 and \\$10"
    );
  });

  test("real inline math is preserved verbatim", () => {
    expect(convertToRichMarkdown("energy is $E = mc^2$ ok")).toBe(
      "energy is $E = mc^2$ ok"
    );
  });

  test("math whose body starts with a digit survives (naive escaping broke this)", () => {
    expect(convertToRichMarkdown("growth of $2^n$ is fast")).toBe(
      "growth of $2^n$ is fast"
    );
  });

  test("display math is preserved verbatim", () => {
    expect(convertToRichMarkdown("$$E = mc^2$$")).toBe("$$E = mc^2$$");
  });

  test("$ inside code is never touched", () => {
    expect(convertToRichMarkdown("```bash\necho $HOME $5\n```")).toBe(
      "```bash\necho $HOME $5\n```"
    );
    expect(convertToRichMarkdown("run `echo $5`")).toBe("run `echo $5`");
  });

  test("mixed currency and math in one message", () => {
    const out = convertToRichMarkdown("it costs $5 but $x^2$ is free");
    expect(out).toBe("it costs \\$5 but $x^2$ is free");
  });
});

describe("placeholder namespace is not injectable", () => {
  test("a literal NUL placeholder in the input cannot steal a code block", () => {
    const out = convertToRichMarkdown(
      "text \x00CODEBLOCK0\x00 more\n```js\nreal()\n```"
    );
    // The real fence must still be present and in its original position.
    expect(out).toContain("```js\nreal()\n```");
    expect(out).toBe("text CODEBLOCK0 more\n```js\nreal()\n```");
    expect(out).not.toContain("\x00");
  });
});

describe("inline code delimiter round-trip", () => {
  test("double-backtick spans keep both delimiters", () => {
    expect(convertToRichMarkdown("a ``foo`` b")).toBe("a ``foo`` b");
  });

  test("single-backtick spans are unchanged", () => {
    expect(convertToRichMarkdown("a `foo` b")).toBe("a `foo` b");
  });

  test("a double-backtick span may contain a backtick", () => {
    expect(convertToRichMarkdown("a ``x`y`` b")).toBe("a ``x`y`` b");
  });
});

describe("hasGfmTable precision", () => {
  test("a prose pipe followed by a horizontal rule is not a table", () => {
    expect(shouldUseRichMessage("use a | b syntax\n---\nnext line")).toBe(false);
  });

  test("a real table with a pipe-bearing separator is still detected", () => {
    expect(shouldUseRichMessage("| A | B |\n|---|---|\n| 1 | 2 |")).toBe(true);
  });
});

describe("exceedsRichMessageLimits — block ceiling", () => {
  test("content over 500 blocks is rejected", () => {
    const many = Array.from({ length: 501 }, (_, i) => `- item ${i}`).join("\n");
    expect(exceedsRichMessageLimits(many)).toBe(true);
  });

  test("a quoted table row counts toward its blockquote, not as its own row", () => {
    // 600 quoted table rows form ONE blockquote group, so this must stay under
    // the 500-block ceiling.
    const quoted = Array.from({ length: 600 }, () => "> | a | b |").join("\n");
    expect(exceedsRichMessageLimits(quoted)).toBe(false);
  });

  test("ordinary content is under the limits", () => {
    expect(exceedsRichMessageLimits("# Title\n\nA paragraph.")).toBe(false);
  });
});

describe("RichStreamController.finalize idempotency", () => {
  function mockApi() {
    const calls: unknown[] = [];
    const api = {
      raw: {
        sendRichMessage: async (args: unknown) => {
          calls.push(args);
          return { message_id: 1 } as never;
        },
        sendRichMessageDraft: async () => true as const,
      },
    } as unknown as Api;
    return { api, calls };
  }

  test("a second finalize throws instead of sending a duplicate", async () => {
    const { api, calls } = mockApi();
    const c = new RichStreamController(1, api);
    await c.finalize("done");
    expect(calls.length).toBe(1);
    await expect(c.finalize("done")).rejects.toThrow(/already finalized/);
    expect(calls.length).toBe(1);
  });

  test("startSegment re-arms the controller after a finalize", async () => {
    const { api, calls } = mockApi();
    const c = new RichStreamController(1, api);
    await c.finalize("first");
    c.startSegment();
    await c.finalize("second");
    expect(calls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// splitForRichMessages
// ---------------------------------------------------------------------------

describe("splitForRichMessages", () => {
  test("content that already fits is returned untouched", () => {
    const content = "# Title\n\nA short paragraph.";
    expect(splitForRichMessages(content)).toEqual([content]);
  });

  test("every piece clears the size gate", () => {
    const content = Array.from(
      { length: 400 },
      (_, i) => `## Section ${i}\n\n${"prose ".repeat(120)}`
    ).join("\n\n");
    const pieces = splitForRichMessages(content);

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(exceedsRichMessageLimits(piece)).toBe(false);
    }
  });

  test("splits on the block ceiling even when well under 32k chars", () => {
    // 700 one-line list items: ~10k chars but ~700 blocks, so a char-only split
    // would emit a single piece that the API then rejects.
    const content = Array.from({ length: 700 }, (_, i) => `- item ${i}`).join("\n");
    expect(content.length).toBeLessThan(32_768);

    const pieces = splitForRichMessages(content);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(exceedsRichMessageLimits(piece)).toBe(false);
    }
  });

  test("a code fence spanning a boundary is closed and reopened with its language", () => {
    const content = [
      "Intro paragraph.",
      "",
      "```python",
      ...Array.from({ length: 2500 }, (_, i) => `print("line ${i}")`),
      "```",
    ].join("\n");

    const pieces = splitForRichMessages(content);
    expect(pieces.length).toBeGreaterThan(1);

    // Every piece must have balanced fences, or the renderer leaks code into prose.
    for (const piece of pieces) {
      const fences = (piece.match(/^```/gm) || []).length;
      expect(fences % 2).toBe(0);
    }
    // And the continuation keeps the language, so highlighting survives the cut.
    expect(pieces[1]!.startsWith("```python")).toBe(true);
  });

  test("a table spanning a boundary repeats its header so it still parses as a table", () => {
    const content = [
      "| Index | Value |",
      "|-------|-------|",
      ...Array.from({ length: 3000 }, (_, i) => `| ${i} | ${"v".repeat(20)} |`),
    ].join("\n");

    const pieces = splitForRichMessages(content);
    expect(pieces.length).toBeGreaterThan(1);

    // hasGfmTable needs header AND separator; without both, the continuation
    // would render as raw pipes.
    for (const piece of pieces) {
      expect(shouldUseRichMessage(piece)).toBe(true);
      expect(piece.startsWith("| Index | Value |")).toBe(true);
    }
  });

  test("a single unsplittable line is cut on characters rather than looping", () => {
    const content = "z".repeat(80_000);
    const pieces = splitForRichMessages(content);

    expect(pieces.length).toBeGreaterThan(2);
    for (const piece of pieces) {
      expect(exceedsRichMessageLimits(piece)).toBe(false);
    }
    // Nothing lost, nothing duplicated.
    const total = pieces.reduce(
      (n, p) => n + (p.match(/z/g) || []).length,
      0
    );
    expect(total).toBe(80_000);
  });

  test("prose content survives the round trip in order", () => {
    const paragraphs = Array.from(
      { length: 300 },
      (_, i) => `Paragraph ${i} marker. ${"filler ".repeat(60)}`
    );
    const pieces = splitForRichMessages(paragraphs.join("\n\n"));

    expect(pieces.length).toBeGreaterThan(1);
    const joined = pieces.join("\n");
    for (let i = 0; i < paragraphs.length; i++) {
      expect(joined).toContain(`Paragraph ${i} marker.`);
    }
  });
});

// ── read side ────────────────────────────────────────────────────────────────

describe("incomingRichText / isRichMessage", () => {
  // The shape below is copied from an OBSERVED payload (a forward of one of the
  // bot's own long answers), not from the Bot API docs. The first version of this
  // suite asserted a flat `rich_message.text`, which the docs describe and
  // Telegram does not send — so every test passed while the feature was broken in
  // production. Keep these fixtures anchored to the wire.
  const observed = {
    rich_message: {
      blocks: [
        { type: "paragraph", text: "T4-D7 — Error Handling" },
        { type: "pre", text: "def load_config(path):\n    pass" },
        { type: "paragraph", text: "Name the distinct things wrong with it." },
      ],
    },
  };

  test("reconstructs text by walking blocks", () => {
    expect(incomingRichText(observed)).toBe(
      "T4-D7 — Error Handling\n\n" +
        "```\ndef load_config(path):\n    pass\n```\n\n" +
        "Name the distinct things wrong with it.",
    );
    expect(isRichMessage(observed)).toBe(true);
  });

  test("fences a pre block so quoted code doesn't read as prose", () => {
    const out = incomingRichText({
      rich_message: { blocks: [{ type: "pre", text: "return {}" }] },
    });
    expect(out).toBe("```\nreturn {}\n```");
  });

  test("skips bodiless blocks instead of emitting blank gaps", () => {
    // A divider has no text; naive joining would leave a "\n\n\n\n" hole.
    const out = incomingRichText({
      rich_message: {
        blocks: [
          { type: "paragraph", text: "before" },
          { type: "divider" },
          { type: "paragraph", text: "after" },
        ],
      },
    });
    expect(out).toBe("before\n\nafter");
  });

  test("flattens a nested RichText body as well as a plain string", () => {
    // Not observed for this bot's own output, but RichMessage references a
    // RichText type, so a styled block may nest. Six lines beats a fourth
    // production round-trip to find out.
    expect(
      incomingRichText({
        rich_message: { blocks: [{ type: "paragraph", text: { text: "nested" } }] },
      }),
    ).toBe("nested");
    expect(
      incomingRichText({
        rich_message: {
          blocks: [{ type: "paragraph", text: [{ text: "two " }, { text: "runs" }] }],
        },
      }),
    ).toBe("two runs");
  });

  test("honours a flat field if a future API version ever sends one", () => {
    // Explicitly a hedge, not a description of current behaviour.
    expect(incomingRichText({ rich_message: { text: "flat" } })).toBe("flat");
    expect(incomingRichText({ rich_message: { markdown: "**md**" } })).toBe("**md**");
  });

  test("returns undefined for a plain text message", () => {
    expect(incomingRichText({ text: "hello" })).toBeUndefined();
    expect(isRichMessage({ text: "hello" })).toBe(false);
  });

  test("treats a blank, bodiless or block-less rich message as absent", () => {
    // Must not beat a real caption or the placeholder in buildMessageContext's
    // `??` chain.
    expect(incomingRichText({ rich_message: { text: "  \n " } })).toBeUndefined();
    expect(incomingRichText({ rich_message: {} })).toBeUndefined();
    expect(incomingRichText({ rich_message: { blocks: [] } })).toBeUndefined();
    expect(
      incomingRichText({ rich_message: { blocks: [{ type: "paragraph", text: "   " }] } }),
    ).toBeUndefined();
    expect(incomingRichText({ rich_message: { blocks: "not an array" } })).toBeUndefined();
  });

  test("survives the shapes a caller can actually hold", () => {
    // reply_to_message is optional, ctx.message is optional, and neither is
    // typed with the field — so undefined/null must not throw.
    expect(incomingRichText(undefined)).toBeUndefined();
    expect(incomingRichText(null)).toBeUndefined();
    expect(incomingRichText("not a message")).toBeUndefined();
    expect(isRichMessage(undefined)).toBe(false);
  });
});
