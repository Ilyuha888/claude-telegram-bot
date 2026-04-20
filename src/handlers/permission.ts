/**
 * Permission request routing for Claude Telegram Bot.
 *
 * Bridges the SDK's canUseTool callback to Telegram inline keyboards.
 * A permission request suspends the streaming loop until the user
 * taps Allow or Deny; the button callback resolves the in-flight Promise.
 */

import { InlineKeyboard } from "grammy";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";

interface PendingPermission {
  resolve: (result: PermissionResult) => void;
  timeout: ReturnType<typeof setTimeout>;
  originalInput: Record<string, unknown>;
  toolDisplay: string;
}

// Active permission requests keyed by requestId
const pendingPermissions = new Map<string, PendingPermission>();

const PERMISSION_TIMEOUT_MS = 900_000; // 15 minutes

/**
 * Register a permission request and return a Promise that resolves when
 * the user responds (or after a 15-minute timeout that auto-denies).
 * originalInput is stored so the allow result can echo it back to the SDK.
 */
export function awaitPermission(
  requestId: string,
  originalInput: Record<string, unknown>,
  toolDisplay: string
): Promise<PermissionResult> {
  return new Promise<PermissionResult>((resolve) => {
    const timeout = setTimeout(() => {
      if (pendingPermissions.delete(requestId)) {
        console.warn(
          `Permission request ${requestId} timed out after ${PERMISSION_TIMEOUT_MS / 1000}s — auto-denying with interrupt`
        );
        resolve({
          behavior: "deny",
          message: "Permission request timed out — no response from user",
          interrupt: true,
        });
      }
    }, PERMISSION_TIMEOUT_MS);

    pendingPermissions.set(requestId, { resolve, timeout, originalInput, toolDisplay });
  });
}

/**
 * Resolve a pending permission request.
 * decision: "allow" | "deny"
 * Returns { ok, toolDisplay? } — ok=false if expired/unknown.
 */
export function resolvePermissionRequest(
  requestId: string,
  decision: "allow" | "deny"
): { ok: boolean; toolDisplay?: string } {
  const pending = pendingPermissions.get(requestId);
  if (!pending) return { ok: false };

  clearTimeout(pending.timeout);
  pendingPermissions.delete(requestId);

  const result: PermissionResult =
    decision === "allow"
      ? { behavior: "allow", updatedInput: pending.originalInput }
      : {
          behavior: "deny",
          message: "Denied by user via Telegram",
          interrupt: true,
        };

  pending.resolve(result);
  return { ok: true, toolDisplay: pending.toolDisplay };
}

/**
 * Build a two-button Allow / Deny keyboard for a permission request.
 */
export function createPermissionKeyboard(requestId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Allow", `permask:${requestId}:allow`)
    .text("❌ Deny", `permask:${requestId}:deny`);
}

/**
 * Format a human-readable permission prompt for display in Telegram.
 */
export function formatPermissionPrompt(
  toolDisplay: string,
  decisionReason?: string,
  blockedPath?: string
): string {
  let msg = `🔐 <b>Permission request</b>\n${toolDisplay}`;
  if (blockedPath) msg += `\n📁 <code>${blockedPath}</code>`;
  if (decisionReason) msg += `\n<i>${decisionReason}</i>`;
  return msg;
}
