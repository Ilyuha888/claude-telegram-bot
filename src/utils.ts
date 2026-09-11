/**
 * Utility functions for Claude Telegram Bot.
 *
 * Audit logging, voice transcription, typing indicator.
 */

import OpenAI from "openai";
import type { Chat } from "grammy/types";
import type { Context } from "grammy";
import type { AuditEvent } from "./types";
import {
  AUDIT_LOG_PATH,
  AUDIT_LOG_JSON,
  OPENAI_API_KEY,
  TRANSCRIPTION_PROMPT,
  TRANSCRIPTION_AVAILABLE,
} from "./config";
import type { DeliveryTarget } from "./conversation";
import { convKeyFromCtx, threadOpts } from "./conversation";
import { incomingRichText } from "./rich";

// ============== OpenAI Client ==============

let openaiClient: OpenAI | null = null;
if (OPENAI_API_KEY && TRANSCRIPTION_AVAILABLE) {
  openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
}

// ============== Claude Error Classification ==============

export type ClaudeErrorKind =
  | "context_limit"
  | "session_gone"
  | "cancellation"
  | "generic";

export function classifyClaudeError(error: unknown): ClaudeErrorKind {
  const s = String(error);
  if (/prompt is too long/i.test(s)) return "context_limit";
  // The transcript a session id points at is gone — Claude Code prunes its own
  // .jsonl files after `cleanupPeriodDays` (default 30). Reachable because the
  // topic auto-resume window is measured in weeks: a session saved inside the
  // window can still have had its transcript collected.
  //
  // Narrow on purpose. A false positive here KILLS A HEALTHY SESSION, so the
  // patterns have to be ones only the SDK produces — notably *not* "no such
  // session", which is tmux's wording for a missing mode-2 host and could reach
  // this classifier from an unrelated failure.
  if (/no conversation found|session id .*not found/i.test(s)) {
    return "session_gone";
  }
  if (/abort|cancel/i.test(s)) return "cancellation";
  return "generic";
}

/**
 * Is this failure worth trying again unchanged?
 *
 * Deliberately a separate predicate rather than a new `ClaudeErrorKind`: the
 * union is consumed by six handler switches that map a kind to *user-facing
 * copy*, and "the upstream API was busy" needs no copy there — a retry is the
 * whole response. Adding a variant would have meant touching all six for no
 * behavioural gain.
 *
 * Only the scheduler acts on this. An interactive handler must NOT silently
 * retry: the user is waiting and can resend, and a doubled query on a session
 * that already committed a tool call is worse than an error message.
 *
 * The list is what an upstream hiccup actually looks like coming through the
 * SDK — server-side status codes and socket failures. Kept narrow at both ends:
 * `cancellation` and `context_limit` are excluded explicitly because retrying
 * either is guaranteed waste (a stop stays stopped, an over-long prompt stays
 * over-long), and a bare /\d{3}/ or "error" match is avoided so a deterministic
 * bug never gets retried three times before being reported.
 */
export function isTransientClaudeError(error: unknown): boolean {
  const kind = classifyClaudeError(error);
  if (kind === "cancellation" || kind === "context_limit" || kind === "session_gone") {
    return false;
  }
  const s = String(error);
  return (
    /\b(429|500|502|503|504|529)\b/.test(s) ||
    /overloaded|rate.?limit|service unavailable|internal server error|bad gateway|gateway time.?out/i.test(s) ||
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network error/i.test(s)
  );
}

export function formatClaudeErrorReply(error: unknown): string {
  switch (classifyClaudeError(error)) {
    case "context_limit":
      return (
        "🗜️ That session ran out of context and has been closed.\n\n" +
        "Your next message starts a fresh one — just send it.\n" +
        "To carry the thread forward next time, run /compact before the wall; " +
        "/status shows how full the context is."
      );
    case "session_gone":
      return (
        "🗃️ The saved session for this conversation no longer exists on disk — " +
        "Claude Code cleans up old transcripts.\n\n" +
        "Cleared it. Send your message again and it starts a fresh session."
      );
    case "cancellation":
      return "🛑 Query stopped.";
    default:
      return `❌ Error: ${String(error).slice(0, 200)}`;
  }
}

// ============== Audit Logging ==============

