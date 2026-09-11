/**
 * Unit tests for composeTurn in src/turn/part.ts.
 *
 * Run with: bun test tests/turn-compose.test.ts
 *
 * No mocks, by design: part.ts imports nothing but a type, so the composition
 * rules that carry the whole batching feature can be pinned down here without a
 * grammY Context, a ClaudeSession or a clock in sight. Two of these assertions
 * exist to catch silent behaviour changes rather than crashes:
 *
 *   - a lone text part must stay a bare STRING (sendMessageStreaming has two
 *     input modes; promoting text turns to the blocks path would reroute every
 *     text message in the bot onto a different SDK code path, with no type error
 *     and no visible symptom until something subtle breaks);
 *   - every media block must sit immediately behind ITS OWN part's text block
 *     (regrouping text-first/media-last destroys the caption↔image binding and
 *     yields confident wrong answers, not errors).
 */

import { describe, it, expect } from "bun:test";

import type { UserContentBlock } from "../src/session";
import { composeTurn, type TurnPart } from "../src/turn/part";

// ── builders ─────────────────────────────────────────────────────────────────

let nextSeq = 0;

function part(over: Partial<TurnPart> = {}): TurnPart {
  const seq = over.seq ?? nextSeq++;
  return {
    kind: "text",
    seq,
    text: `msg ${seq}`,
    media: [],
    audit: { kind: "TEXT", summary: `msg ${seq}` },
    titleSeed: `msg ${seq}`,
    bytes: 8,
    ...over,
  };
}

function image(data = "AAAA"): UserContentBlock {
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data } };
}

function pdf(data = "BBBB"): UserContentBlock {
  return { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
}

function textBlocks(content: string | UserContentBlock[]): UserContentBlock[] {
  if (typeof content === "string") throw new Error("expected blocks, got a string");
  return content;
}

// ── single part: identity ────────────────────────────────────────────────────

describe("composeTurn — a single part is passed through unchanged", () => {
  it("returns a text-only part as a bare string, byte-identical", () => {
    const p = part({ text: "[Forwarded from @alice]\nship it" });
    const turn = composeTurn([p]);

    expect(typeof turn.content).toBe("string");
    expect(turn.content).toBe("[Forwarded from @alice]\nship it");
    expect(turn.partCount).toBe(1);
  });

  it("keeps the part's own audit, title seed and lastMessageText", () => {
    const p = part({
      audit: { kind: "VOICE", summary: "hi" },
      titleSeed: "hi",
      lastMessageText: "hi",
      kind: "voice",
    });
    const turn = composeTurn([p]);

    expect(turn.audit).toEqual({ kind: "VOICE", summary: "hi" });
    expect(turn.titleSeed).toBe("hi");
    expect(turn.lastMessageText).toBe("hi");
  });

  it("returns a single photo part as exactly [text, image]", () => {
    const p = part({ kind: "photo", text: "what is this?", media: [image()] });
    const blocks = textBlocks(composeTurn([p]).content);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "what is this?" });
    expect(blocks[1]!.type).toBe("image");
  });

  it("returns a single PDF part as exactly [text, document]", () => {
    const p = part({ kind: "pdf", text: "summarise", media: [pdf()] });
    const blocks = textBlocks(composeTurn([p]).content);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "summarise" });
    expect(blocks[1]!.type).toBe("document");
  });

  it("adds no preamble and no delimiter to a single part", () => {
    const turn = composeTurn([part({ text: "just this" })]);
    expect(turn.content).not.toContain("ONE turn");
    expect(turn.content).not.toContain("---");
  });

  it("refuses to compose an empty turn", () => {
    expect(() => composeTurn([])).toThrow(/empty turn/);
  });
});

// ── text-only batch: still a string ──────────────────────────────────────────

describe("composeTurn — a text-only batch stays on the string path", () => {
  it("joins N text parts into one string with a preamble and delimiters", () => {
    const turn = composeTurn([
      part({ seq: 0, text: "first" }),
      part({ seq: 1, text: "second" }),
      part({ seq: 2, text: "third" }),
    ]);

    expect(typeof turn.content).toBe("string");
    const s = turn.content as string;
    expect(s).toContain("sent 3 messages in quick succession");
    expect(s).toContain("--- 1/3 (text) ---\nfirst");
    expect(s).toContain("--- 2/3 (text) ---\nsecond");
    expect(s).toContain("--- 3/3 (text) ---\nthird");
    expect(turn.partCount).toBe(3);
  });

  it("orders by seq, not by array position", () => {
    const s = composeTurn([
      part({ seq: 7, text: "late" }),
      part({ seq: 2, text: "early" }),
    ]).content as string;

    expect(s.indexOf("early")).toBeLessThan(s.indexOf("late"));
  });

  it("keeps each forward header inside its own section, never a neighbour's", () => {
    const parts = ["alice", "bob", "carol", "dave"].map((who, i) =>
      part({ seq: i, text: `[Forwarded from @${who}]\nbody-${who}` }),
    );
    const s = composeTurn(parts).content as string;

    // Split on the delimiters and check each section carries exactly one header
    // and the body that belongs to it.
    const sections = s.split(/--- \d+\/4 \(text\) ---\n/).slice(1);
    expect(sections).toHaveLength(4);
    for (const [i, who] of ["alice", "bob", "carol", "dave"].entries()) {
      expect(sections[i]!.trim()).toBe(`[Forwarded from @${who}]\nbody-${who}`);
    }
  });

  it("sets lastMessageText to the composed string, so /retry can replay it", () => {
    const turn = composeTurn([part({ seq: 0 }), part({ seq: 1 })]);
    expect(turn.lastMessageText).toBe(turn.content as string);
  });

  it("labels the batch BATCH and lists the kinds it contains", () => {
    const turn = composeTurn([
      part({ seq: 0, kind: "text", text: "look at this" }),
      part({ seq: 1, kind: "voice", text: "and this" }),
    ]);

    expect(turn.audit.kind).toBe("BATCH");
    expect(turn.audit.summary).toContain("2 parts: text+voice");
    expect(turn.audit.summary).toContain("look at this");
  });
});

