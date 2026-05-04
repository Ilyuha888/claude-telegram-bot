/**
 * Tests for src/security.ts — path validation and command safety.
 *
 * Run with: bun test tests/security.test.ts
 * Uses the actual ALLOWED_PATHS from config so tests work on any machine.
 */

import { describe, it, expect } from "bun:test";
import { isPathAllowed, checkCommandSafety } from "../src/security";
import { ALLOWED_PATHS } from "../src/config";

// Use the first configured allowed path as a stand-in for "an allowed dir".
// Avoids hardcoded personal paths while keeping tests meaningful.
const ALLOWED_DIR = ALLOWED_PATHS[0] ?? "/tmp";

describe("isPathAllowed", () => {
  it("allows files inside a configured allowed dir", () => {
    expect(isPathAllowed(`${ALLOWED_DIR}/note.md`)).toBe(true);
  });

  it("allows deeply nested paths inside an allowed dir", () => {
    expect(isPathAllowed(`${ALLOWED_DIR}/sub/dir/note.md`)).toBe(true);
  });

  it("allows /tmp paths (temp dir)", () => {
    expect(isPathAllowed("/tmp/claude-telegram-bot/plan.md")).toBe(true);
  });

  it("blocks /root/.ssh/id_rsa", () => {
    expect(isPathAllowed("/root/.ssh/id_rsa")).toBe(false);
  });

  it("blocks /etc/passwd", () => {
    expect(isPathAllowed("/etc/passwd")).toBe(false);
  });

  it("blocks the parent of an allowed dir (exact prefix not a subpath)", () => {
    // e.g. if /home/user/repos is allowed, /home/user/secrets.env must not be
    const parent = ALLOWED_DIR.split("/").slice(0, -1).join("/");
    if (parent && !ALLOWED_PATHS.includes(parent)) {
      expect(isPathAllowed(`${parent}/secrets.env`)).toBe(false);
    }
  });

  it("blocks path traversal attempts", () => {
    expect(isPathAllowed(`${ALLOWED_DIR}/../../../etc/shadow`)).toBe(false);
  });
});

describe("checkCommandSafety", () => {
  it("allows safe git commands", () => {
    const [safe] = checkCommandSafety("git add .");
    expect(safe).toBe(true);
  });

  it("allows mv within an allowed dir", () => {
    const [safe] = checkCommandSafety(`mv "${ALLOWED_DIR}/a.md" "${ALLOWED_DIR}/b.md"`);
    expect(safe).toBe(true);
  });

  it("blocks rm -rf /", () => {
    const [safe, reason] = checkCommandSafety("rm -rf /");
    expect(safe).toBe(false);
    expect(reason).toMatch(/rm -rf \//i);
  });

  it("blocks rm -rf ~", () => {
    const [safe] = checkCommandSafety("rm -rf ~");
    expect(safe).toBe(false);
  });

  it("blocks fork bomb", () => {
    const [safe] = checkCommandSafety(":(){ :|:& };:");
    expect(safe).toBe(false);
  });

  it("blocks rm targeting /root", () => {
    const [safe] = checkCommandSafety("rm /root/.ssh/id_rsa");
    expect(safe).toBe(false);
  });

  it("allows rm inside an allowed dir", () => {
    const [safe] = checkCommandSafety(`rm "${ALLOWED_DIR}/stale-note.md"`);
    expect(safe).toBe(true);
  });
});
