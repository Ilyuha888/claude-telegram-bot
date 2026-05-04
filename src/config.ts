/**
 * Configuration for Claude Telegram Bot.
 *
 * All environment variables, paths, constants, and safety settings.
 */

import { homedir } from "os";
import { resolve, dirname } from "path";
import { mkdir } from "fs/promises";
import type { McpServerConfig } from "./types";

// ============== Environment Setup ==============

const HOME = homedir();

// Ensure necessary paths are available for Claude's bash commands
// LaunchAgents don't inherit the full shell environment
const EXTRA_PATHS = [
  `${HOME}/.local/bin`,
  `${HOME}/.bun/bin`,
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
];

const currentPath = process.env.PATH || "";
const pathParts = currentPath.split(":");
for (const extraPath of EXTRA_PATHS) {
  if (!pathParts.includes(extraPath)) {
    pathParts.unshift(extraPath);
  }
}
process.env.PATH = pathParts.join(":");

// ============== Core Configuration ==============

export const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const ALLOWED_USERS: number[] = (
  process.env.TELEGRAM_ALLOWED_USERS || ""
)
  .split(",")
  .filter((x) => x.trim())
  .map((x) => parseInt(x.trim(), 10))
  .filter((x) => !isNaN(x));

export const WORKING_DIR = process.env.CLAUDE_WORKING_DIR || HOME;
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// Mode-2 base paths — defined early so they can be included in ALLOWED_PATHS
export const REPOS_DIR = process.env.REPOS_DIR || `${HOME}/repos`;
export const BOT_DATA_DIR = process.env.BOT_DATA_DIR || `${HOME}/bot-data`;

// ============== Claude CLI Path ==============

// Auto-detect from PATH, or use environment override
function findClaudeCli(): string {
  const envPath = process.env.CLAUDE_CLI_PATH;
  if (envPath) return envPath;

  // Try to find claude in PATH using Bun.which
  const whichResult = Bun.which("claude");
  if (whichResult) return whichResult;

  // Final fallback
  return "/usr/local/bin/claude";
}

export const CLAUDE_CLI_PATH = findClaudeCli();

// ============== MCP Configuration ==============

// MCP servers loaded from mcp-config.ts
let MCP_SERVERS: Record<string, McpServerConfig> = {};

try {
  // Dynamic import of MCP config
  const mcpConfigPath = resolve(dirname(import.meta.dir), "mcp-config.ts");
  const mcpModule = await import(mcpConfigPath).catch(() => null);
  if (mcpModule?.MCP_SERVERS) {
    MCP_SERVERS = mcpModule.MCP_SERVERS;
    console.log(
      `Loaded ${Object.keys(MCP_SERVERS).length} MCP servers from mcp-config.ts`
    );
  }
} catch {
  console.log("No mcp-config.ts found - running without MCPs");
}

export { MCP_SERVERS };

// ============== Security Configuration ==============

// Allowed directories for file operations
const defaultAllowedPaths = [
  WORKING_DIR,
  `${HOME}/Documents`,
  `${HOME}/Downloads`,
  `${HOME}/Desktop`,
  `${HOME}/.claude`, // Claude Code data (plans, settings)
  REPOS_DIR,         // repos for Mode-2 /work sessions
  BOT_DATA_DIR,      // sessions.json and bot runtime data
];

const allowedPathsStr = process.env.ALLOWED_PATHS || "";
export const ALLOWED_PATHS: string[] = allowedPathsStr
  ? allowedPathsStr
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
  : defaultAllowedPaths;

// Propagate the resolved allowlist into MCP subprocess servers that enforce
// paths (currently only send-file). Subprocesses can't see the bot's
// defaultAllowedPaths, so we serialize the effective list into their env.
const sendFileEntry = MCP_SERVERS["send-file"];
if (sendFileEntry && !("type" in sendFileEntry)) {
  sendFileEntry.env = {
    ...(sendFileEntry.env ?? {}),
    ALLOWED_PATHS: ALLOWED_PATHS.join(","),
  };
}

