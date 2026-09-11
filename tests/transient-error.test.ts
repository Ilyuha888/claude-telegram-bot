/**
 * Tests for isTransientClaudeError (src/utils.ts) — the gate on whether the
 * scheduler retries a failed routine fire.
 *
 * Origin: on 2026-07-30 the 09:00 daily-focus routine died 3.5 minutes into its
 * query on `API Error: 529 Overloaded`, and `fire()` logged to the journal and
 * returned. No card, no `last_fired` update, no trace anywhere the user looks —
 * the failure surfaced a day later as "is the scheduler broken?".
 *
 * Both directions matter here, and the negative cases are the load-bearing ones:
 * a false positive means a deterministic bug gets re-run twice with minutes of
 * backoff before anyone is told about it, which converts a fast clear failure
 * into a slow confusing one.
 *
 * Run with: bun test tests/transient-error.test.ts
 */

import { describe, test, expect } from "bun:test";
import { isTransientClaudeError } from "../src/utils";

/** The verbatim first line of the error that started this, from the journal. */
const REAL_529 =
  "Error: Claude Code returned an error result: API Error: 529 Overloaded. " +
  "This is a server-side issue, usually temporary — try again in a moment. " +
  "If it persists, check https://status.claude.com.";

describe("isTransientClaudeError — retry", () => {
  test("the 529 that broke the 2026-07-30 daily focus", () => {
    expect(isTransientClaudeError(new Error(REAL_529))).toBe(true);
  });

  test("upstream status codes", () => {
    for (const code of [429, 500, 502, 503, 504, 529]) {
      expect(isTransientClaudeError(new Error(`API Error: ${code}`))).toBe(true);
    }
  });

  test("prose-only upstream failures with no status code", () => {
    for (const msg of [
      "Overloaded",
      "Service Unavailable",
      "rate limit exceeded",
      "rate_limit_error",
      "Internal server error",
      "Bad Gateway",
      "Gateway Timeout",
    ]) {
      expect(isTransientClaudeError(new Error(msg))).toBe(true);
    }
  });

  test("socket and DNS failures", () => {
    for (const msg of [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EAI_AGAIN api.anthropic.com",
      "getaddrinfo ENOTFOUND api.anthropic.com",
      "socket hang up",
      "fetch failed",
    ]) {
      expect(isTransientClaudeError(new Error(msg))).toBe(true);
    }
  });

  test("classifies a bare string as readily as an Error", () => {
    expect(isTransientClaudeError(REAL_529)).toBe(true);
  });
});

describe("isTransientClaudeError — do not retry", () => {
  test("a stop stays stopped", () => {
    expect(isTransientClaudeError(new Error("AbortError: operation was aborted"))).toBe(false);
    expect(isTransientClaudeError(new Error("Query cancelled by user"))).toBe(false);
  });

  test("an over-long prompt stays over-long", () => {
    expect(isTransientClaudeError(new Error("prompt is too long: 210000 tokens > 200000"))).toBe(false);
  });

  test("a collected transcript does not come back", () => {
    expect(isTransientClaudeError(new Error("No conversation found with session ID abc123"))).toBe(false);
  });

  test("ordinary deterministic failures are reported, not re-run", () => {
    for (const msg of [
      "TypeError: undefined is not a function",
      "ENOENT: no such file or directory, open '/home/user/vault/inbox'",
      "Permission denied",
      "Invalid API key · Fix external API key",
      "spawn claude ENOENT",
    ]) {
      expect(isTransientClaudeError(new Error(msg))).toBe(false);
    }
  });

  test("a longer number containing a status code is not a status code", () => {
    // Word boundaries do the work: only the listed codes match, so a byte
    // count or a token total can't be read as an upstream status.
    expect(isTransientClaudeError(new Error("wrote 502400 bytes"))).toBe(false);
    expect(isTransientClaudeError(new Error("token total 5290"))).toBe(false);
  });

  test("KNOWN false positive: a standalone status-like number anywhere", () => {
    // Documented, not endorsed. A bare `\b429\b` match retries this three times
    // before reporting it. Accepted because the cost is ~6 minutes of backoff on
    // a routine nobody is waiting for, and the alternative — anchoring on "API
    // Error: <code>" — would miss the socket-level and prose-only failures above,
    // which are the ones that actually recur. Revisit if a real error trips it.
    expect(isTransientClaudeError(new Error("failed at line 429:12"))).toBe(true);
  });
});
