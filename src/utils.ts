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

// ============== OpenAI Client ==============

let openaiClient: OpenAI | null = null;
if (OPENAI_API_KEY && TRANSCRIPTION_AVAILABLE) {
  openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
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
  if (blocked && reason) {
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

export function startTypingIndicator(ctx: Context): TypingController {
  let running = true;

  const loop = async () => {
    while (running) {
      try {
        await ctx.replyWithChatAction("typing");
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

// Import session lazily to avoid circular dependency
let sessionModule: {
  session: {
    isRunning: boolean;
    stop: () => Promise<"stopped" | "pending" | false>;
    markInterrupt: () => void;
    clearStopRequested: () => void;
  };
} | null = null;

export async function checkInterrupt(text: string): Promise<string> {
  if (!text || !text.startsWith("!")) {
    return text;
  }

  // Lazy import to avoid circular dependency
  if (!sessionModule) {
    sessionModule = await import("./session");
  }

  const strippedText = text.slice(1).trimStart();
  const normalizedInterrupt = strippedText.trim().toLowerCase();

  if (sessionModule.session.isRunning) {
    console.log("! prefix - interrupting current query");
    sessionModule.session.markInterrupt();
    await sessionModule.session.stop();
    await Bun.sleep(100);
    // Clear stopRequested so the new message can proceed
    sessionModule.session.clearStopRequested();
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

export function buildMessageContext(ctx: Context, opts?: { voiceTranscript?: string }): string {
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

  if ((msg as { reply_to_message?: { text?: string; caption?: string } }).reply_to_message) {
    const r = (msg as { reply_to_message: { text?: string; caption?: string } }).reply_to_message;
    const src = r.text ?? r.caption ?? "[non-text message]";
    lines.push(`[Replying to: "${truncateStr(src, 500)}"]`);
  }

  if ((msg as { quote?: { text: string } }).quote) {
    const q = (msg as { quote: { text: string } }).quote;
    lines.push(`[Quoting: "${truncateStr(q.text, 500)}"]`);
  }

  if (opts?.voiceTranscript !== undefined) {
    lines.push(VOICE_TRANSCRIPT_NOTICE);
    lines.push(opts.voiceTranscript);
  } else {
    const body = (msg as { text?: string; caption?: string }).text ?? (msg as any).caption ?? "";
    if (body) lines.push(body);
  }

  return lines.join("\n");
}
