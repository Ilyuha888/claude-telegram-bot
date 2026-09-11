/**
 * Tests for the pure helpers in src/topics.ts — topic naming and deep links.
 * `spawnTopicSession` itself needs a live Telegram API and is not covered here.
 *
 * Run with: bun test tests/topics.test.ts
 */

import { describe, test, expect } from "bun:test";
import { topicName, defaultTopicName, topicLink } from "../src/topics";

describe("topicName", () => {
  test("keeps a normal title as-is", () => {
    expect(topicName("Visa paperwork")).toBe("Visa paperwork");
  });

  test("collapses whitespace and trims", () => {
    expect(topicName("  weekly   curator \n report ")).toBe("weekly curator report");
  });

  test("truncates to Telegram's 128-char limit, ellipsis included", () => {
    const out = topicName("x".repeat(500));
    expect(out.length).toBe(128);
    expect(out.endsWith("…")).toBe(true);
  });

  test("a 128-char title is passed through untouched", () => {
    const exact = "y".repeat(128);
    expect(topicName(exact)).toBe(exact);
  });

  test("an empty or whitespace-only name falls back to the default", () => {
    expect(topicName("")).toMatch(/^Session /);
    expect(topicName("   ")).toMatch(/^Session /);
  });
});

describe("defaultTopicName", () => {
  test("is a timestamped session name within the length limit", () => {
    const name = defaultTopicName(new Date("2026-07-26T09:05:00Z"));
    expect(name.startsWith("Session ")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(128);
  });
});

describe("topicLink", () => {
  test("builds a t.me/c link for a private supergroup", () => {
    expect(topicLink(-1002222222222, 77)).toBe("https://t.me/c/2222222222/77");
  });

  test("returns null for ids that aren't private supergroups", () => {
    // A DM and a legacy group have no /c/ deep-link form — better no link
    // than a broken one.
    expect(topicLink(751936510, 77)).toBeNull();
    expect(topicLink(-123456, 77)).toBeNull();
  });
});
