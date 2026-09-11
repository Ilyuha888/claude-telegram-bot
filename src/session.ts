/**
 * Session management for Claude Telegram Bot.
 *
 * ClaudeSession class manages Claude Code sessions using the Agent SDK V1.
 * V1 supports full options (cwd, mcpServers, settingSources, etc.)
 */

import {
  query,
  type Options,
  type SDKMessage,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import type { Context } from "grammy";
import {
  ALLOWED_PATHS,
  ALLOWED_USER,
  CONTEXT_WARN_THRESHOLD,
  buildMcpServers,
  SAFETY_PROMPT,
  autoResumeTtlMs,
  SESSION_FILE,
  STREAMING_THROTTLE_MS,
  TEMP_PATHS,
  THINKING_DEEP_KEYWORDS,
  THINKING_KEYWORDS,
  WORKING_DIR,
} from "./config";
import { formatToolStatus, escapeHtml } from "./formatting";
import {
  checkPendingAskUserRequests,
  checkPendingSendFileRequests,
} from "./handlers/streaming";
import {
  awaitPermission,
  createPermissionKeyboard,
  formatPermissionPrompt,
} from "./handlers/permission";
import { handleAskUserQuestion } from "./handlers/question";
import { checkAutoApprove, checkCommandSafety, isPathAllowed } from "./security";
import { auditLogTool, classifyClaudeError } from "./utils";
import type { ConversationKey } from "./conversation";
import { deliveryTargetFor, threadOpts } from "./conversation";
import { loadHistorySync, upsertSession } from "./session-store";
import * as topicsStore from "./topics-store";
import { loadRuntimeConfig, type RuntimeConfig } from "./runtime-config";
import { renderCommandsForPrompt } from "./commands-manifest";

import type {
  SavedSession,
  SessionHistory,
  StatusCallback,
  TokenUsage,
} from "./types";

/** "45m" / "7h" / "13d" — coarse on purpose, this only ever goes in a notice. */
function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

export interface ContextUsage {
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  model: string;
  categories: { name: string; tokens: number; isDeferred: boolean }[];
}

export type UserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: string; data: string } };

/**
 * Determine thinking token budget based on message keywords.
 */
function getThinkingLevel(message: string): number {
  const msgLower = message.toLowerCase();

  // Check deep thinking triggers first (more specific)
  if (THINKING_DEEP_KEYWORDS.some((k) => msgLower.includes(k))) {
    return 50000;
  }

  // Check normal thinking triggers
  if (THINKING_KEYWORDS.some((k) => msgLower.includes(k))) {
    return 10000;
  }

  // Default: no thinking
  return 0;
}

/**
 * A short factual block so the model can answer "what model are you?" from
 * context instead of guessing. Without this it confabulates — it has no other
 * way to know, and a plausible-sounding number is the natural output.
 *
 * The `[1m]` suffix is a CLI-side selector for the 1M-context variant; it is
 * stripped before the API call, so the model id proper is the bare form.
 */
function buildIdentityBlock(requestedModel: string): string {
  const bare = requestedModel.replace(/\[1m\]$/i, "");
  const oneM = /\[1m\]$/i.test(requestedModel);
  return `
ABOUT THIS SESSION:
- You are running as a Telegram personal assistant via the Claude Agent SDK.
- Model requested for this session: ${bare}${oneM ? " with the 1M-token context window enabled" : ""}.
- If asked which model you are or how large your context is, answer from this block. Do not guess, and do not claim you cannot introspect it. If you need live numbers, the user can run /status, which reports the resolved model and current context usage.
${renderCommandsForPrompt()}`;
}

/**
 * Extract text content from SDK message.
 */
function getTextFromMessage(msg: SDKMessage): string | null {
  if (msg.type !== "assistant") return null;

  const textParts: string[] = [];
  for (const block of msg.message.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    }
  }
  return textParts.length > 0 ? textParts.join("") : null;
}

/**
 * Does a saved session belong to `key`? Three cases, in the order they matter:
 *
 * 1. **No key** — the caller has no conversation dimension to filter on (a
 *    ClaudeSession built outside the registry, or an explicit by-id lookup).
 *    Everything matches, which is the pre-topics behaviour.
 * 2. **Legacy entry** (neither `chat_id` nor `thread_id`, i.e. written before
 *    this field pair existed). It can only have come from the one DM
 *    conversation the bot used to have, so it matches exactly that: no topic,
 *    and the DM chat — whose id, for a Telegram private chat, is the user's own
 *    id, i.e. ALLOWED_USER. Matching legacy entries more loosely is what would
 *    let a single pre-existing entry be inherited by every newly created topic,
 *    which is the cross-contamination this filter exists to stop.
 * 3. **Keyed entry** — chat AND thread must both agree. A missing `thread_id`
 *    means "no topic", never "any topic", so a DM entry can't match a topic key
 *    and topic A can't match topic B.
 */
export function savedSessionMatchesKey(
  s: SavedSession,
  key: ConversationKey | undefined
): boolean {
  if (!key) return true;
  // null and undefined are treated alike throughout. JSON.stringify drops
  // undefined so normal operation never writes a null, but a hand-edited file
  // with `"thread_id": null` would otherwise fail the legacy test (null is not
  // undefined) AND fail the keyed test, leaving the entry matchable by nothing.
  const chatId = s.chat_id ?? undefined;
  const threadId = s.thread_id ?? undefined;
  if (chatId === undefined && threadId === undefined) {
    return key.threadId === undefined && key.chatId === ALLOWED_USER;
  }
  return chatId === key.chatId && threadId === key.threadId;
}

/**
 * Manages Claude Code sessions using the Agent SDK V1.
 */