// Build safety prompt dynamically from ALLOWED_PATHS
function buildSafetyPrompt(allowedPaths: string[]): string {
  const pathsList = allowedPaths
    .map((p) => `   - ${p} (and subdirectories)`)
    .join("\n");

  return `
CRITICAL SAFETY RULES FOR TELEGRAM BOT:

1. NEVER delete, remove, or overwrite files without EXPLICIT confirmation from the user.
   - If user asks to delete something, respond: "Are you sure you want to delete [file]? Reply 'yes delete it' to confirm."
   - Only proceed with deletion if user replies with explicit confirmation like "yes delete it", "confirm delete"
   - This applies to: rm, trash, unlink, shred, or any file deletion

2. You can ONLY access files in these directories:
${pathsList}
   - REFUSE any file operations outside these paths

3. NEVER run dangerous commands like:
   - rm -rf (recursive force delete)
   - Any command that affects files outside allowed directories
   - Commands that could damage the system

4. For any destructive or irreversible action, ALWAYS ask for confirmation first.

5. When the user sends an image, describe ONLY what you can directly see. If image content is unclear or ambiguous, ask the user to clarify rather than guessing.

6. PKM SKILL ROUTING — use these skills instead of ad-hoc vault writes:
   - /scribe: whenever the user wants to capture a thought, save a note, voice memo, or reminder. Triggers: "note for tomorrow", "save this", "remember that", "note:", "capture", "write this down", "add to inbox", or any intent to persist information to the vault. Do NOT create vault files manually — /scribe enforces correct frontmatter, duplicate checks, and commit-confirm.
   - /retriever: whenever the user asks about personal knowledge or searches their vault. Triggers: "what do I know about", "have I thought about", "do I have notes on", "find my notes on", "search my vault", "what did I capture about", or any intent to retrieve personal knowledge.
   - /curator: whenever the user wants a vault health check. Triggers: "what needs attention", "what's stale", "vault health", "clean up my vault", "curation report", or asks for an overview of vault state.

7. REMINDER MECHANISM — the ONLY way to set a reminder that will be delivered via this Telegram bot is to write an entry directly to ${BOT_DATA_DIR}/schedules.json using this exact script:
   bun -e "
   const fs = require('fs');
   const path = '${BOT_DATA_DIR}/schedules.json';
   const data = JSON.parse(fs.readFileSync(path, 'utf8'));
   data.schedules.push({
     id: 'remind-' + crypto.randomUUID().slice(0, 8),
     cron: '',
     tz: 'Europe/Moscow',
     prompt_key: 'scribe_reminder',
     last_fired: 'FIRE_AT_ISO',
     one_shot: true,
     payload: { reminder_message: 'REMINDER_TEXT', note_path: 'NOTE_PATH' }
   });
   fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\\n');
   "
   NEVER use CronCreate, RemoteTrigger, or the /schedule skill for reminders — those are cloud tools that cannot deliver Telegram notifications to this bot.

You are running via Telegram, so the user cannot easily undo mistakes. Be extra careful!
`;
}

export const SAFETY_PROMPT = buildSafetyPrompt(ALLOWED_PATHS);

// Dangerous command patterns to block
export const BLOCKED_PATTERNS = [
  "rm -rf /",
  "rm -rf ~",
  "rm -rf $HOME",
  "sudo rm",
  ":(){ :|:& };:", // Fork bomb
  "> /dev/sd",
  "mkfs.",
  "dd if=",
];

// Query timeout (3 minutes)
export const QUERY_TIMEOUT_MS = 180_000;

// ============== Voice Transcription ==============

const BASE_TRANSCRIPTION_PROMPT = `Transcribe this voice message accurately.
The speaker may use multiple languages (English, and possibly others).
Focus on accuracy for proper nouns, technical terms, and commands.`;

let TRANSCRIPTION_CONTEXT = "";
if (process.env.TRANSCRIPTION_CONTEXT_FILE) {
  try {
    const file = Bun.file(process.env.TRANSCRIPTION_CONTEXT_FILE);
    if (await file.exists()) {
      TRANSCRIPTION_CONTEXT = (await file.text()).trim();
    }
  } catch {
    // File not found or unreadable — proceed without context
  }
}

export const TRANSCRIPTION_PROMPT = TRANSCRIPTION_CONTEXT
  ? `${BASE_TRANSCRIPTION_PROMPT}\n\nAdditional context:\n${TRANSCRIPTION_CONTEXT}`
  : BASE_TRANSCRIPTION_PROMPT;