async function writeAuditLog(event: AuditEvent): Promise<void> {
  try {
    let content: string;
    if (AUDIT_LOG_JSON) {
      content = JSON.stringify(event) + "\n";
    } else {
      // Plain text format for readability
      const lines = ["\n" + "=".repeat(60)];
      for (const [key, value] of Object.entries(event)) {
        let displayValue = value;
        if (
          (key === "content" || key === "response") &&
          String(value).length > 500
        ) {
          displayValue = String(value).slice(0, 500) + "...";
        }
        lines.push(`${key}: ${displayValue}`);
      }
      content = lines.join("\n") + "\n";
    }

    // Append to audit log file
    const fs = await import("fs/promises");
    await fs.appendFile(AUDIT_LOG_PATH, content);
  } catch (error) {
    console.error("Failed to write audit log:", error);
  }
}

export async function auditLog(
  userId: number,
  username: string,
  messageType: string,
  content: string,
  response = ""
): Promise<void> {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    event: "message",
    user_id: userId,
    username,
    message_type: messageType,
    content,
  };
  if (response) {
    event.response = response;
  }
  await writeAuditLog(event);
}

export async function auditLogAuth(
  userId: number,
  username: string,
  authorized: boolean
): Promise<void> {
  await writeAuditLog({
    timestamp: new Date().toISOString(),
    event: "auth",
    user_id: userId,
    username,
    authorized,
  });
}

export async function auditLogTool(
  userId: number,
  username: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  blocked = false,
  reason = ""
): Promise<void> {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    event: "tool_use",
    user_id: userId,
    username,
    tool_name: toolName,
    tool_input: JSON.stringify(toolInput),
    blocked,
  };
  // Recorded for approvals too: with local work auto-approved, the reason is
  // what tells an auto-approval from a keyboard tap in the log.
  if (reason) {
    event.reason = reason;
  }
  await writeAuditLog(event);
}

export async function auditLogError(
  userId: number,
  username: string,
  error: string,
  context = ""
): Promise<void> {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    event: "error",
    user_id: userId,
    username,
    error,
  };
  if (context) {
    event.context = context;
  }
  await writeAuditLog(event);
}

export async function auditLogRateLimit(
  userId: number,
  username: string,
  retryAfter: number
): Promise<void> {
  await writeAuditLog({
    timestamp: new Date().toISOString(),
    event: "rate_limit",
    user_id: userId,
    username,
    retry_after: retryAfter,
  });
}

// ============== Voice Transcription ==============

export async function transcribeVoice(
  filePath: string
): Promise<string | null> {
  if (!openaiClient) {
    console.warn("OpenAI client not available for transcription");
    return null;
  }

  try {
    const file = Bun.file(filePath);
    const transcript = await openaiClient.audio.transcriptions.create({
      model: "gpt-4o-transcribe",
      file: file,
      prompt: TRANSCRIPTION_PROMPT,
    });
    return transcript.text;
  } catch (error) {
    console.error("Transcription failed:", error);
    return null;
  }
}

// ============== Typing Indicator ==============

export interface TypingController {
  stop: () => void;
}

/**
 * Show "typing…" until stopped.
 *
 * `target` overrides the destination the same way StreamingState.target does:
 * without it the action goes to the chat/topic the update came from, with it
 * to an explicitly named chat + topic (the spawn path, where the answer is
 * being streamed somewhere other than where the button was pressed).
 */
export function startTypingIndicator(
  ctx: Context,
  target?: DeliveryTarget
): TypingController {
  let running = true;

  const loop = async () => {
    while (running) {
      try {
        if (target) {
          await ctx.api.sendChatAction(
            target.chatId,
            "typing",
            threadOpts(target.threadId)
          );
        } else {
          await ctx.replyWithChatAction("typing");
        }
      } catch (error) {
        console.debug("Typing indicator failed:", error);
      }
      await Bun.sleep(4000);
    }
  };

  // Start the loop
  loop();

  return {
    stop: () => {
      running = false;
    },
  };
}

// ============== Message Interrupt ==============

// Import the session registry lazily to avoid a circular dependency:
// session.ts imports from this file, and session-registry.ts imports session.ts.
let registryModule: {
  registry: {
    get: (key: ReturnType<typeof convKeyFromCtx>) => {
      isRunning: boolean;
      stop: () => Promise<"stopped" | "pending" | false>;
      markInterrupt: () => void;
      clearStopRequested: () => void;
    };
  };
} | null = null;