export class ClaudeSession {
  sessionId: string | null = null;
  lastActivity: Date | null = null;
  queryStarted: Date | null = null;
  currentTool: string | null = null;
  lastTool: string | null = null;
  lastError: string | null = null;
  lastErrorTime: Date | null = null;
  lastUsage: TokenUsage | null = null;
  lastMessage: string | null = null;
  conversationTitle: string | null = null;
  /** Summary from /compact, prepended to the next user message in a fresh session. */
  pendingHandoff: string | null = null;
  /** Tracks whether the 85% context warning has been emitted for the current session. */
  contextWarningSent = false;
  /** Model/window as reported by the SDK init event — the truth, not what we asked for. */
  resolvedModel: string | null = null;
  claudeCodeVersion: string | null = null;
  /**
   * Context occupancy snapshot from the most recent turn.
   *
   * Cached rather than fetched on demand: getContextUsage() talks to the CLI
   * subprocess over a control channel that is already closing by the time the
   * result event fires ("Query closed before response received"), and is gone
   * entirely once /status runs ("ProcessTransport is not ready for writing").
   * So it has to be captured mid-stream and kept.
   */
  lastContextUsage: ContextUsage | null = null;
  lastContextUsageAt: Date | null = null;
  private _pendingAutoResumeNotice: string | null = null;
  private _justCleared = false;
  /** Config snapshot for the current session; re-read whenever a session starts. */
  private _runtimeConfig: RuntimeConfig | null = null;
  /** Live query handle, exposed so /status can call getContextUsage(). */
  private _queryInstance: import("@anthropic-ai/claude-agent-sdk").Query | null = null;

  private abortController: AbortController | null = null;
  private isQueryRunning = false;
  private stopRequested = false;
  private _isProcessing = false;
  private _wasInterruptedByNewMessage = false;
  /** Set when the last SDK result event reported a non-success subtype or is_error.
   * Persisted into SavedSession so the auto-resume picker can skip it on next boot. */
  private _lastResultErrored = false;

  private readonly persist: boolean;

  /**
   * The conversation this instance serves, or undefined for an instance that
   * belongs to none (the scheduler's ephemeral session).
   *
   * Set once at construction and never reassigned: `saveSession` stamps it onto
   * every history entry and `tryAutoResume` filters by it, so an instance that
   * could re-home itself mid-life would write entries under one key and resume
   * them under another. The registry supplies it — `registry.get(key)` already
   * knows the key it is creating the instance for.
   */
  readonly convKey: ConversationKey | undefined;

  /**
   * Where this instance publishes its Telegram delivery target for the
   * ask-user / send-file MCP subprocesses. One path per session instance —
   * NOT per query, and not a shared global — because the path is baked into
   * this instance's MCP server env (see buildMcpServers) and every instance
   * maps to exactly one conversation. Two parallel sessions therefore write
   * and read two different files and cannot clobber each other, which is what
   * `process.env.TELEGRAM_CHAT_ID` alone could not guarantee.
   */
  private readonly _contextFile: string;

  constructor(opts?: { persist?: boolean; key?: ConversationKey }) {
    this.persist = opts?.persist ?? true;
    this.convKey = opts?.key;
    this._contextFile = `/tmp/telegram-bot-ctx-${crypto.randomUUID().slice(0, 8)}.json`;
  }

  /**
   * Publish `{ chat_id, thread_id }` for this instance's MCP subprocesses.
   * Never throws — a failed write just means the servers fall back to the
   * process-global TELEGRAM_CHAT_ID, i.e. the pre-existing behaviour.
   */
  private async writeContextFile(chatId: number, threadId?: number): Promise<void> {
    try {
      await Bun.write(
        this._contextFile,
        JSON.stringify({ chat_id: chatId, thread_id: threadId ?? null }),
      );
    } catch (e) {
      console.warn(`Failed to write MCP context file ${this._contextFile}: ${e}`);
    }
  }

  /**
   * Record a turn against this conversation's forum topic.
   *
   * The single choke point for `topics.json`'s `last_active_at`, which until now
   * was written once at spawn and never again — so every idle timer built on it
   * measured "time since the topic was created". Putting it here rather than in
   * the ten handlers is what makes it total: text, voice, photo, document,
   * audio, video, media groups, the /compact summarisation turn, the priming
   * turn of a spawn and the notification buttons all reach Claude through
   * `sendMessageStreaming` and nothing else.
   *
   * Silent for a conversation with no topic (a DM or General: `threadId`
   * undefined) and for the scheduler's ephemeral session, which is constructed
   * without a key at all. Fire-and-forget, and never rethrows: a failed store
   * write must cost the user a stale timer, not their message.
   */
  private noteTopicActivity(): void {
    const threadId = this.convKey?.threadId;
    if (threadId === undefined) return;
    topicsStore.touch(threadId).catch((e) => {
      console.warn(`[topics] failed to touch thread ${threadId}: ${e}`);
    });
  }

  /**
   * Record which SDK session this topic is currently on.
   *
   * Called the moment a session id is captured, i.e. on the first turn of every
   * session — including the second one a `/new` inside the topic starts. That
   * is the fix for a stale `topics.json`: the file used to keep whatever id the
   * spawn produced, so after a /new the boot-resume path had an id pointing at
   * an abandoned conversation.
   */
  private noteTopicSession(): void {
    const threadId = this.convKey?.threadId;
    const sessionId = this.sessionId;
    if (threadId === undefined || !sessionId) return;
    topicsStore.setSessionId(threadId, sessionId).catch((e) => {
      console.warn(`[topics] failed to record session for thread ${threadId}: ${e}`);
    });
  }

  get isActive(): boolean {
    return this.sessionId !== null;
  }

  get isRunning(): boolean {
    return this.isQueryRunning || this._isProcessing;
  }

  /**
   * Check if the last stop was triggered by a new message interrupt (! prefix).
   * Resets the flag when called. Also clears stopRequested so new messages can proceed.
   */
  consumeInterruptFlag(): boolean {
    const was = this._wasInterruptedByNewMessage;
    this._wasInterruptedByNewMessage = false;
    if (was) {
      // Clear stopRequested so the new message can proceed
      this.stopRequested = false;
    }
    return was;
  }

  /**
   * Mark that this stop is from a new message interrupt.
   */
  markInterrupt(): void {
    this._wasInterruptedByNewMessage = true;
  }

