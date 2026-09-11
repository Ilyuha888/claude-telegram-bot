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

// ============== Auto-approval policy ==============
//
// Local work is git-recoverable, so it auto-approves; only what leaves the VM or
// escalates privilege still asks. Accepted risk: `git clean`, `git reset --hard`
// and `git checkout --` also run unprompted. Two checks apply before this one:
// checkCommandSafety and the path checks above (hard blocks) settle first.

// A command is judged per segment: a segment ends at a separator outside quotes,
// and a subshell opener outside quotes starts an extra candidate while the
// enclosing segment stays whole, so `curl "$(url)" -X POST` is still seen as one
// curl call and `git commit -m "fix (ssh config)"` is not read as ssh.
function commandCandidates(command: string): string[] {
  const text = command.replace(/\\\r?\n/g, " ");
  const out: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let heredoc: string | null = null;
  const openers: number[] = [];
  const flush = (end: number) => {
    const segment = text.slice(start, end);
    out.push(segment, ...openers.map((pos) => text.slice(pos, end)));
    openers.length = 0;
    start = end;
  };
  // Heredoc bodies are data, not commands: skip to the line after the delimiter.
  const skipHeredoc = (from: number): number => {
    let i = from;
    while (i < text.length) {
      const nl = text.indexOf("\n", i);
      const line = text.slice(i, nl === -1 ? text.length : nl).trim();
      i = nl === -1 ? text.length : nl + 1;
      if (line === heredoc) break;
    }
    heredoc = null;
    return i;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
      else if (quote === '"' && c === "$" && text[i + 1] === "(") openers.push(i + 2);
      else if (quote === '"' && c === "`") openers.push(i + 1);
      continue;
    }
    if (c === "\\") { i++; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "<" && text[i + 1] === "<") {
      const m = /^<<-?\s*(?:'([^']+)'|"([^"]+)"|(\S+))/.exec(text.slice(i));
      if (m) { heredoc = m[1] ?? m[2] ?? m[3] ?? null; i += m[0].length - 1; }
      continue;
    }
    if (c === "$" && text[i + 1] === "(") { openers.push(i + 2); i++; continue; }
    if (c === "$" && text[i + 1] === "{") { const close = text.indexOf("}", i); i = close === -1 ? text.length : close; continue; }
    if (c === "`" || c === "(") { openers.push(i + 1); continue; }
    if (c === "\n") {
      flush(i);
      start = heredoc ? skipHeredoc(i + 1) : i + 1;
      i = start - 1;
      continue;
    }
    if ((c === "&" || c === "|") && text[i + 1] === c) { flush(i); start = i + 2; i++; continue; }
    if (c === ";" || c === "|" || c === "&" || c === "{" || c === "}") { flush(i); start = i + 1; continue; }
  }
  flush(text.length);
  return out;
}

// One token that may legitimately precede the real command, with its arguments.
// Applied repeatedly, one token at a time, so a greedy match cannot swallow the
// command itself the way a single regex with optional values would.
const WRAPPER_TOKEN_RE = new RegExp(
  "^(?:" +
    [
      "[A-Za-z_][A-Za-z0-9_]*=(?:\"[^\"]*\"|'[^']*'|\\S*)",
      "(?:if|then|else|elif|do|while|until|command|exec|setsid)\\b",
      "(?:time|nohup)(?:\\s+-p|\\s+--)?\\b",
      "!",
      "timeout(?:\\s+-\\S+(?:\\s+[^-\\s]\\S*)?)*\\s+\\d\\S*",
      "nice(?:\\s+-n?\\s*\\d+)?",
      "env(?:\\s+-u\\s*\\S+|\\s+-\\S+)*",
      "xargs(?:\\s+-[nIPLsdEa]\\s*\\S+|\\s+-\\S+)*",
      "(?:stdbuf|watch|parallel)(?:\\s+-\\S+)*",
      "sshpass(?:\\s+-\\S+(?:\\s+\\S+)?)*",
      "eval",
    ].join("|") +
    ")(?=\\s|$|[\"'])"
);