export async function checkInterrupt(text: string, ctx: Context): Promise<string> {
  if (!text || !text.startsWith("!")) {
    return text;
  }

  // Lazy import to avoid circular dependency
  if (!registryModule) {
    registryModule = await import("./session-registry");
  }
  const session = registryModule.registry.get(convKeyFromCtx(ctx));

  const strippedText = text.slice(1).trimStart();
  const normalizedInterrupt = strippedText.trim().toLowerCase();

  if (session.isRunning) {
    console.log("! prefix - interrupting current query");
    session.markInterrupt();
    await session.stop();
    await Bun.sleep(100);
    // Clear stopRequested so the new message can proceed
    session.clearStopRequested();
  }

  // Treat !stop as a pure stop alias (same behavior as /stop):
  // cancel current work and do not forward "stop" as a new prompt.
  if (normalizedInterrupt === "stop" || normalizedInterrupt === "/stop") {
    return "";
  }

  return strippedText;
}

// ============== Message Context Builder ==============

import type { MessageOrigin } from "@grammyjs/types";

function describeForwardOrigin(origin: MessageOrigin): string {
  switch (origin.type) {
    case "user": {
      const u = origin.sender_user;
      return u.username ? `@${u.username}` : u.first_name;
    }
    case "hidden_user":
      return origin.sender_user_name;
    case "chat":
      return (origin.sender_chat as { title?: string }).title ?? "chat";
    case "channel":
      return (origin.chat as { title?: string }).title ?? "channel";
  }
}