  /**
   * Clear the stopRequested flag (used after interrupt to allow new message to proceed).
   */
  clearStopRequested(): void {
    this.stopRequested = false;
  }

  /**
   * Mark processing as started.
   * Returns a cleanup function to call when done.
   */
  startProcessing(): () => void {
    this._isProcessing = true;
    return () => {
      this._isProcessing = false;
    };
  }

  /**
   * Stop the currently running query or mark for cancellation.
   * Returns: "stopped" if query was aborted, "pending" if processing will be cancelled, false if nothing running
   */
  async stop(): Promise<"stopped" | "pending" | false> {
    // If a query is actively running, abort it
    if (this.isQueryRunning && this.abortController) {
      this.stopRequested = true;
      try {
        this.abortController.abort();
      } catch {
        // SDK abort listeners may throw AbortError synchronously
      }
      console.log("Stop requested - aborting current query");
      return "stopped";
    }

    // If processing but query not started yet
    if (this._isProcessing) {
      this.stopRequested = true;
      console.log("Stop requested - will cancel before query starts");
      return "pending";
    }

    return false;
  }


  /**
   * Auto-resume this conversation's most recent persisted session on the first
   * message after a process restart. No-op if already in an active session.
   * Guards on TTL, working_dir, and — since conversations became plural — the
   * ConversationKey the entry was saved under.
   */
  tryAutoResume(key: ConversationKey | undefined = this.convKey): void {
    if (this.sessionId !== null) return;

    // A non-persisting session must never adopt a conversation either.
    // `persist: false` only ever stopped this instance *writing* history — it
    // still read it, so the scheduler's ephemeral session (scheduler.ts) picked
    // up whatever conversation was newest on disk and ran the routine prompt
    // inside it, advancing a transcript the user was still using. Every
    // daily-focus / weekly-curator / monthly-audit / scribe-reminder fire did
    // this. An instance that cannot save is by definition not continuing
    // anything, so it starts clean.
    if (!this.persist) return;

    if (this._justCleared) { this._justCleared = false; return; }

    // Filters by WORKING_DIR, conversation, and `errored`. That last one is why
    // an errored history produces no notice below: /resume drops those entries
    // too, so there would be nothing to point the user at. (Smoke-test finding:
    // post-SDK-crash auto-resume inherited a corrupt session and returned 0/0
    // forever.)
    const sessions = this.getSessionList(key);
    if (sessions.length === 0) return;

    const latest = sessions[0]!;
    const ageMs = Date.now() - new Date(latest.saved_at).getTime();
    const ttlMs = autoResumeTtlMs(key?.threadId);
    if (ageMs > ttlMs) {
      // The failure mode this notice exists for: a topic idle past its TTL
      // answered from an empty context and left the user arguing with a bot
      // about what it remembered. Pointing at /resume is accurate — it filters
      // by conversation, working dir and `errored`, but never by age, so a
      // session declined *here* is still listed there.
      this._pendingAutoResumeNotice =
        `↺ started fresh — last session here was ${formatAge(ageMs)} old (limit ${Math.round(ttlMs / 3_600_000)}h). /resume to continue it.`;
      console.log(
        `Auto-resume declined: ${latest.session_id.slice(0, 8)}... is ${formatAge(ageMs)} old, TTL ${Math.round(ttlMs / 3_600_000)}h`,
      );
      return;
    }

    this.sessionId = latest.session_id;
    this.conversationTitle = latest.title;
    this.lastActivity = new Date();

    const ageStr = formatAge(ageMs);
    this._pendingAutoResumeNotice = `\u21a9\ufe0e resumed: "${latest.title}" (${ageStr} ago)`;
    console.log(`Auto-resumed session ${latest.session_id.slice(0, 8)}... (${ageStr} ago)`);
  }

