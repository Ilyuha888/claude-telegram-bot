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

// The bot is single-tenant per deployment: one Claude session, one vault, one
// scheduler. ALLOWED_USER gates which Telegram account can talk to it; for
// multiple humans run multiple bot deployments. The old TELEGRAM_ALLOWED_USERS
// env var (plural, comma-separated list) is rejected with a migration error
// below — its multi-value shape was misleading because the rest of the bot
// only ever served the first entry.
const _rawAllowedUser = (process.env.TELEGRAM_ALLOWED_USER || "").trim();
export const ALLOWED_USER: number = parseInt(_rawAllowedUser, 10);

// ============== Multi-Session / Forum Topics (optional) ==============

// Foundation for parallel per-conversation Claude sessions surfaced as
// Telegram forum topics (see plan). Unset ⇒ every message resolves to the
// same implicit ConversationKey per chat (src/conversation.ts), so behavior
// stays byte-for-byte identical to today's single-DM session.
export const GROUP_CHAT_ID: number | null = process.env.TELEGRAM_GROUP_CHAT_ID
  ? parseInt(process.env.TELEGRAM_GROUP_CHAT_ID, 10)
  : null;
export const SESSION_IDLE_EVICT_MINUTES = parseInt(process.env.SESSION_IDLE_EVICT_MINUTES || "120", 10);
export const TOPIC_IDLE_CLOSE_DAYS = parseInt(process.env.TOPIC_IDLE_CLOSE_DAYS || "7", 10);
export const MAX_ACTIVE_TOPICS = parseInt(process.env.MAX_ACTIVE_TOPICS || "20", 10);
// How often the topic lifecycle reaper scans (src/topic-reaper.ts). Five
// minutes rather than mode-2's hourly tick: the smallest thing it enforces is
// SESSION_IDLE_EVICT_MINUTES, and an hourly scan would round a two-hour
// eviction to somewhere between two and three. Idle only, so the scan is a
// map walk plus one topics.json read.
export const TOPIC_REAPER_INTERVAL_MS = parseInt(
  process.env.TOPIC_REAPER_INTERVAL_MS || String(5 * 60 * 1000),
  10
);

export const WORKING_DIR = process.env.CLAUDE_WORKING_DIR || HOME;
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// Mode-2 base paths — defined early so they can be included in ALLOWED_PATHS
export const REPOS_DIR = process.env.REPOS_DIR || `${HOME}/repos`;
export const BOT_DATA_DIR = process.env.BOT_DATA_DIR || `${HOME}/bot-data`;

// ============== Claude CLI Path ==============

// NOTE: the binary the SDK spawns is set by CLAUDE_CODE_PATH, read directly in
// src/session.ts and assigned to options.pathToClaudeCodeExecutable. A former
// CLAUDE_CLI_PATH export lived here and was never imported by anything, so
// setting that env var appeared to work and did nothing. Removed rather than
// wired up, because two env vars for one binary is how this drifted.
// If CLAUDE_CODE_PATH is unset the SDK falls back to its own bundled CLI
// (node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude), which is
// several versions behind — so keep it set in .env.

// ============== MCP Configuration ==============

const REPO_ROOT = dirname(import.meta.dir);

// Built-in MCP servers shipped with the bot. Always registered, regardless of
// whether mcp-config.ts exists, because the bot's permission/auto-approve and
// post-tool hooks reference these tool names directly (see src/session.ts).
const BUILTIN_MCP_SERVERS: Record<string, McpServerConfig> = {
  "ask-user": {
    command: "bun",
    args: ["run", `${REPO_ROOT}/ask_user_mcp/server.ts`],
  },
  "send-file": {
    command: "bun",
    args: ["run", `${REPO_ROOT}/send_file_mcp/server.ts`],
  },
};

let MCP_SERVERS: Record<string, McpServerConfig> = { ...BUILTIN_MCP_SERVERS };

