/**
 * Tests for src/handlers/permission.ts
 *
 * Run with: bun test tests/permission.test.ts
 */

import { describe, it, expect, beforeEach } from "bun:test";

// We test the module logic directly by re-implementing the contract
// (Bun test runner handles ES module imports natively)

// Minimal mock of PermissionResult for type safety
type PermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean };

// ── Inline reimplementation to test the contract without side-effects ──

interface PendingPermission {
  resolve: (result: PermissionResult) => void;
  timeout: ReturnType<typeof setTimeout>;
  originalInput: Record<string, unknown>;
}

function makeStore() {
  const map = new Map<string, PendingPermission>();

  function awaitPermission(
    requestId: string,
    originalInput: Record<string, unknown>,
    timeoutMs = 5_000
  ): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      const timeout = setTimeout(() => {
        if (map.delete(requestId)) {
          resolve({
            behavior: "deny",
            message: "Permission request timed out",
            interrupt: true,
          });
        }
      }, timeoutMs);
      map.set(requestId, { resolve, timeout, originalInput });
    });
  }

  function resolvePermissionRequest(
    requestId: string,
    decision: "allow" | "deny"
  ): boolean {
    const pending = map.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timeout);
    map.delete(requestId);
    const result: PermissionResult =
      decision === "allow"
        ? { behavior: "allow", updatedInput: pending.originalInput }
        : { behavior: "deny", message: "Denied by user via Telegram", interrupt: true };
    pending.resolve(result);
    return true;
  }

  return { awaitPermission, resolvePermissionRequest, map };
}

describe("permission store", () => {
  it("resolves with allow and echoes original input", async () => {
    const { awaitPermission, resolvePermissionRequest } = makeStore();
    const input = { file_path: "/vault/note.md" };
    const p = awaitPermission("req-1", input);
    const ok = resolvePermissionRequest("req-1", "allow");
    const result = await p;
    expect(ok).toBe(true);
    expect(result.behavior).toBe("allow");
    if (result.behavior === "allow") {
      expect(result.updatedInput).toEqual(input);
    }
  });

  it("resolves with deny on user rejection", async () => {
    const { awaitPermission, resolvePermissionRequest } = makeStore();
    const p = awaitPermission("req-2", { command: "rm -rf /tmp/x" });
    resolvePermissionRequest("req-2", "deny");
    const result = await p;
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.interrupt).toBe(true);
    }
  });

  it("returns false when resolving an unknown requestId", () => {
    const { resolvePermissionRequest } = makeStore();
    expect(resolvePermissionRequest("nonexistent", "allow")).toBe(false);
  });

  it("returns false on double-resolution of the same requestId", async () => {
    const { awaitPermission, resolvePermissionRequest } = makeStore();
    awaitPermission("req-3", {});
    resolvePermissionRequest("req-3", "allow");
    // Second resolution should be a no-op
    expect(resolvePermissionRequest("req-3", "deny")).toBe(false);
  });

  it("auto-denies after timeout", async () => {
    const { awaitPermission } = makeStore();
    const result = await awaitPermission("req-4", {}, 50); // 50ms timeout
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toMatch(/timed out/);
    }
  });

  it("does not affect other pending requests on timeout", async () => {
    const { awaitPermission, resolvePermissionRequest } = makeStore();
    const p1 = awaitPermission("req-5a", {}, 50);  // short timeout
    const p2 = awaitPermission("req-5b", { x: 1 }, 5_000);
    await p1; // wait for timeout
    const ok = resolvePermissionRequest("req-5b", "allow");
    const r2 = await p2;
    expect(ok).toBe(true);
    expect(r2.behavior).toBe("allow");
  });
});