  /**
   * Send a message to Claude with streaming updates via callback.
   *
   * @param ctx - grammY context for ask_user button display
   * @param threadId - forum topic this conversation lives in, if any. Routes
   *   ask-user / send-file deliveries back to the right topic.
   */
  async sendMessageStreaming(
    message: string | UserContentBlock[],
    username: string,
    userId: number,
    statusCallback: StatusCallback,
    chatId?: number,
    ctx?: Context,
    threadId?: number
  ): Promise<string> {
    // Delivery target for the ask-user / send-file MCP subprocesses.
    if (chatId) {
      // Authoritative: per-instance file, injected into this session's own MCP
      // server env below, so parallel conversations can't overwrite each other.
      await this.writeContextFile(chatId, threadId);
      // Fallback only: process-global and therefore last-writer-wins across
      // parallel sessions. Kept for the pre-first-query window and as defense
      // in depth for MCP servers that predate the context file.
      process.env.TELEGRAM_CHAT_ID = String(chatId);
    }

    // Mark the topic alive at the START of the turn, not the end: a turn can run
    // for minutes, and a reaper tick landing mid-turn must not read the topic as
    // idle since its previous message.
    this.noteTopicActivity();

    // Reset the per-result error flag at the start of each query so it can't
    // leak from a previous failed query into the next saveSession().
    this._lastResultErrored = false;

    // Auto-resume from disk on first message after process start
    this.tryAutoResume();
    const autoResumeNotice = this._pendingAutoResumeNotice;
    this._pendingAutoResumeNotice = null;

    const isNewSession = !this.isActive;
    const thinkingText = typeof message === 'string'
      ? message
      : message.filter(b => b.type === 'text').map(b => (b as {type:'text';text:string}).text).join(' ');
    const thinkingTokens = getThinkingLevel(thinkingText);
    const thinkingLabel =
      { 0: "off", 10000: "normal", 50000: "deep" }[thinkingTokens] ||
      String(thinkingTokens);

    // Build promptInput: string for text messages, AsyncIterable<SDKUserMessage> for content blocks
    let promptInput: string | AsyncIterable<import("@anthropic-ai/claude-agent-sdk").SDKUserMessage>;

    // Consume /compact handoff: prepend the carried-over brief on the first
    // message of a fresh session, then clear it so it doesn't leak forward.
    const handoff = isNewSession && this.pendingHandoff ? this.pendingHandoff : null;
    if (handoff) {
      this.pendingHandoff = null;
    }
    const handoffPrefix = handoff
      ? `[Carried over from prior session:\n${handoff}\n---]\n\n`
      : "";

    // The date/time prefix that used to be spliced in here is gone: it was a
    // hand-patch for the environment block that a bare-string systemPrompt was
    // discarding. The claude_code preset supplies the date properly now.
    if (typeof message === 'string') {
      let messageToSend = message;
      if (isNewSession && handoffPrefix) {
        messageToSend = handoffPrefix + message;
      }
      promptInput = messageToSend;
    } else {
      let blocks: UserContentBlock[] = message;
      if (isNewSession && handoffPrefix) {
        blocks = [{ type: 'text', text: handoffPrefix }, ...blocks];
      }
      const sdkMsg = {
        type: 'user' as const,
        session_id: '',
        message: { role: 'user' as const, content: blocks as unknown as Array<{ type: string }> },
        parent_tool_use_id: null as null,
      };
      promptInput = (async function*() { yield sdkMsg as import("@anthropic-ai/claude-agent-sdk").SDKUserMessage; })();
    }

    // Where this turn's Telegram output belongs. Undefined for every ordinary
    // handler (the turn's conversation IS ctx's), set on the spawn path, where
    // ctx is a button press in another chat and ctx.reply would deliver the
    // permission / question keyboards there — out of sight of the user, who is
    // watching the new topic, until the 15-minute timeout auto-denies.
    const deliveryTarget = ctx ? deliveryTargetFor(ctx, chatId, threadId) : undefined;

    // Re-read runtime config at the start of each session so `/model` + `/new`
    // takes effect without restarting the service. Cached for the session's
    // lifetime so mid-conversation turns stay on one model.
    if (isNewSession || !this._runtimeConfig) {
      this._runtimeConfig = await loadRuntimeConfig();
    }
    const runtimeConfig = this._runtimeConfig;

    // Build SDK V1 options - supports all features
    const options: Options = {
      model: runtimeConfig.model,
      cwd: WORKING_DIR,
      settingSources: ["user", "local", "project"],
      permissionMode: "default",
      allowDangerouslySkipPermissions: false,
      // Preset + append, not a bare string. A bare string REPLACES the
      // claude_code preset, which is why the assistant had no environment
      // block and had to guess its own model and context window when asked.
      // SAFETY_PROMPT is appended whole — rule 7 (the schedules.json reminder
      // contract) is what feeds the mode-2 Notifications tab.
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: `${SAFETY_PROMPT}\n${buildIdentityBlock(runtimeConfig.model)}`,
      },
      // Rebuilt per query so this instance's context-file path travels into the
      // MCP children the SDK spawns for this query. See buildMcpServers.
      mcpServers: buildMcpServers(this._contextFile),
      maxThinkingTokens: thinkingTokens,
      additionalDirectories: ALLOWED_PATHS,
      resume: this.sessionId || undefined,
      // Always defined: a run without a Telegram context (the scheduler) used to
      // leave this undefined, so the SDK auto-denied every tool the shared
      // allowlist did not cover, compound shell commands included.
      canUseTool: async (
            toolName: string,
            input: Record<string, unknown>,
            { decisionReason, blockedPath }: { signal: AbortSignal; decisionReason?: string; blockedPath?: string; [key: string]: unknown }
          ): Promise<PermissionResult> => {
            const auditUserId = ctx?.from?.id ?? userId;
            const auditUsername = ctx?.from?.username ?? username;
            // Intercept AskUserQuestion — render options as Telegram inline keyboard,
            // deny with the user's selection as message so Claude parses it as the answer.
            if (toolName === "AskUserQuestion") {
              if (!ctx) {
                return {
                  behavior: "deny",
                  message: "No interactive chat in this run — pick a sensible default or leave the question for a chat turn",
                  interrupt: false,
                };
              }
              return handleAskUserQuestion(ctx, input, deliveryTarget);
            }
            if (checkAutoApprove(toolName, input)) {
              const autoDisplay = formatToolStatus(toolName, input);
              console.log('AUTO-APPROVED: ' + toolName + ' — ' + autoDisplay);
              auditLogTool(auditUserId, auditUsername, toolName, input, false, "auto-approved").catch(() => {});
              return { behavior: "allow", updatedInput: input };
            }
            if (!ctx) {
              auditLogTool(auditUserId, auditUsername, toolName, input, true, "needs interactive approval").catch(() => {});
              return {
                behavior: "deny",
                message: "This action needs the user's approval and this run has no interactive chat. Skip it and mention it in your reply.",
                interrupt: false,
              };
            }
            const requestId = crypto.randomUUID();
            const toolDisplay = formatToolStatus(toolName, input);
            const promptText = formatPermissionPrompt(
              escapeHtml(toolDisplay),
              decisionReason,
              blockedPath
            );
            const keyboard = createPermissionKeyboard(requestId);
            try {
              // The reply/answer side needs no routing of its own: permask:
              // callbacks resolve by requestId out of a module-level map, and
              // their edit + typing action address the message the user
              // actually tapped, wherever it was delivered.
              if (deliveryTarget) {
                await ctx.api.sendMessage(deliveryTarget.chatId, promptText, {
                  reply_markup: keyboard,
                  parse_mode: "HTML",
                  ...threadOpts(deliveryTarget.threadId),
                });
              } else {
                await ctx.reply(promptText, { reply_markup: keyboard, parse_mode: "HTML" });
              }
            } catch (err) {
              console.error("Failed to send permission keyboard:", err);
              return { behavior: "deny", message: "Could not reach Telegram to ask permission", interrupt: true };
            }
            console.log(`Permission request ${requestId} for ${toolName} — awaiting Telegram response`);
            return awaitPermission(
              requestId,
              input,
              toolDisplay,
              toolName,
              auditUserId,
              auditUsername,
            );
          },
    };