try {
  const mcpConfigPath = resolve(REPO_ROOT, "mcp-config.ts");
  const mcpModule = await import(mcpConfigPath).catch(() => null);
  const builtinCount = Object.keys(BUILTIN_MCP_SERVERS).length;
  if (mcpModule?.MCP_SERVERS) {
    // User config merges on top of built-ins (can override by re-defining the same key).
    MCP_SERVERS = { ...MCP_SERVERS, ...mcpModule.MCP_SERVERS };
    const userCount = Object.keys(mcpModule.MCP_SERVERS).length;
    console.log(
      `Loaded ${builtinCount} built-in + ${userCount} user MCP server(s)`,
    );
  } else {
    console.log(`Loaded ${builtinCount} built-in MCP server(s) (no user mcp-config.ts)`);
  }
} catch (err) {
  console.log(
    `Loaded ${Object.keys(BUILTIN_MCP_SERVERS).length} built-in MCP server(s) (mcp-config.ts load failed: ${err})`,
  );
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

// Built-in servers that deliver output back to one specific conversation and
// therefore need to know which one (see buildMcpServers below).
const DELIVERY_MCP_SERVERS = ["ask-user", "send-file"] as const;

/**
 * Per-ClaudeSession MCP server configuration.
 *
 * ask-user and send-file write /tmp request files tagged with the chat (and
 * forum topic) they belong to. They learn that target by reading the JSON at
 * TELEGRAM_CONTEXT_FILE, which is allocated per ClaudeSession instance — so it
 * cannot live in the module-scope MCP_SERVERS template, which every session
 * would share. That shared-mutable-state shape is exactly the
 * `process.env.TELEGRAM_CHAT_ID` clobber this replaces.
 *
 * This is safe because the Agent SDK spawns a fresh `claude` CLI per query()
 * and passes it `--mcp-config <json>` built from `options.mcpServers`; the CLI
 * then spawns its own MCP children with that env. No MCP subprocess is shared
 * between two ClaudeSession instances.
 *
 * Returns a copy: the module-scope template is never mutated.
 */
export function buildMcpServers(
  contextFile: string,
): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = { ...MCP_SERVERS };
  for (const name of DELIVERY_MCP_SERVERS) {
    const entry = servers[name];
    // Skip HTTP-transport overrides from a user mcp-config.ts — they have no env.
    if (!entry || "type" in entry) continue;
    servers[name] = {
      ...entry,
      env: { ...(entry.env ?? {}), TELEGRAM_CONTEXT_FILE: contextFile },
    };
  }
  return servers;
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

7. REMINDER MECHANISM — the ONLY way to set a reminder that will be delivered via this Telegram bot is to write an entry directly to ${BOT_DATA_DIR}/schedules.json using this exact script. Use the field name \`fire_at\` for when the reminder should fire — \`last_fired\` is for cron schedules only and must stay null on one-shots.
   bun -e "
   const fs = require('fs');
   const path = '${BOT_DATA_DIR}/schedules.json';
   const data = JSON.parse(fs.readFileSync(path, 'utf8'));
   data.schedules.push({
     id: 'remind-' + crypto.randomUUID().slice(0, 8),
     cron: '',
     tz: 'Europe/Moscow',
     prompt_key: 'scribe_reminder',
     last_fired: null,
     fire_at: 'FIRE_AT_ISO',
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

// Fraction of the context window at which the bot warns.
//
// There used to be a CONTEXT_WINDOW_TOKENS = 1_000_000 constant here, claimed
// to be "empirically verified". It wasn't: the >500K figures in the logs were
// per-turn cumulative usage summed across API calls, not context occupancy, so
// the measurement bug manufactured its own justification. The real window was
// ~200K, which made this threshold unreachable — the warning could never fire.
// The window now comes from the SDK at runtime via query.getContextUsage(),
// which reports maxTokens for the model actually in use.
export const CONTEXT_WARN_THRESHOLD = 0.85;

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

// ============== Turn Batching ==============

// A burst of messages — forwarded, or just typed faster than Claude answers —
// is collected into ONE turn instead of one turn per message.
//
// TURN_BATCH_WINDOW_MS is a trailing debounce: each arriving message pushes the
// dispatch out by this much, so quick successive messages settle into a single
// turn. `0` disables burst batching entirely (a message dispatches as soon as
// nothing else is mid-preparation) and is the rollback switch — a config
// change, not a revert. Albums keep coalescing either way; see
// MEDIA_GROUP_TIMEOUT below.
export const TURN_BATCH_WINDOW_MS = parseInt(
  process.env.TURN_BATCH_WINDOW_MS || "1500",
  10
);

// Ceiling measured from the first buffered message, so a steady trickle of
// messages can't defer the answer forever. Only *requests* a flush: a download
// or transcription still in flight defers it until that message has joined.
export const TURN_BATCH_MAX_WAIT_MS = parseInt(
  process.env.TURN_BATCH_MAX_WAIT_MS || "15000",
  10
);

// Flush early rather than drop. Must comfortably exceed one album (Telegram
// caps those at 10) or every album would trip it.
export const TURN_BATCH_MAX_ITEMS = parseInt(
  process.env.TURN_BATCH_MAX_ITEMS || "25",
  10
);

// Prompt weight, dominated by base64 media. Checked before appending, so the
// cap bounds what is actually sent rather than being advisory.
export const TURN_BATCH_MAX_BYTES = parseInt(
  process.env.TURN_BATCH_MAX_BYTES || String(24 * 1024 * 1024),
  10
);

// The "📥 Collecting…" card shown while messages are being gathered.
//   always — whenever a message will actually wait (the default)
//   multi  — only when it carries information: 2+ messages, or a turn already
//            running. Use this if the card flickering on every single message
//            grates.
//   off    — never
export const TURN_BATCH_CARD = ((): "always" | "multi" | "off" => {
  const raw = (process.env.TURN_BATCH_CARD || "always").toLowerCase();
  return raw === "multi" || raw === "off" ? raw : "always";
})();

// Window FLOOR for messages that arrived as one Telegram album.
//
// Not the same kind of setting as TURN_BATCH_WINDOW_MS above, which is why it
// survives as its own constant: album coalescing is protocol handling — the
// client splits one user action into N updates and never tells the bot how many
// — whereas burst batching is a product decision. So albums must keep
// coalescing when burst batching is switched off.
export const MEDIA_GROUP_TIMEOUT = 1000;

// ============== Telegram Message Limits ==============

export const TELEGRAM_MESSAGE_LIMIT = 4096; // Max characters per message
export const TELEGRAM_SAFE_LIMIT = 4000; // Safe limit with buffer for formatting
export const STREAMING_THROTTLE_MS = 500; // Throttle streaming updates
export const BUTTON_LABEL_MAX_LENGTH = 30; // Max chars for inline button labels

// ============== Rich Messages (Bot API 10.1/10.2) ==============

// Master kill switch for the Rich Message output path (src/rich.ts). Off, the
// bot behaves exactly as it did before Rich Messages existed: plain HTML +
// sendChunkedMessages. Rollback is a config change, not a revert — set
// RICH_MESSAGES_ENABLED=false and restart.
export const RICH_MESSAGES_ENABLED =
  (process.env.RICH_MESSAGES_ENABLED || "true").toLowerCase() !== "false";

// Controls live draft streaming (sendRichMessageDraft) only. Off with the
// master switch on: stream via the existing editMessageText path, still
// finalize with sendRichMessage.
export const RICH_STREAMING_ENABLED =
  (process.env.RICH_STREAMING_ENABLED || "true").toLowerCase() !== "false";

// Documented Rich Message character ceiling. Mirrors RICH_MESSAGE_CHAR_LIMIT
// in src/rich.ts, which keeps its own copy so that module stays pure and
// config-agnostic; the enforcement lives there (exceedsRichMessageLimits).
export const RICH_MESSAGE_LIMIT = 32768;

// ============== Audit Logging ==============

export const AUDIT_LOG_PATH =
  process.env.AUDIT_LOG_PATH || `${BOT_DATA_DIR}/audit.log`;
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

// SESSION_FILE moved from /tmp to BOT_DATA_DIR so chat session history
// survives host reboots (and Docker container rebuilds, which destroy /tmp
// inside the container). Required for /resume and tryAutoResume() to keep
// working after a reboot.
export const SESSION_FILE = `${BOT_DATA_DIR}/chat-session-history.json`;
// Forum topics spawned by the bot (thread_id → chat, name, session, activity).
// Inert when TELEGRAM_GROUP_CHAT_ID is unset — nothing writes to it.
export const TOPICS_FILE = `${BOT_DATA_DIR}/topics.json`;
export const AUTO_RESUME_TTL_MS = parseInt(process.env.AUTO_RESUME_TTL_HOURS || "24", 10) * 60 * 60 * 1000;
/**
 * Auto-resume window for a conversation that lives in a forum topic, as
 * opposed to a DM.
 *
 * Deliberately two orders of magnitude larger than the DM default, because the
 * two are different objects. A DM is one rolling scratchpad, so "you probably
 * moved on" is a fair guess after a day and a stale resume is confusing. A
 * topic is a *named* thread the user opened on purpose and closes by hand —
 * continuing it next week is the entire reason forum topics exist, so expiring
 * it silently after 24h broke the feature's premise (observed: a "Daily focus"
 * topic idle 31h answered from an empty context and said so).
 *
 * The cost is real and accepted: resume cost scales with transcript length and
 * the prompt cache is 1h, so the first turn after a long gap re-reads the whole
 * transcript at full price, and a long-lived topic will eventually need
 * /compact. That trade is the user's to make, which is why this is an env var.
 *
 * Ceiling: 30 days is not arbitrary. Claude Code deletes its own transcript
 * .jsonl files after `cleanupPeriodDays` (default 30), and resume needs that
 * file. Raising this past the SDK's retention only buys session ids that fail
 * on use — see the "session_gone" branch in ClaudeSession, which turns that
 * failure into a clean fresh start instead of a red error.
 */
export const TOPIC_AUTO_RESUME_TTL_MS =
  parseInt(process.env.TOPIC_AUTO_RESUME_TTL_HOURS || "720", 10) * 60 * 60 * 1000;

/** The auto-resume window that applies to a conversation: topics get their own. */
export function autoResumeTtlMs(threadId: number | undefined): number {
  return threadId === undefined ? AUTO_RESUME_TTL_MS : TOPIC_AUTO_RESUME_TTL_MS;
}
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

// ============== Mode-2 Worktree Bootstrap ==============

function csv(envValue: string | undefined, fallback: string[]): string[] {
  if (!envValue) return fallback;
  return envValue.split(",").map((s) => s.trim()).filter(Boolean);
}

// A fresh `git worktree add` contains tracked files only. These gitignored
// paths are restored from the parent checkout so a session can actually build
// and run the project — see src/mode2/worktree-bootstrap.ts.
//
// Symlinked (large, shared): note that installing inside a worktree therefore
// mutates the parent's copy, which is the accepted trade for not duplicating
// hundreds of megabytes per session.
export const WORKTREE_LINK_PATHS = csv(process.env.WORKTREE_LINK_PATHS, [
  "node_modules",
  ".venv",
  "venv",
  "vendor",
]);

// Copied (small, may hold secrets). `.worktrees/` is gitignored so these can't
// be staged from the parent repo.
export const WORKTREE_COPY_PATHS = csv(process.env.WORKTREE_COPY_PATHS, [
  ".env",
  ".env.local",
  ".claude/settings.local.json",
]);

// Whether /menu gives each session its own worktree + branch. Isolation was
// removed in 76eefe1 because unbootstrapped worktrees were unusable; with the
// bootstrap in place it is on by default again. Set to "false" for the flat
// behaviour (spawn in the repo root, shared working tree).
export const MODE2_MENU_WORKTREE =
  (process.env.MODE2_MENU_WORKTREE || "true").toLowerCase() !== "false";

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

if (process.env.TELEGRAM_ALLOWED_USERS) {
  console.error(
    "ERROR: TELEGRAM_ALLOWED_USERS was renamed to TELEGRAM_ALLOWED_USER (singular).\n" +
    "       The bot is single-tenant per deployment — one Telegram user per .env.\n" +
    "       Update your .env:  TELEGRAM_ALLOWED_USER=<your-numeric-id>\n" +
    "       For multiple humans, run multiple bot deployments (separate token, BOT_DATA_DIR, vault)."
  );
  process.exit(1);
}

if (_rawAllowedUser.includes(",")) {
  console.error(
    "ERROR: TELEGRAM_ALLOWED_USER must be a single numeric Telegram user ID, not a list.\n" +
    `       Got: ${JSON.stringify(_rawAllowedUser)}\n` +
    "       For multiple humans, run multiple bot deployments."
  );
  process.exit(1);
}

if (!_rawAllowedUser || Number.isNaN(ALLOWED_USER)) {
  console.error(
    "ERROR: TELEGRAM_ALLOWED_USER environment variable is required (your numeric Telegram user ID)."
  );
  process.exit(1);
}

if (process.env.TELEGRAM_GROUP_CHAT_ID && Number.isNaN(GROUP_CHAT_ID)) {
  console.error(
    "ERROR: TELEGRAM_GROUP_CHAT_ID must be a numeric Telegram chat ID (a supergroup with Topics enabled).\n" +
    `       Got: ${JSON.stringify(process.env.TELEGRAM_GROUP_CHAT_ID)}`
  );
  process.exit(1);
}

console.log(
  `Config loaded: allowed user ${ALLOWED_USER}, working dir: ${WORKING_DIR}`
);