// ── mixed batch: blocks, with media bound to its own part ─────────────────────

describe("composeTurn — a batch carrying media goes to blocks", () => {
  it("places every media block immediately after its own part's text block", () => {
    const parts = [
      part({ seq: 0, kind: "text", text: "no media here" }),
      part({ seq: 1, kind: "photo", text: "cat", media: [image("CAT")] }),
      part({ seq: 2, kind: "photo", text: "dog", media: [image("DOG1"), image("DOG2")] }),
      part({ seq: 3, kind: "pdf", text: "invoice", media: [pdf("INV")] }),
    ];
    const blocks = textBlocks(composeTurn(parts).content);

    // block 0 is the preamble
    expect(blocks[0]!.type).toBe("text");
    expect((blocks[0] as { text: string }).text).toContain("ONE turn");

    // For each part, find its text block and assert its media follows directly.
    for (const p of parts) {
      const idx = blocks.findIndex(
        (b) => b.type === "text" && (b as { text: string }).text.endsWith(p.text),
      );
      expect(idx).toBeGreaterThan(0);
      for (const [offset, media] of p.media.entries()) {
        expect(blocks[idx + 1 + offset]).toBe(media);
      }
      // and the block after the run is either a text block or the end
      const after = blocks[idx + 1 + p.media.length];
      if (after) expect(after.type).toBe("text");
    }
  });

  it("emits one text block per part plus the preamble, never merged", () => {
    const blocks = textBlocks(
      composeTurn([
        part({ seq: 0, kind: "photo", text: "a", media: [image()] }),
        part({ seq: 1, kind: "photo", text: "b", media: [image()] }),
      ]).content,
    );

    // preamble + (text + image) * 2
    expect(blocks).toHaveLength(5);
    expect(blocks.filter((b) => b.type === "text")).toHaveLength(3);
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(2);
  });

  it("still emits a delimiter block for a part with no text of its own", () => {
    const blocks = textBlocks(
      composeTurn([
        part({ seq: 0, kind: "photo", text: "", media: [image()] }),
        part({ seq: 1, kind: "text", text: "what do you see?" }),
      ]).content,
    );

    expect((blocks[1] as { text: string }).text).toBe("--- 1/2 (photo) ---");
    expect(blocks[2]!.type).toBe("image");
  });

  it("leaves lastMessageText unset when any part carries media", () => {
    const turn = composeTurn([
      part({ seq: 0, text: "caption", lastMessageText: "caption" }),
      part({ seq: 1, kind: "photo", text: "", media: [image()] }),
    ]);

    expect(turn.lastMessageText).toBeUndefined();
  });
});

// ── derived fields ───────────────────────────────────────────────────────────

describe("composeTurn — derived fields", () => {
  it("titles from the first part with a non-empty seed, skipping a bare photo", () => {
    const turn = composeTurn([
      part({ seq: 0, kind: "photo", text: "", titleSeed: "", media: [image()] }),
      part({ seq: 1, kind: "text", text: "the actual question", titleSeed: "the actual question" }),
    ]);

    expect(turn.titleSeed).toBe("the actual question");
  });

  it("falls back to the first part's seed when every seed is blank", () => {
    const turn = composeTurn([
      part({ seq: 0, titleSeed: "" }),
      part({ seq: 1, titleSeed: "   " }),
    ]);

    expect(turn.titleSeed).toBe("");
  });

  it("unions cleanupPaths across parts, in seq order", () => {
    const turn = composeTurn([
      part({ seq: 0, cleanupPaths: ["/tmp/a.jpg"] }),
      part({ seq: 1 }),
      part({ seq: 2, cleanupPaths: ["/tmp/b.pdf", "/tmp/c.txt"] }),
    ]);

    expect(turn.cleanupPaths).toEqual(["/tmp/a.jpg", "/tmp/b.pdf", "/tmp/c.txt"]);
  });

  it("carries cleanupPaths through the single-part path too", () => {
    const turn = composeTurn([part({ cleanupPaths: ["/tmp/only.jpg"] })]);
    expect(turn.cleanupPaths).toEqual(["/tmp/only.jpg"]);
  });

  it("truncates a long lead message in the audit summary", () => {
    const turn = composeTurn([
      part({ seq: 0, text: "x".repeat(500) }),
      part({ seq: 1 }),
    ]);

    expect(turn.audit.summary.length).toBeLessThan(200);
  });

  it("does not mutate the array it was given", () => {
    const parts = [part({ seq: 5 }), part({ seq: 1 })];
    const snapshot = [...parts];
    composeTurn(parts);
    expect(parts).toEqual(snapshot);
  });
});