    // Add Claude Code executable path if set (required for standalone builds)
    if (process.env.CLAUDE_CODE_PATH) {
      options.pathToClaudeCodeExecutable = process.env.CLAUDE_CODE_PATH;
    }

    if (this.sessionId && !isNewSession) {
      console.log(
        `RESUMING session ${this.sessionId.slice(
          0,
          8
        )}... (thinking=${thinkingLabel})`
      );
    } else {
      console.log(`STARTING new Claude session (thinking=${thinkingLabel})`);
      this.sessionId = null;
    }

    // Check if stop was requested during processing phase
    if (this.stopRequested) {
      console.log(
        "Query cancelled before starting (stop was requested during processing)"
      );
      this.stopRequested = false;
      throw new Error("Query cancelled");
    }

    // Create abort controller for cancellation
    this.abortController = new AbortController();
    this.isQueryRunning = true;
    this.stopRequested = false;
    this.queryStarted = new Date();
    this.currentTool = null;

    // Response tracking
    const responseParts: string[] = [];
    let currentSegmentId = 0;
    let currentSegmentText = "";
    // Live preview accumulator, fed by `stream_event` text deltas. Deliberately
    // separate from currentSegmentText: that one is filled from the *complete*
    // assistant message and stays the single source of truth for segment_end
    // and the returned response, so if the two ever drift (a delta dropped, a
    // replayed message) the drift is confined to the transient preview and is
    // corrected the moment the segment finalizes. Accumulating into one shared
    // variable would instead double-count every answer.
    let streamingSegmentText = "";
    let lastTextUpdate = 0;
    let queryCompleted = false;
    let askUserTriggered = false;
    let contextCaptured = false;

    // Send auto-resume notice as a standalone message before the query
    if (autoResumeNotice && ctx) {
      try { await ctx.reply(autoResumeNotice); } catch { /* non-fatal */ }
    }

