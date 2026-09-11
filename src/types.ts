/**
 * Shared TypeScript types for the Claude Telegram Bot.
 */

import type { Context } from "grammy";

// Status callback for streaming updates
export type StatusCallback = (
  type: "thinking" | "tool" | "text" | "segment_end" | "done",
  content: string,
  segmentId?: number
) => Promise<void>;

// Rate limit bucket for token bucket algorithm
export interface RateLimitBucket {
  tokens: number;
  lastUpdate: number;
}

// Session persistence
export interface SavedSession {
  session_id: string;
  saved_at: string;
  working_dir: string;
  title: string; // First message truncated (max ~50 chars)
  /** True if the last SDK result event for this session was an error.
   * The auto-resume picker skips entries with errored: true. */
  errored?: boolean;
  /**
   * The conversation (ConversationKey) this session belongs to.
   *
   * Both fields optional and both absent together on entries written before
   * sessions knew about conversations — those are, by construction, the single
   * DM conversation the bot used to have. `thread_id` absent with `chat_id`
   * present means "this chat, no forum topic" (a DM or the General topic), not
   * "any topic". See `savedSessionMatchesKey` in src/session.ts for the exact
   * matching rules; nothing migrates the file, absence is handled at read time.
   */
  chat_id?: number;
  thread_id?: number;
}

export interface SessionHistory {
  sessions: SavedSession[];
}

// Token usage from Claude
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// MCP server configuration types
export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHttpConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

// Audit log event types
export type AuditEventType =
  | "message"
  | "auth"
  | "tool_use"
  | "error"
  | "rate_limit";

export interface AuditEvent {
  timestamp: string;
  event: AuditEventType;
  user_id: number;
  username?: string;
  [key: string]: unknown;
}

// Bot context with optional message
export type BotContext = Context;