function truncateStr(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

const VOICE_TRANSCRIPT_NOTICE =
  "[Voice transcript — interpret for intent, not literal wording. Filler words, incomplete sentences, and STT errors are expected.]";

function formatFileSize(bytes: number): string {
  if (bytes <= 0) return "unknown size";
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function attachmentHintBlock(paths: string[]): string {
  if (paths.length === 0) return "";
  const lines = ["[Attachments on disk:"];
  for (const p of paths) {
    try {
      const f = Bun.file(p);
      const size = f.size;
      const mime = f.type || "application/octet-stream";
      lines.push(`  - ${p} (${mime}, ${formatFileSize(size)})`);
    } catch {
      lines.push(`  - ${p}`);
    }
  }
  lines.push("]");
  return lines.join("\n");
}

/**
 * The field names a message carries, minus the envelope every message has.
 *
 * Diagnostic only, and deliberately names-not-values: it goes to the journal, so
 * it must not spill message text, file ids or user data. Exists because "the bot
 * silently ignored my message" is unanswerable without knowing what the update
 * actually looked like, and reading the field name off a real payload beats
 * inferring it from the Bot API docs — which is how the first attempt at Rich
 * Message support shipped reading a field that wasn't there.
 */
export function describeMessageShape(msg: unknown): string {
  if (!msg || typeof msg !== "object") return String(msg);
  const envelope = new Set([
    "message_id",
    "message_thread_id",
    "from",
    "sender_chat",
    "chat",
    "date",
    "is_topic_message",
    "is_automatic_forward",
    "has_protected_content",
  ]);
  const fields = Object.keys(msg as Record<string, unknown>).filter((k) => !envelope.has(k));
  return fields.length > 0 ? fields.join(",") : "(envelope only)";
}

/**
 * The STRUCTURE of an incoming `rich_message` — its keys, and the discriminator
 * plus key set of each block. No values.
 *
 * Needed because `rich_message` demonstrably arrives without the flat `text`
 * field that `incomingRichText` was written against. That field came from a
 * summarised reading of the Bot API docs rather than from a payload, and the
 * payload disagrees — so the shape gets established here, from the wire.
 *
 * Block `type` values are printed because they are a closed enum
 * (RichBlockParagraph, RichBlockList, …), i.e. schema rather than user content;
 * everything else is reduced to key names. Capped at 8 blocks: this is a
 * diagnostic, not a dump.
 */
export function describeRichShape(msg: unknown): string {
  const rich = (msg as { rich_message?: unknown } | null | undefined)?.rich_message;
  if (!rich || typeof rich !== "object") return "(no rich_message)";

  const o = rich as Record<string, unknown>;
  const parts = [`keys=${Object.keys(o).join(",") || "(none)"}`];
  for (const flat of ["text", "markdown", "html", "caption"]) {
    if (flat in o) parts.push(`${flat}:${typeof o[flat]}/len=${String(o[flat] ?? "").length}`);
  }

  if (Array.isArray(o.blocks)) {
    const shapes = o.blocks.slice(0, 8).map((b) => {
      if (!b || typeof b !== "object") return typeof b;
      const bo = b as Record<string, unknown>;
      const type = typeof bo.type === "string" ? bo.type : "?";
      return `${type}{${Object.keys(bo).join("|")}}`;
    });
    parts.push(`blocks[${o.blocks.length}]=${shapes.join(" ")}`);
  }
  return parts.join(" ");
}

/**
 * Content-bearing message types that have no handler registered, as a
 * human-readable noun — or null for anything the bot does handle, and for
 * service messages.
 *
 * Enumerates *content* fields rather than service fields, deliberately. The
 * service-message list is long and grows with every Bot API release, so a list
 * of what to ignore would go stale into false "I can't read that" replies in
 * every topic. The content list is short and stable, and a new content type
 * appearing without a handler is precisely the case worth reporting.
 *
 * The handled ones (text, rich_message, photo, voice, audio, document, video,
 * video_note) are absent by construction — they never reach the fallback.
 */
export function unhandledContentKind(msg: unknown): string | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  const kinds: Array<[string, string]> = [
    ["animation", "GIF"],
    ["sticker", "sticker"],
    ["story", "story"],
    ["contact", "contact card"],
    ["location", "location"],
    ["venue", "venue"],
    ["poll", "poll"],
    ["dice", "dice roll"],
    ["game", "game"],
    ["paid_media", "paid media post"],
    ["invoice", "invoice"],
  ];
  for (const [field, label] of kinds) {
    if (m[field] !== undefined) return label;
  }
  return null;
}

export function buildMessageContext(
  ctx: Context,
  opts?: { voiceTranscript?: string; attachments?: string[] }
): string {
  const msg = ctx.message;
  if (!msg) return "";
  const lines: string[] = [];

  if ((msg as { forward_origin?: MessageOrigin }).forward_origin) {
    lines.push(
      `[Forwarded from ${describeForwardOrigin(
        (msg as { forward_origin: MessageOrigin }).forward_origin
      )}]`
    );
  }

  const replyTo = (
    msg as {
      reply_to_message?: {
        text?: string;
        caption?: string;
        forum_topic_created?: unknown;
      };
    }
  ).reply_to_message;
  // Every message in a forum topic reports the topic's own creation service
  // message as its reply target, so treating that as a quote stamped a bogus
  // `[Replying to: "[non-text message]"]` onto the first turn of every topic —
  // pure noise in the prompt, and it taught the model the user was quoting
  // something unreadable when they weren't.
  if (replyTo && !replyTo.forum_topic_created) {
    // rich_message.text is what makes a reply to a *long* answer work: anything
    // over 4096 chars, or with a table/headings/math, went out as a Rich
    // Message, and those carry no `text` at all.
    const src = replyTo.text ?? replyTo.caption ?? incomingRichText(replyTo);
    if (src === undefined) {
      // The placeholder is a dead end for the user — "[non-text message]" tells
      // the model nothing and tells us nothing either. Logging the field NAMES
      // of the unreadable target is how the real shape gets identified, which
      // matters because reading rich_message.text was inferred from the Bot API
      // docs and demonstrably does not cover a reply to a forwarded Rich
      // Message. Names only: this goes to the journal and must not leak content.
      console.warn(
        `[reply] unreadable reply target: fields=${describeMessageShape(replyTo)}` +
          ` rich=${describeRichShape(replyTo)}`,
      );
    }
    lines.push(`[Replying to: "${truncateStr(src ?? "[non-text message]", 500)}"]`);
  }

  if ((msg as { quote?: { text: string } }).quote) {
    const q = (msg as { quote: { text: string } }).quote;
    lines.push(`[Quoting: "${truncateStr(q.text, 500)}"]`);
  }

  // Attachment paths on disk — lets the agent Read the bytes and Write them
  // into the vault. Placed before the body so the user's own text stays last.
  if (opts?.attachments && opts.attachments.length > 0) {
    const hint = attachmentHintBlock(opts.attachments);
    if (hint) lines.push(hint);
  }

  if (opts?.voiceTranscript !== undefined) {
    lines.push(VOICE_TRANSCRIPT_NOTICE);
    lines.push(opts.voiceTranscript);
  } else {
    // Same three-way read as the reply target. The rich arm covers a *forwarded*
    // Rich Message, whose content would otherwise vanish entirely and leave the
    // turn as a bare "[Forwarded from …]" header.
    const m = msg as { text?: string; caption?: string };
    const body = m.text ?? m.caption ?? incomingRichText(msg) ?? "";
    if (body) lines.push(body);
  }

  return lines.join("\n");
}