    try {
      // Use V1 query() API - supports all options including cwd, mcpServers, etc.
      const queryInstance = query({
        prompt: promptInput,
        options: {
          ...options,
          abortController: this.abortController,
          // Without this the SDK only yields *complete* assistant messages, so
          // `block.type === "text"` below carries the entire answer in one hop
          // and every "streaming" update fires once, already finished. That is
          // why the live Rich Message drafts never animated: the draft was
          // created complete. Deltas arrive as `stream_event` messages, handled
          // in the loop below.
          includePartialMessages: true,
        },
      });
      // Held on the instance so /status can call getContextUsage() mid-turn.
      this._queryInstance = queryInstance;

      // Process streaming response
      for await (const event of queryInstance) {
        // Check for abort
        if (this.stopRequested) {
          console.log("Query aborted by user");
          break;
        }

        // Capture session_id from first message
        if (!this.sessionId && event.session_id) {
          this.sessionId = event.session_id;
          console.log(`GOT session_id: ${this.sessionId!.slice(0, 8)}...`);
          this.saveSession();
          this.noteTopicSession();
        }

        // Incremental text, the thing that makes streaming actually stream.
        // Enabled by `includePartialMessages` above; each event carries one
        // delta of the message currently being generated.
        if (event.type === "stream_event") {
          // Subagent output (Task tool) streams through here too. Rendering it
          // would interleave a subagent's prose into the user-visible answer,
          // which is not what the final assistant message will contain.
          if (event.parent_tool_use_id === null) {
            const raw = event.event as {
              type?: string;
              delta?: { type?: string; text?: string };
            };
            if (
              raw.type === "content_block_delta" &&
              raw.delta?.type === "text_delta" &&
              raw.delta.text
            ) {
              streamingSegmentText += raw.delta.text;
              const now = Date.now();
              if (
                now - lastTextUpdate > STREAMING_THROTTLE_MS &&
                streamingSegmentText.length > 20
              ) {
                await statusCallback("text", streamingSegmentText, currentSegmentId);
                lastTextUpdate = now;
              }
            }
          }
        }

        // The init event is authoritative about what is actually running —
        // report that rather than echoing back the model we requested.
        if (event.type === "system" && event.subtype === "init") {
          this.resolvedModel = event.model ?? null;
          this.claudeCodeVersion =
            (event as { claude_code_version?: string }).claude_code_version ?? null;
          console.log(
            `INIT: model=${this.resolvedModel} cli=${this.claudeCodeVersion} requested=${runtimeConfig.model}`,
          );
        }

        // Compaction happened (auto or manual) — surface it instead of letting
        // the context silently halve underneath the conversation.
        if (event.type === "system" && event.subtype === "compact_boundary") {
          const meta = (event as { compact_metadata?: { trigger?: string; pre_tokens?: number; post_tokens?: number } })
            .compact_metadata;
          const pre = meta?.pre_tokens;
          const post = meta?.post_tokens;
          console.log(`COMPACTED: trigger=${meta?.trigger} ${pre} -> ${post}`);
          if (ctx) {
            const detail =
              typeof pre === "number" && typeof post === "number"
                ? ` (${pre.toLocaleString()} → ${post.toLocaleString()} tokens)`
                : "";
            const notice = `🗜️ Context ${meta?.trigger === "manual" ? "compacted" : "auto-compacted"}${detail}.`;
            try {
              // Belongs to the conversation being compacted, which is not
              // necessarily the chat ctx came from. ctx.reply is kept for the
              // ordinary case so its auto-threading is untouched.
              if (deliveryTarget) {
                await ctx.api.sendMessage(
                  deliveryTarget.chatId,
                  notice,
                  threadOpts(deliveryTarget.threadId)
                );
              } else {
                await ctx.reply(notice);
              }
            } catch {
              /* non-fatal */
            }
          }
        }

        // Handle different message types
        if (event.type === "assistant") {
          // Snapshot context occupancy on the first assistant event of the
          // turn: the prompt has been sent (so the reading is complete) and
          // the control channel is still open. Waiting until the result event
          // is too late — the query is already closing by then.
          if (!contextCaptured) {
            contextCaptured = true;
            const snap = await this.readContextUsage();
            if (snap) {
              this.lastContextUsage = snap;
              this.lastContextUsageAt = new Date();
              console.log(
                `Context: ${snap.totalTokens}/${snap.maxTokens} (${Math.round(snap.percentage)}%)`,
              );
            }
          }

          for (const block of event.message.content) {
            // Thinking blocks
            if (block.type === "thinking") {
              const thinkingText = block.thinking;
              if (thinkingText) {
                console.log(`THINKING BLOCK: ${thinkingText.slice(0, 100)}...`);
                await statusCallback("thinking", thinkingText);
              }
            }

            // Tool use blocks
            if (block.type === "tool_use") {
              const toolName = block.name;
              const toolInput = block.input as Record<string, unknown>;

              // Safety check for Bash commands
              if (toolName === "Bash") {
                const command = String(toolInput.command || "");
                const [isSafe, reason] = checkCommandSafety(command);
                if (!isSafe) {
                  console.warn(`BLOCKED: ${reason}`);
                  await statusCallback("tool", `BLOCKED: ${reason}`);
                  throw new Error(`Unsafe command blocked: ${reason}`);
                }
              }

              // Safety check for file operations
              if (["Read", "Write", "Edit"].includes(toolName)) {
                const filePath = String(toolInput.file_path || "");
                if (filePath) {
                  // Allow reads from temp paths and .claude directories
                  const isTmpRead =
                    toolName === "Read" &&
                    (TEMP_PATHS.some((p) => filePath.startsWith(p)) ||
                      filePath.includes("/.claude/"));

                  if (!isTmpRead && !isPathAllowed(filePath)) {
                    console.warn(
                      `BLOCKED: File access outside allowed paths: ${filePath}`
                    );
                    await statusCallback("tool", `Access denied: ${filePath}`);
                    throw new Error(`File access blocked: ${filePath}`);
                  }
                }
              }

              // Segment ends when tool starts
              if (currentSegmentText) {
                await statusCallback(
                  "segment_end",
                  currentSegmentText,
                  currentSegmentId
                );
                currentSegmentId++;
                currentSegmentText = "";
                // Reset with the segment, or the next segment's preview would
                // open containing this one's text and the deltas-arrived check
                // above would never re-arm.
                streamingSegmentText = "";
              }

              // Format and show tool status
              const toolDisplay = formatToolStatus(toolName, toolInput);
              this.currentTool = toolDisplay;
              this.lastTool = toolDisplay;
              console.log(`Tool: ${toolDisplay}`);

              // Don't show tool status for ask_user/send_file - they handle their own UI
              if (
                !toolName.startsWith("mcp__ask-user") &&
                !toolName.startsWith("mcp__send-file")
              ) {
                await statusCallback("tool", toolDisplay);
              }

              // Check for pending ask_user requests after ask-user MCP tool
              if (toolName.startsWith("mcp__ask-user") && ctx && chatId) {
                // Small delay to let MCP server write the file
                await new Promise((resolve) => setTimeout(resolve, 200));

                // Retry a few times in case of timing issues
                for (let attempt = 0; attempt < 3; attempt++) {
                  const buttonsSent = await checkPendingAskUserRequests(
                    ctx,
                    chatId,
                    threadId
                  );
                  if (buttonsSent) {
                    askUserTriggered = true;
                    break;
                  }
                  if (attempt < 2) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                  }
                }
              }

              // Send file to user after send-file MCP tool (fire-and-forget)
              if (toolName.startsWith("mcp__send-file") && ctx && chatId) {
                await new Promise((resolve) => setTimeout(resolve, 200));
                for (let attempt = 0; attempt < 3; attempt++) {
                  const sent = await checkPendingSendFileRequests(
                    ctx,
                    chatId,
                    userId,
                    username,
                    threadId
                  );
                  if (sent) break;
                  if (attempt < 2) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                  }
                }
                // NO break — Claude continues generating
              }
            }

            // Text content. This is the authoritative copy — the complete block
            // as the model emitted it — and remains what segment_end and the
            // return value are built from.
            if (block.type === "text") {
              responseParts.push(block.text);
              currentSegmentText += block.text;

              // Fallback preview, for when no deltas arrived for this segment
              // (a CLI or SDK that ignores includePartialMessages, or a replayed
              // message). Firing it unconditionally would push the complete text
              // as a "streaming" update immediately after the deltas had already
              // rendered it, collapsing the animation this change exists to
              // produce.
              const now = Date.now();
              if (
                streamingSegmentText === "" &&
                now - lastTextUpdate > STREAMING_THROTTLE_MS &&
                currentSegmentText.length > 20
              ) {
                await statusCallback(
                  "text",
                  currentSegmentText,
                  currentSegmentId
                );
                lastTextUpdate = now;
              }
            }
          }

          // Break out of event loop if ask_user was triggered
          if (askUserTriggered) {
            break;
          }
        }

