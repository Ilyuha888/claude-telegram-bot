/**
 * Security module for Claude Telegram Bot.
 *
 * Rate limiting, path validation, command safety.
 */

import { resolve, normalize } from "path";
import { realpathSync } from "fs";
import type { RateLimitBucket } from "./types";
import {
  ALLOWED_PATHS,
  BLOCKED_PATTERNS,
  RATE_LIMIT_ENABLED,
  RATE_LIMIT_REQUESTS,
  RATE_LIMIT_WINDOW,
  TEMP_PATHS,
} from "./config";

// ============== Rate Limiter ==============

class RateLimiter {
  private buckets = new Map<number, RateLimitBucket>();
  private maxTokens: number;
  private refillRate: number; // tokens per second

  constructor() {
    this.maxTokens = RATE_LIMIT_REQUESTS;
    this.refillRate = RATE_LIMIT_REQUESTS / RATE_LIMIT_WINDOW;
  }

  check(userId: number): [allowed: boolean, retryAfter?: number] {
    if (!RATE_LIMIT_ENABLED) {
      return [true];
    }

    const now = Date.now();
    let bucket = this.buckets.get(userId);

    if (!bucket) {
      bucket = { tokens: this.maxTokens, lastUpdate: now };
      this.buckets.set(userId, bucket);
    }

    // Refill tokens based on time elapsed
    const elapsed = (now - bucket.lastUpdate) / 1000;
    bucket.tokens = Math.min(
      this.maxTokens,
      bucket.tokens + elapsed * this.refillRate
    );
    bucket.lastUpdate = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return [true];
    }

    // Calculate time until next token
    const retryAfter = (1 - bucket.tokens) / this.refillRate;
    return [false, retryAfter];
  }

  getStatus(userId: number): {
    tokens: number;
    max: number;
    refillRate: number;
  } {
    const bucket = this.buckets.get(userId);
    return {
      tokens: bucket?.tokens ?? this.maxTokens,
      max: this.maxTokens,
      refillRate: this.refillRate,
    };
  }
}

export const rateLimiter = new RateLimiter();

// ============== Path Validation ==============

export function isPathAllowed(path: string): boolean {
  try {
    // Expand ~ and resolve to absolute path
    const expanded = path.replace(/^~/, process.env.HOME || "");
    const normalized = normalize(expanded);

    // Try to resolve symlinks (may fail if path doesn't exist yet)
    let resolved: string;
    try {
      resolved = realpathSync(normalized);
    } catch {
      resolved = resolve(normalized);
    }

    // Always allow temp paths (for bot's own files)
    for (const tempPath of TEMP_PATHS) {
      if (resolved.startsWith(tempPath)) {
        return true;
      }
    }

    // Check against allowed paths using proper containment
    for (const allowed of ALLOWED_PATHS) {
      const allowedResolved = resolve(allowed);
      if (
        resolved === allowedResolved ||
        resolved.startsWith(allowedResolved + "/")
      ) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

// ============== Command Safety ==============

export function checkCommandSafety(
  command: string
): [safe: boolean, reason: string] {
  const lowerCommand = command.toLowerCase();

  // Check blocked patterns
  for (const pattern of BLOCKED_PATTERNS) {
    if (lowerCommand.includes(pattern.toLowerCase())) {
      return [false, `Blocked pattern: ${pattern}`];
    }
  }

  // Special handling for rm commands - validate paths
  if (lowerCommand.includes("rm ")) {
    try {
      // Simple parsing: extract arguments after rm
      const rmMatch = command.match(/rm\s+(.+)/i);
      if (rmMatch) {
        const args = rmMatch[1]!.split(/\s+/);
        for (const arg of args) {
          // Skip flags
          if (arg.startsWith("-") || arg.length <= 1) continue;

          // Strip surrounding quotes before path validation
          const unquotedArg = arg.replace(/^["']|["']$/g, "");

          // Check if path is allowed
          if (!isPathAllowed(unquotedArg)) {
            return [false, `rm target outside allowed paths: ${unquotedArg}`];
          }
        }
      }
    } catch {
      // If parsing fails, be cautious
      return [false, "Could not parse rm command for safety check"];
    }
  }

  return [true, ""];
}

// ============== Bash auto-approve allowlist ==============

const BASH_SHELL_META_RE = /[;&|`$()<>]|>>|&&|\|\|/;

// argv[0] prefix match for known read-only utilities.
// awk/sed intentionally excluded: `awk 'BEGIN{system("...")}' ` is a live execution path.
const BASH_AUTO_APPROVE_RE =
  /^\s*(ls|pwd|cat|head|tail|wc|stat|file|du|df|which|whereis|echo|printf|tree|find|grep|rg|ag|fd|sort|uniq|cut|jq|yq|column|date|env|hostname|uname|true|false|test|\[)(\s|$)/;

// Read-only git subcommands — none mutate working tree, index, refs, or remote.
const GIT_READONLY_RE =
  /^\s*git\s+(status|diff|log|show|branch|rev-parse|describe|ls-files|ls-tree|blame|grep|shortlog|reflog|cat-file|symbolic-ref|merge-base|whatchanged|stash\s+list|tag\s+-l|tag\s*$|remote\s+(?:-v|show)|config\s+--get)(\s|$)/;

// find -exec/-delete bypasses the shell-meta check since the command is an argument.
const BASH_FIND_DESTRUCTIVE_RE = /\bfind\b.*\s-(exec|execdir|delete|ok)\b/;

export function isBashAutoApprovable(command: string): boolean {
  if (!command) return false;
  if (BASH_SHELL_META_RE.test(command)) return false;
  if (BASH_FIND_DESTRUCTIVE_RE.test(command)) return false;
  return GIT_READONLY_RE.test(command) || BASH_AUTO_APPROVE_RE.test(command);
}

// ============== Authorization ==============

export function isAuthorized(
  userId: number | undefined,
  allowedUsers: number[]
): boolean {
  if (!userId) return false;
  if (allowedUsers.length === 0) return false;
  return allowedUsers.includes(userId);
}