const REMOTE_CMD_RE =
  /^(?:sudo|su|doas|ssh|scp|sftp|rsync|mosh|telnet|sendmail|mail|mailx|mutt|msmtp|git\s+send-email)(?:\s|$)/;
// gh is judged like the connectors: read subcommands are listed, the rest asks.
const GH_GLOBAL_FLAGS = "(?:\\s+(?:-R|--repo|--hostname)[\\s=]\\S+)*";
const GH_READ_RE = new RegExp(
  `^gh${GH_GLOBAL_FLAGS}\\s+(?:(?:pr|issue|release|run|workflow|repo|gist|label|project|cache|ruleset|codespace|secret|variable|extension|alias|org|ssh-key|gpg-key)\\s+(?:view|list|status|diff|checks|checkout|download|clone|browse|search|watch|ls|get)(?:\\s|$)|search\\s|status(?:\\s|$)|browse(?:\\s|$)|auth\\s+status|version|help|--version|--help)`
);
const GH_API_RE = new RegExp(`^gh${GH_GLOBAL_FLAGS}\\s+api(?:\\s|$)`);
const WRITE_METHOD = "[\\s=]*[\"']?(?:[Pp][Oo][Ss][Tt]|[Pp][Uu][Tt]|[Pp][Aa][Tt][Cc][Hh]|[Dd][Ee][Ll][Ee][Tt][Ee])\\b";
const GH_API_WRITE_RE = new RegExp(`\\s(?:-X|--method)${WRITE_METHOD}|\\s-[a-zA-Z]*[fF]\\b|\\s--(?:field|raw-field|input)(?:\\s|=)`);
// `-f` also carries GET query parameters and GraphQL queries, which only read.
const GH_API_GET_RE = /\s(?:-X|--method)[\s=]*["']?GET\b/;
const GH_GRAPHQL_READ_RE = /^gh(?:\s+\S+)*?\s+api\s+graphql\b(?!.*(?:query=\s*["']?\s*mutation|--input))/;
// curl short flags are case-sensitive: -d/-F/-T always carry a body, -f/-D do not.
const CURL_WRITE_RE = new RegExp(
  `\\s-[a-zA-Z]*X\\s*[\"']?(?:[Pp][Oo][Ss][Tt]|[Pp][Uu][Tt]|[Pp][Aa][Tt][Cc][Hh]|[Dd][Ee][Ll][Ee][Tt][Ee])\\b|\\s--request${WRITE_METHOD}` +
    `|\\s-[a-zA-Z]*[dFT]|\\s--(?:data(?:-\\w+)?|form(?:-string)?|upload-file|json)(?:\\s|=|$)`
);
const WGET_WRITE_RE = new RegExp(`\\s--(?:post-(?:data|file)|body-(?:data|file)|method${WRITE_METHOD})`);

function stripWrappers(segment: string): string {
  // `$(which ssh) host` names ssh as surely as `ssh host` does.
  let s = segment.replace(/\$\((?:which|command -v)\s+(\S+?)\)|`(?:which|command -v)\s+(\S+?)`/g, "$1$2").trimStart();
  for (;;) {
    const m = WRAPPER_TOKEN_RE.exec(s);
    if (!m) break;
    s = s.slice(m[0].length).trimStart();
  }
  // `\ssh`, `"ssh"`, `/usr/bin/ssh` all name the same binary.
  return s.replace(/^(?:\\|["'])?(?:\S*\/)?(?=\S)/, "").replace(/^(\S+)["']/, "$1");
}

const SH_C_RE = /^(?:ba|z)?sh\s+-[a-z]*c\s+(.*)$/s;

function isRemoteWriteSegment(segment: string): boolean {
  const cmd = stripWrappers(segment);
  // `bash -c '…'` carries a whole script; judge its contents, not its first word.
  const shc = SH_C_RE.exec(cmd);
  if (shc) {
    const inner = shc[1]!.trim().replace(/^(["'])([\s\S]*)\1(?:\s.*)?$/, "$2");
    return isRemoteWriteCommand(inner);
  }
  if (REMOTE_CMD_RE.test(cmd)) return true;
  if (/^gh(?:\s|$)/.test(cmd)) {
    if (GH_API_RE.test(cmd)) {
      if (GH_API_GET_RE.test(cmd) || GH_GRAPHQL_READ_RE.test(cmd)) return false;
      return GH_API_WRITE_RE.test(cmd);
    }
    return !GH_READ_RE.test(cmd);
  }
  if (/^curl(?:\s|$)/.test(cmd)) return CURL_WRITE_RE.test(cmd);
  if (/^wget(?:\s|$)/.test(cmd)) return WGET_WRITE_RE.test(cmd);
  return false;
}

/** True when any segment of the command leaves the VM or escalates privilege. */
export function isRemoteWriteCommand(command: string): boolean {
  if (!command) return false;
  return commandCandidates(command).some(isRemoteWriteSegment);
}

// claude.ai connector tools are classified by verb. Unknown verbs count as
// writes, so a new connector fails closed until its read verbs (or its tool-name
// prefix, as with Slack and Notion) are added here.
const CLAUDE_AI_TOOL_RE = /^mcp__claude_ai_.+?__(.+)$/;
const CONNECTOR_TOOL_PREFIX_RE = /^(?:slack_|notion-)/;
const MCP_READ_VERB_RE =
  /^(?:get|list|search|fetch|read|query|find|lookup|download|whoami|suggest|check|show|describe|resolve|status|export|render|compare|analy[sz]e|retrieve|ai-search|atlassianUserInfo)(?:[_\-A-Z]|$)/;

/** True for a claude.ai connector tool whose name says it only reads. */
export function isClaudeAiReadTool(toolName: string): boolean {
  const m = CLAUDE_AI_TOOL_RE.exec(toolName);
  if (!m) return false;
  return MCP_READ_VERB_RE.test(m[1]!.replace(CONNECTOR_TOOL_PREFIX_RE, ""));
}

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
// Config files that change future sessions' behaviour. Writes here are never
// auto-approved, even inside ALLOWED_PATHS: ~/.claude is in ALLOWED_PATHS, so a
// write to CLAUDE.md or settings*.json used to be auto-approved — which is how a
// single conversational turn silently rewrote the global instructions for every
// future session, on both accounts once the sync hook pushed it.
const CONFIG_WRITE_RE =
  /(^|\/)(CLAUDE(\.local)?\.md|settings(\.local)?\.json|\.mcp\.json)$|\/\.claude\/(rules|skills|agents|commands|hooks)\//i;

function extractPath(input: Record<string, unknown>): string | null {
  const p = (input.file_path ?? input.path ?? input.notebook_path) as string | undefined;
  return p ?? null;
}

/**
 * The mode-1 auto-approval decision for a tool call that the CLI's own allow
 * rules did not already settle. False means "ask the user".
 */
export function checkAutoApprove(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName.startsWith("mcp__send-file")) return true;
  if (toolName.startsWith("mcp__ask-user")) return true;
  if (toolName.startsWith("mcp__haft")) return true;
  if (toolName.startsWith("mcp__plugin_context7")) return true;
  // Network-only or local by construction; prompting for every search made
  // research unusable over Telegram.
  if (toolName === "WebSearch" || toolName === "WebFetch" || toolName === "Skill") return true;
  // Subagents' own tool calls come back through this same callback.
  if (toolName === "Agent" || toolName === "Task") return true;
  if (toolName.startsWith("mcp__claude_ai_")) return isClaudeAiReadTool(toolName);
  if (WRITE_TOOLS.has(toolName) || toolName === "Read") {
    const p = extractPath(input);
    if (p === null || !isPathAllowed(p)) return false;
    if (toolName !== "Read" && CONFIG_WRITE_RE.test(p)) return false;
    return true;
  }
  if (toolName === "Bash") {
    if (typeof input.command !== "string") return false;
    const cmd = input.command;
    const [safe] = checkCommandSafety(cmd);
    return safe && !isRemoteWriteCommand(cmd);
  }
  return false;
}

// ============== Authorization ==============

export function isAuthorized(
  userId: number | undefined,
  allowedUser: number
): boolean {
  if (!userId) return false;
  if (!allowedUser || Number.isNaN(allowedUser)) return false;
  return userId === allowedUser;
}
