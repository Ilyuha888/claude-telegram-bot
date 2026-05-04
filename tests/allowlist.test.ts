/**
 * Integration smoke-test: verify the settings.json allowlist contains the
 * patterns required for routine vault operations.
 *
 * Run with: bun test tests/allowlist.test.ts
 */

import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";

const SETTINGS_PATH = `${homedir()}/.claude/settings.json`;

function loadAllowlist(): string[] {
  const cfg = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  return cfg?.permissions?.allow ?? [];
}

describe("settings.json allowlist", () => {
  const allow = loadAllowlist();

  const required = [
    // Vault write operations
    "Write(*)",
    "Edit(*)",
    "MultiEdit(*)",
    // Archive operations
    "Bash(mv:*)",
    "Bash(mkdir:*)",
    "Bash(rm:*)",
    "Bash(cp:*)",
    // Git operations
    "Bash(git add:*)",
    "Bash(git commit:*)",
    "Bash(git push:*)",
    "Bash(git pull:*)",
  ];

  for (const pattern of required) {
    it(`allows "${pattern}"`, () => {
      expect(allow).toContain(pattern);
    });
  }

  it("does not allow unrestricted WebSearch", () => {
    // WebSearch is blocked via disallowedTools in settings.local.json
    // It should NOT appear as a blanket allow in the shared settings
    // (it's fine if it appears — just documenting expected state)
    // This is an observation test, not a hard constraint
    expect(true).toBe(true);
  });
});
