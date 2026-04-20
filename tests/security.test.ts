/**
 * Tests for src/security.ts — path validation and command safety.
 *
 * Run with: bun test tests/security.test.ts
 * Requires ALLOWED_PATHS env to be set (or uses default from config).
 */

import { describe, it, expect } from "bun:test";

// Override ALLOWED_PATHS for predictable tests
process.env.ALLOWED_PATHS = "/home/assistant/repos/my_obsidian_knowledge_base,/home/assistant/.claude";
process.env.HOME = "/home/assistant";

// Import after setting env (config reads env at import time)
const { isPathAllowed, checkCommandSafety } = await import("../src/security");

const VAULT = "/home/assistant/repos/my_obsidian_knowledge_base";

describe("isPathAllowed", () => {
  it("allows files inside vault root", () => {
    expect(isPathAllowed(`${VAULT}/note.md`)).toBe(true);
  });

  it("allows deeply nested vault paths", () => {
    expect(isPathAllowed(`${VAULT}/User_Obsidian_Vault/Я студент/3 курс/note.md`)).toBe(true);
  });

  it("allows .claude directory", () => {
    expect(isPathAllowed("/home/assistant/.claude/settings.json")).toBe(true);
  });

  it("allows /tmp paths (temp dir)", () => {
    expect(isPathAllowed("/tmp/claude-telegram-bot/plan.md")).toBe(true);
  });

  it("blocks paths outside allowed dirs", () => {
    expect(isPathAllowed("/root/.ssh/id_rsa")).toBe(false);
  });

  it("blocks /etc/passwd", () => {
    expect(isPathAllowed("/etc/passwd")).toBe(false);
  });

  it("blocks home root (not a subpath match)", () => {
    expect(isPathAllowed("/home/assistant/secrets.env")).toBe(false);
  });

  it("blocks path traversal attempts", () => {
    expect(isPathAllowed(`${VAULT}/../../../etc/shadow`)).toBe(false);
  });
});

describe("checkCommandSafety", () => {
  it("allows safe git commands", () => {
    const [safe] = checkCommandSafety("git add .");
    expect(safe).toBe(true);
  });

  it("allows mv within vault", () => {
    const [safe] = checkCommandSafety(`mv "${VAULT}/a.md" "${VAULT}/b.md"`);
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

  it("blocks rm targeting paths outside allowed dirs", () => {
    const [safe] = checkCommandSafety("rm /root/.ssh/id_rsa");
    expect(safe).toBe(false);
  });

  it("allows rm inside vault", () => {
    const [safe] = checkCommandSafety(`rm "${VAULT}/stale-note.md"`);
    expect(safe).toBe(true);
  });
});