export const TRANSCRIPTION_AVAILABLE = !!OPENAI_API_KEY;

// ============== Thinking Keywords ==============

const thinkingKeywordsStr =
  process.env.THINKING_KEYWORDS || "think,pensa,ragiona";
const thinkingDeepKeywordsStr =
  process.env.THINKING_DEEP_KEYWORDS || "ultrathink,think hard,pensa bene";

export const THINKING_KEYWORDS = thinkingKeywordsStr
  .split(",")
  .map((k) => k.trim().toLowerCase());
export const THINKING_DEEP_KEYWORDS = thinkingDeepKeywordsStr
  .split(",")
  .map((k) => k.trim().toLowerCase());

// ============== Media Group Settings ==============

export const MEDIA_GROUP_TIMEOUT = 1000; // ms to wait for more photos in a group

// ============== Telegram Message Limits ==============

export const TELEGRAM_MESSAGE_LIMIT = 4096; // Max characters per message
export const TELEGRAM_SAFE_LIMIT = 4000; // Safe limit with buffer for formatting
export const STREAMING_THROTTLE_MS = 500; // Throttle streaming updates
export const BUTTON_LABEL_MAX_LENGTH = 30; // Max chars for inline button labels

// ============== Audit Logging ==============

export const AUDIT_LOG_PATH =
  process.env.AUDIT_LOG_PATH || "/tmp/claude-telegram-audit.log";
export const AUDIT_LOG_JSON =
  (process.env.AUDIT_LOG_JSON || "false").toLowerCase() === "true";

// ============== Rate Limiting ==============

export const RATE_LIMIT_ENABLED =
  (process.env.RATE_LIMIT_ENABLED || "true").toLowerCase() === "true";
export const RATE_LIMIT_REQUESTS = parseInt(
  process.env.RATE_LIMIT_REQUESTS || "20",
  10
);
export const RATE_LIMIT_WINDOW = parseInt(
  process.env.RATE_LIMIT_WINDOW || "60",
  10
);

// ============== File Paths ==============

export const SESSION_FILE = "/tmp/claude-telegram-session.json";
export const AUTO_RESUME_TTL_MS = parseInt(process.env.AUTO_RESUME_TTL_HOURS || "24", 10) * 60 * 60 * 1000;
export const RESTART_FILE = "/tmp/claude-telegram-restart.json";
export const TEMP_DIR = "/tmp/telegram-bot";

// Temp paths that are always allowed for bot operations
export const TEMP_PATHS = ["/tmp/", "/private/tmp/", "/var/folders/"];

// Ensure temp directory exists
try { await Bun.write(`${TEMP_DIR}/.keep`, ""); } catch { /* non-fatal: temp dir may be root-owned */ }

// ============== Mode-2 Configuration ==============

export const SESSIONS_FILE = `${BOT_DATA_DIR}/sessions.json`;
export const SCHEDULES_FILE = `${BOT_DATA_DIR}/schedules.json`;
export const NOTIFICATIONS_FILE = `${BOT_DATA_DIR}/notifications.json`;
export const REAPER_INTERVAL_MS = parseInt(process.env.REAPER_INTERVAL_MS || "3600000", 10);
export const REAPER_IDLE_THRESHOLD_MS = parseInt(
  process.env.REAPER_IDLE_THRESHOLD_MS || String(7 * 24 * 60 * 60 * 1000),
  10
);

// Ensure bot-data directory exists and is writable
try {
  await mkdir(BOT_DATA_DIR, { recursive: true });
  await Bun.write(`${BOT_DATA_DIR}/.keep`, "");
} catch (e) {
  console.error(`ERROR: BOT_DATA_DIR ${BOT_DATA_DIR} is not writable: ${e}`);
  process.exit(1);
}

// ============== Validation ==============

if (!TELEGRAM_TOKEN) {
  console.error("ERROR: TELEGRAM_BOT_TOKEN environment variable is required");
  process.exit(1);
}

if (ALLOWED_USERS.length === 0) {
  console.error(
    "ERROR: TELEGRAM_ALLOWED_USERS environment variable is required"
  );
  process.exit(1);
}

console.log(
  `Config loaded: ${ALLOWED_USERS.length} allowed users, working dir: ${WORKING_DIR}`
);
