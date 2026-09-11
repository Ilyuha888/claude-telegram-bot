/**
 * Tests for buildPrimingPrompt (src/handlers/mode2/notifications.ts) — the
 * first message sent into the session a notification opens.
 *
 * Run with: bun test tests/notification-priming.test.ts
 */

import { describe, test, expect } from "bun:test";
import { buildPrimingPrompt } from "../src/handlers/mode2/notifications";
import type { Notification } from "../src/mode2/types";

function notif(over: Partial<Notification> = {}): Notification {
  return {
    id: "n1",
    fired_at: "2026-07-26T20:00:00.000Z",
    prompt_key: "weekly_curator",
    title: "Weekly curator",
    content: "3 stale drafts, 1 orphan note.",
    status: "unread",
    ...over,
  };
}

describe("skill routines", () => {
  for (const key of ["weekly_curator", "monthly_audit", "quarterly_review"]) {
    test(`${key} primes with /curator and carries the report`, () => {
      const p = buildPrimingPrompt(notif({ prompt_key: key }));
      expect(p.startsWith("/curator\n")).toBe(true);
      expect(p).toContain("3 stale drafts, 1 orphan note.");
      expect(p).toContain("2026-07-26T20:00:00.000Z");
      // The confirm-before-write guard is the whole point of this branch.
      expect(p).toContain("wait for my confirmation before any vault write");
    });
  }
});

describe("scribe reminders", () => {
  test("primes for outcome capture, quoting the reminder title", () => {
    const p = buildPrimingPrompt(
      notif({
        prompt_key: "scribe_reminder",
        title: "Call the consulate",
        content: "Reminder: Call the consulate\n\nNote: inbox/visa.md",
      })
    );
    expect(p).toContain('My reminder just fired: "Call the consulate"');
    expect(p).toContain("inbox/visa.md");
    expect(p).toContain("help me capture what I learned");
    expect(p.startsWith("/curator")).toBe(false);
  });
});

describe("everything else", () => {
  test("falls back to the generic act-on-this prompt", () => {
    const p = buildPrimingPrompt(
      notif({ prompt_key: "daily_focus", title: "Daily focus", content: "Ship milestone 4." })
    );
    expect(p).toContain("Here is a scheduled notification I received");
    expect(p).toContain("Ship milestone 4.");
    expect(p).toContain("What would you suggest?");
  });

  test("an unknown prompt_key does not pick a skill primer", () => {
    const p = buildPrimingPrompt(notif({ prompt_key: "something_new" }));
    expect(p.startsWith("/curator")).toBe(false);
  });
});
