/**
 * Tests the failure contract every scheduled routine prompt must carry
 * (src/scheduler-prompts.ts).
 *
 * Origin: on 2026-07-29 and 07-30 the daily-focus routine made ZERO tool calls
 * and emitted "Nothing queued. Good time to do a weekly review." — a sentence
 * that reads like a healthy vault with nothing due, delivered while six projects
 * were active. Two days of digests were lost, and the routine looked green the
 * whole time: it fired, delivered a card, and updated last_fired.
 *
 * The cause was in the prompt: "if a path doesn't resolve, silently skip that
 * item — never narrate the problem" (added 2026-04-29 to stop the agent leaking
 * "Let me check the vault structure…" into a Telegram card). Suppressing
 * narration is still right; making failure indistinguishable from success was
 * not. These tests pin the fix so the silent variant can't come back — it passed
 * review once already.
 *
 * Run with: bun test tests/routine-failure-contract.test.ts
 */

import { describe, test, expect } from "bun:test";
import { PROMPTS, ROUTINE_ERROR_PREFIX } from "../src/scheduler-prompts";

const ROUTINES = Object.keys(PROMPTS);

describe("every routine prompt", () => {
  test("there are routines to check (guards a vacuous suite)", () => {
    expect(ROUTINES.length).toBeGreaterThanOrEqual(4);
  });

  for (const key of ROUTINES) {
    describe(key, () => {
      const body = PROMPTS[key]!.body;

      test("carries the failure contract", () => {
        expect(body).toContain("FAILURE CONTRACT");
      });

      test("names the machine-readable marker fire() matches on", () => {
        expect(body).toContain(ROUTINE_ERROR_PREFIX);
      });

      test("does NOT tell the agent to hide a failed read", () => {
        // The exact wording that caused the incident, plus the near-miss
        // paraphrases. A routine may never be instructed to absorb its own
        // failure into an empty section.
        expect(body).not.toMatch(/silently skip/i);
        expect(body).not.toMatch(/omit that section silently/i);
        expect(body).not.toMatch(/never (explain|narrate) what went wrong/i);
      });

      test("still suppresses conversational preamble", () => {
        // The original problem the silent rule solved is real and must not be
        // regressed in the other direction: these cards go straight to Telegram.
        expect(body).toMatch(/no (reasoning|preamble)/i);
      });
    });
  }
});

describe("daily_focus specifics", () => {
  const body = PROMPTS.daily_focus!.body;

  test("the empty-vault sentence must carry a scanned count", () => {
    // "Nothing queued" was the exact text delivered on both broken days. It is
    // still allowed — but only with an N it had to read the directory to know,
    // so it can no longer be produced by a run that called no tools at all.
    expect(body).toContain("Nothing queued (scanned N project files)");
    expect(body).not.toMatch(/"Nothing queued\. Good time/);
  });

  test("forbids inventing a project that has no file", () => {
    // Observed 2026-07-30: a run fabricated a `relocation-2026` project by
    // promoting an inbox note, and read next_action out of the note body
    // instead of the frontmatter.
    expect(body).toMatch(/never (promote|invent)/i);
    expect(body).toMatch(/VERBATIM from the frontmatter/i);
  });
});

describe("ROUTINE_ERROR_PREFIX", () => {
  test("is a stable single-token marker safe to prefix-match", () => {
    expect(ROUTINE_ERROR_PREFIX).toBe("ROUTINE_ERROR:");
    expect(ROUTINE_ERROR_PREFIX.trim()).toBe(ROUTINE_ERROR_PREFIX);
  });

  test("cannot collide with a legitimate digest opening", () => {
    // fire() dispatches on trimStart().startsWith(prefix), so a real report
    // must never begin with it. All four open with their own emoji.
    for (const key of ROUTINES) {
      expect(PROMPTS[key]!.body).toMatch(/response starts with (📅|📋|🗓|🔭)/u);
    }
  });
});