        // Result message
        if (event.type === "result") {
          console.log("Response complete");
          queryCompleted = true;

          // Surface SDK execution errors. A "Response complete" with subtype
          // !== "success" or is_error=true (and 0/0 token usage) used to be
          // invisible — that's how we missed the SDK 0.1.76 effortLevel crash
          // for an hour during the smoke test.
          const ev = event as Record<string, unknown>;
          if (ev.subtype !== "success" || ev.is_error) {
            const errs = Array.isArray(ev.errors) ? ev.errors : [];
            const firstErr = errs.length > 0 ? String(errs[0]).slice(0, 200) : "(no errors[])";
            console.error(
              `Response error: subtype=${ev.subtype} is_error=${ev.is_error} num_turns=${ev.num_turns} first_error=${firstErr}`,
            );
            this._lastResultErrored = true;
            this.saveSession();
          } else {
            this._lastResultErrored = false;
          }

          // Final sweep: pick up any send-file requests written after the tool_use
          // event fired (the MCP server runs after the assistant event, so the early
          // poll in the tool_use handler always fires too soon).
          if (ctx && chatId) {
            await checkPendingSendFileRequests(
              ctx,
              chatId,
              userId,
              username,
              threadId
            );
          }

          // Capture usage — but only from a successful result. A failed result
          // reports 0/0, which used to wipe the counters at exactly the moment
          // the user opens /status to find out what went wrong.
          if (!this._lastResultErrored && "usage" in event && event.usage) {
            this.lastUsage = event.usage as TokenUsage;
            const u = this.lastUsage;
            console.log(
              `Usage: in=${u.input_tokens} out=${u.output_tokens} cache_read=${
                u.cache_read_input_tokens || 0
              } cache_create=${u.cache_creation_input_tokens || 0}`
            );
          }
          // Proactive context warning, measured against the snapshot taken
          // mid-stream (see above) rather than a hardcoded window.
          const usage = this.lastContextUsage;
          if (usage) {
            const ratio = usage.percentage / 100;
            if (ratio >= CONTEXT_WARN_THRESHOLD && !this.contextWarningSent && ctx) {
              this.contextWarningSent = true;
              try {
                await ctx.reply(
                  `⚠️ Context at ~${Math.round(usage.percentage)}% ` +
                  `(${usage.totalTokens.toLocaleString()}/${usage.maxTokens.toLocaleString()} tokens).\n\n` +
                  `Run /compact to carry a summary forward, or /new to start fresh.`
                );
              } catch (e) {
                console.warn(`Failed to send context warning: ${e}`);
              }
            }
          }
        }
      }

      // V1 query completes automatically when the generator ends
    } catch (error) {
      const errorStr = String(error).toLowerCase();
      const isCleanupError =
        errorStr.includes("cancel") || errorStr.includes("abort");

      if (
        isCleanupError
      ) {
        console.warn(`Query aborted: ${error}`);
      } else {
        console.error(`Error in query: ${error}`);
        this.lastError = String(error).slice(0, 100);
        this.lastErrorTime = new Date();

        // A context overflow poisons the session: every later message resumes
        // the same over-limit transcript and fails identically, so the bot
        // wedges until /new. Drop the session here — this is the one error
        // where continuing with the same session_id can never work.
        //
        // Deliberately placed in the session rather than in each handler: the
        // five message handlers all had the same gap, and the scheduler and
        // the mode-2 [New session] button reach this code without going
        // through any of them.
        const kind = classifyClaudeError(error);
        if (kind === "context_limit") {
          console.warn("Context limit hit — clearing session so the next message starts fresh");
          await this.kill();
        }

        // Same shape, different cause: the session id is valid but the
        // transcript behind it was collected by Claude Code's own cleanup, so
        // every retry with this id fails identically. Drop it here so the long
        // topic auto-resume window can't wedge a conversation — the worst case
        // becomes one explanatory message instead of a permanently broken topic.
        if (kind === "session_gone") {
          console.warn(
            `Session ${this.sessionId?.slice(0, 8)}... has no transcript on disk — clearing it`,
          );
          await this.kill();
        }

        throw error;
      }
    } finally {
      this.isQueryRunning = false;
      this.abortController = null;
      this.queryStarted = null;
      this.currentTool = null;
    }

    this.lastActivity = new Date();
    this.lastError = null;
    this.lastErrorTime = null;

    // Re-save on every successful turn so `saved_at` means "last used", not
    // "first created". It used to be written only when the session id was first
    // captured, which made the 24h auto-resume TTL count from the *start* of a
    // conversation: a session opened yesterday and used all day still expired
    // 24h after its first message. That was invisible while an in-memory
    // instance held the session id forever — nothing re-read the history. Idle
    // eviction removes that cover, so the stale timestamp would surface as a
    // long-running topic silently starting fresh on its next message.
    this.saveSession();

    // If ask_user was triggered, return early - user will respond via button
    if (askUserTriggered) {
      await statusCallback("done", "");
      return "[Waiting for user selection]";
    }

    // Emit final segment
    if (currentSegmentText) {
      await statusCallback("segment_end", currentSegmentText, currentSegmentId);
    }

    await statusCallback("done", "");

    return responseParts.join("") || "No response from Claude.";
  }

  /**
   * Current context occupancy for the live query, or null if no query is
   * active or the SDK refuses. Never throws — this feeds /status, which must
   * not fail just because a readout is unavailable.
   */
  async readContextUsage(): Promise<ContextUsage | null> {
    const q = this._queryInstance;
    if (!q?.getContextUsage) return null;
    try {
      // Bounded: the handle may belong to a finished query, and /status must
      // stay responsive rather than block on a readout that never resolves.
      const u = await Promise.race([
        q.getContextUsage(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      if (!u || typeof u.totalTokens !== "number") return null;
      return {
        totalTokens: u.totalTokens,
        maxTokens: u.maxTokens,
        percentage: u.percentage,
        model: u.model,
        categories: (u.categories ?? []).map((c) => ({
          name: c.name,
          tokens: c.tokens,
          isDeferred: c.isDeferred === true,
        })),
      };
    } catch (e) {
      console.warn(`getContextUsage failed: ${e}`);
      return null;
    }
  }

  /** The model this session asked for, before the SDK resolved it. */
  get requestedModel(): string | null {
    return this._runtimeConfig?.model ?? null;
  }

  /**
   * Kill the current session (clear session_id).
   */
  async kill(): Promise<void> {
    this.sessionId = null;
    this.lastActivity = null;
    this.conversationTitle = null;
    this._justCleared = true;
    this.stopRequested = false;
    this._lastResultErrored = false;
    this.contextWarningSent = false;
    // Drop the config snapshot so the next session re-reads it — this is what
    // makes `/model` then `/new` take effect without a service restart.
    this._runtimeConfig = null;
    this._queryInstance = null;
    this.resolvedModel = null;
    this.lastContextUsage = null;
    this.lastContextUsageAt = null;
    // A handoff brief belongs to the session that produced it; without this an
    // abandoned /compact could prepend a stale brief to an unrelated session.
    this.pendingHandoff = null;
    // Deliberately NOT unlinking _contextFile here. stop() only fires an abort
    // signal — it does not await the claude CLI subprocess exiting, and /new
    // waits a heuristic 100ms before calling kill(). An MCP tool dispatched in
    // that window would read a deleted file, fall back to the process-global
    // TELEGRAM_CHAT_ID, and under parallel sessions deliver into whichever
    // conversation wrote that env var last — the wrong chat, silently. The file
    // is a few dozen bytes in /tmp, is overwritten by the next
    // writeContextFile(), and is reclaimed on reboot. Leave it.
    console.log("Session cleared");
  }

  /**
   * Save this session to the history file for resume after restart.
   *
   * Stays sync-signature and fire-and-forget — it is called from inside the
   * streaming event loop, which must not block on disk. What changed is where
   * the work happens: the read-modify-write now runs as one serialized critical
   * section in session-store.ts, because with per-conversation sessions two
   * topics can reach this line simultaneously and the old
   * read-here-write-later pairing would drop one of their entries. The entry is
   * built here, synchronously, so it describes the session as it is at the
   * moment of the call rather than whenever the queued write gets its turn.
   */
  saveSession(): void {
    if (!this.sessionId || !this.persist) return;

    const entry: SavedSession = {
      session_id: this.sessionId,
      saved_at: new Date().toISOString(),
      working_dir: WORKING_DIR,
      title: this.conversationTitle || "Sessione senza titolo",
      errored: this._lastResultErrored || undefined,
      // Which conversation owns this session. Both undefined when this
      // instance has no key — JSON.stringify drops them, so the entry is
      // shaped exactly like a legacy one rather than claiming a conversation
      // it cannot name.
      chat_id: this.convKey?.chatId,
      thread_id: this.convKey?.threadId,
    };

    upsertSession(entry).then(
      () => console.log(`Session saved to ${SESSION_FILE}`),
      (err) => console.warn(`Failed to save session: ${err}`)
    );
  }

  /**
   * Load session history from disk (read-only; see session-store.ts).
   *
   * Kept as a method rather than inlining `loadHistorySync` at each call site
   * because the tests stub it per instance to run the real filtering logic
   * against a fixed history.
   */
  private loadSessionHistory(): SessionHistory {
    return loadHistorySync();
  }

  /**
   * Get list of saved sessions for display, newest first.
   *
   * Scoped to one conversation by default (this instance's own): a topic must
   * never be offered — or silently handed — the DM's sessions or another
   * topic's. Pass a different key to scope elsewhere.
   *
   * There is deliberately no "unfiltered" argument: passing `undefined`
   * re-selects the default, so an instance that has a key cannot be talked out
   * of it, and only an instance that never had one (the scheduler's ephemeral
   * session) sees the whole file. Callers that genuinely need a by-id lookup
   * across conversations go through `resumeSession`.
   */
  getSessionList(key: ConversationKey | undefined = this.convKey): SavedSession[] {
    const history = this.loadSessionHistory();
    // Filter to current working directory, and drop sessions whose last result
    // errored — resuming an over-limit session just reproduces the failure.
    // tryAutoResume() has always done this; /resume used to not, which meant
    // the manual recovery path handed back the very session that just died.
    return history.sessions.filter(
      (s) =>
        (!s.working_dir || s.working_dir === WORKING_DIR) &&
        !s.errored &&
        savedSessionMatchesKey(s, key)
    );
  }

  /**
   * Adopt a session id known from outside the history file — the boot
   * re-registration path, which reads `topics.json` so a topic keeps its own
   * conversation across a restart even if its history entry has been pruned.
   *
   * Returns false when the id must not be adopted: this instance already has
   * one (never clobber a live session), or the history marks that id as
   * errored (resuming it would just reproduce the failure). Setting sessionId
   * here also makes the later `tryAutoResume()` a no-op, so the two paths
   * cannot both fire for the same conversation.
   */
  adoptSession(sessionId: string, title?: string | null): boolean {
    if (this.sessionId !== null) return false;
    const entry = this.loadSessionHistory().sessions.find(
      (s) => s.session_id === sessionId
    );
    if (entry?.errored) return false;
    this.sessionId = sessionId;
    if (title) this.conversationTitle = title;
    this.lastActivity = new Date();
    return true;
  }

  /**
   * Resume a specific session by ID.
   *
   * Deliberately NOT conversation-filtered: this is an explicit by-id action,
   * and the only producer of those ids — the /resume keyboard — is itself
   * scoped to the caller's conversation (see getSessionList). Filtering here
   * too would add nothing except a way for a legacy entry to become
   * unresumable.
   */
  resumeSession(sessionId: string): [success: boolean, message: string] {
    const history = this.loadSessionHistory();
    const sessionData = history.sessions.find((s) => s.session_id === sessionId);

    if (!sessionData) {
      return [false, "Sessione non trovata"];
    }

    if (sessionData.working_dir && sessionData.working_dir !== WORKING_DIR) {
      return [
        false,
        `Sessione per directory diversa: ${sessionData.working_dir}`,
      ];
    }

    // Guard the by-id path too, not just the picker — resuming a session whose
    // last result errored (typically a context overflow) walks back into it.
    if (sessionData.errored) {
      return [
        false,
        "That session ended in an error (usually a full context) — resuming it would hit the same wall. Start a fresh one with /new.",
      ];
    }

    this.sessionId = sessionData.session_id;
    this.conversationTitle = sessionData.title;
    this.lastActivity = new Date();

    console.log(
      `Resumed session ${sessionData.session_id.slice(0, 8)}... - "${sessionData.title}"`
    );

    return [
      true,
      `Ripresa sessione: "${sessionData.title}"`,
    ];
  }

  /**
   * Resume the last persisted session (legacy method, now resumes most recent).
   */
  resumeLast(): [success: boolean, message: string] {
    const sessions = this.getSessionList();
    if (sessions.length === 0) {
      return [false, "Nessuna sessione salvata"];
    }

    return this.resumeSession(sessions[0]!.session_id);
  }
}
