/**
 * Shared streaming callback for Claude Telegram Bot handlers.
 *
 * Provides a reusable status callback for streaming Claude responses.
 */

import { unlinkSync } from "fs";
import type { Context } from "grammy";
import type { Message } from "grammy/types";
import { InlineKeyboard, InputFile } from "grammy";
import type { StatusCallback } from "../types";
import type { DeliveryTarget } from "../conversation";
import { convKeyFromCtx, threadOpts } from "../conversation";
import { convertMarkdownToHtml, escapeHtml } from "../formatting";
import {
  TELEGRAM_MESSAGE_LIMIT,
  TELEGRAM_SAFE_LIMIT,
  STREAMING_THROTTLE_MS,
  BUTTON_LABEL_MAX_LENGTH,
  RICH_MESSAGES_ENABLED,
  RICH_STREAMING_ENABLED,
} from "../config";
import {
  shouldUseRichMessage,
  exceedsRichMessageLimits,
  splitForRichMessages,
  sendRichMessageChunk,
  RichStreamController,
} from "../rich";
import { auditLogTool } from "../utils";

/**
 * Create inline keyboard for ask_user options.
 */
export function createAskUserKeyboard(
  requestId: string,
  options: string[]
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let idx = 0; idx < options.length; idx++) {
    const option = options[idx]!;
    // Truncate long options for button display
    const display =
      option.length > BUTTON_LABEL_MAX_LENGTH
        ? option.slice(0, BUTTON_LABEL_MAX_LENGTH) + "..."
        : option;
    const callbackData = `askuser:${requestId}:${idx}`;
    keyboard.text(display, callbackData).row();
  }
  return keyboard;
}

/**
 * True when a delivery for `chatId` cannot go through `ctx.reply`.
 *
 * `ctx.reply` always sends to the chat the update came from, so it is only
 * usable while that chat *is* the destination — which is every ordinary
 * handler. When the destination chat differs (a session spawned into the forum
 * supergroup from a DM button), the raw API must be used instead. A different
 * *topic* in the same chat is fine on `ctx.reply`: the explicit
 * `message_thread_id` from `threadOpts` is spread last and overrides grammY's
 * auto-threading.
 */
function needsApiSend(ctx: Context, chatId: number): boolean {
  return ctx.chat?.id !== chatId;
}

/**
 * True when a /tmp request file belongs to the given conversation.
 *
 * Both sides are normalized to strings because the MCP servers write chat_id
 * as a string and thread_id as either a string or JSON null, and a legacy
 * request file (written before thread_id existed) has neither — that must
 * still match a conversation with no topic.
 */
function requestMatchesConversation(
  data: { chat_id?: unknown; thread_id?: unknown },
  chatId: number,
  threadId?: number
): boolean {
  if (String(data.chat_id) !== String(chatId)) return false;
  return String(data.thread_id ?? "") === String(threadId ?? "");
}

/**
 * Check for pending ask-user requests and send inline keyboards.
 */
export async function checkPendingAskUserRequests(
  ctx: Context,
  chatId: number,
  threadId?: number
): Promise<boolean> {
  const glob = new Bun.Glob("ask-user-*.json");
  let buttonsSent = false;

  for await (const filename of glob.scan({ cwd: "/tmp", absolute: false })) {
    const filepath = `/tmp/${filename}`;
    try {
      const file = Bun.file(filepath);
      const text = await file.text();
      const data = JSON.parse(text);

      // Only process pending requests for this conversation (chat + topic)
      if (data.status !== "pending") continue;
      if (!requestMatchesConversation(data, chatId, threadId)) continue;

      const question = data.question || "Please choose:";
      const options = data.options || [];
      const requestId = data.request_id || "";

      if (options.length > 0 && requestId) {
        const keyboard = createAskUserKeyboard(requestId, options);
        const opts = { reply_markup: keyboard, ...threadOpts(threadId) };
        if (needsApiSend(ctx, chatId)) {
          await ctx.api.sendMessage(chatId, `❓ ${question}`, opts);
        } else {
          await ctx.reply(`❓ ${question}`, opts);
        }
        buttonsSent = true;

        // Mark as sent
        data.status = "sent";
        await Bun.write(filepath, JSON.stringify(data));
      }
    } catch (error) {
      console.warn(`Failed to process ask-user file ${filepath}:`, error);
    }
  }

  return buttonsSent;
}

// File extensions grouped by Telegram send method
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".webm", ".mkv"]);
const PHOTO_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".flac", ".m4a"]);

/**
 * Check for pending send-file requests and deliver files via Telegram.
 *
 * Every attempt — success or failure — is audit-logged with the resolved
 * path, size, chat id, and send kind so outbound file traffic is
 * reconstructable from the audit log alone.
 */
export async function checkPendingSendFileRequests(
  ctx: Context,
  chatId: number,
  userId: number,
  username: string,
  threadId?: number
): Promise<boolean> {
  const glob = new Bun.Glob("send-file-*.json");
  let fileSent = false;

  for await (const filename of glob.scan({ cwd: "/tmp", absolute: false })) {
    const filepath = `/tmp/${filename}`;
    try {
      const file = Bun.file(filepath);
      const text = await file.text();
      const data = JSON.parse(text);

      // Only process pending requests for this conversation (chat + topic)
      if (data.status !== "pending") continue;
      if (!requestMatchesConversation(data, chatId, threadId)) continue;

      const filePath: string = data.file_path || "";
      const caption: string | undefined = data.caption || undefined;
      const sizeBytes: number =
        typeof data.size_bytes === "number" ? data.size_bytes : 0;
      const sendKind: string =
        typeof data.send_kind === "string" ? data.send_kind : "";

      if (!filePath) {
        try { unlinkSync(filepath); } catch { /* ignore */ }
        continue;
      }

      const auditInput = {
        file_path: filePath,
        size_bytes: sizeBytes,
        chat_id: chatId,
        // With forum topics a chat id no longer identifies the destination on
        // its own. Omitted (undefined ⇒ dropped by JSON.stringify) outside topics.
        thread_id: threadId,
        send_kind: sendKind,
      };

      try {
        const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
        const inputFile = new InputFile(filePath);
        const sendOpts = { caption, ...threadOpts(threadId) };

        // Same send for both routes; only the transport differs (see
        // needsApiSend). Resolved up front so the send_kind branching below
        // stays a single chain instead of being duplicated per route.
        const viaApi = needsApiSend(ctx, chatId);
        const send = {
          document: (f: InputFile, o: typeof sendOpts) =>
            viaApi ? ctx.api.sendDocument(chatId, f, o) : ctx.replyWithDocument(f, o),
          video: (f: InputFile, o: typeof sendOpts) =>
            viaApi ? ctx.api.sendVideo(chatId, f, o) : ctx.replyWithVideo(f, o),
          photo: (f: InputFile, o: typeof sendOpts) =>
            viaApi ? ctx.api.sendPhoto(chatId, f, o) : ctx.replyWithPhoto(f, o),
          audio: (f: InputFile, o: typeof sendOpts) =>
            viaApi ? ctx.api.sendAudio(chatId, f, o) : ctx.replyWithAudio(f, o),
        };

        // Route by send_kind written by the server (honours send_as_document).
        // Fall back to extension-based routing only when send_kind is absent.
        if (sendKind === "document") {
          await send.document(inputFile, sendOpts);
        } else if (sendKind === "video" || VIDEO_EXTENSIONS.has(ext)) {
          await send.video(inputFile, sendOpts);
        } else if (sendKind === "photo" || PHOTO_EXTENSIONS.has(ext)) {
          await send.photo(inputFile, sendOpts);
        } else if (sendKind === "audio" || AUDIO_EXTENSIONS.has(ext)) {
          await send.audio(inputFile, sendOpts);
        } else {
          await send.document(inputFile, sendOpts);
        }

        fileSent = true;
        auditLogTool(userId, username, "send_file:delivered", auditInput).catch(
          () => {}
        );
      } catch (sendError) {
        console.error(`Failed to send file ${filePath}:`, sendError);
        auditLogTool(
          userId,
          username,
          "send_file:failed",
          auditInput,
          true,
          String(sendError).slice(0, 200)
        ).catch(() => {});
        const failureText = `Failed to send file: ${filePath.split("/").pop() || "unknown"}`;
        if (needsApiSend(ctx, chatId)) {
          await ctx.api.sendMessage(chatId, failureText, threadOpts(threadId));
        } else {
          await ctx.reply(failureText, threadOpts(threadId));
        }
      }

      // Always clean up the request file
      try { unlinkSync(filepath); } catch { /* ignore */ }
    } catch (error) {
      console.warn(`Failed to process send-file request ${filepath}:`, error);
    }
  }

  return fileSent;
}

/**
 * Tracks state for streaming message updates.
 *
 * `target` is the explicit delivery destination. Left undefined — every
 * ordinary handler — output goes out with `ctx.reply`, which grammY threads
 * back into the topic the message came from all by itself. Set, every send is
 * forced to that chat+thread through the raw API instead: the spawn path
 * creates a topic and must stream into it, while `ctx` still points at the
 * chat the button was pressed in.
 */
export class StreamingState {
  constructor(readonly target?: DeliveryTarget) {}

  textMessages = new Map<number, Message>(); // segment_id -> telegram message
  toolMessages: Message[] = []; // ephemeral tool status messages
  lastEditTimes = new Map<number, number>(); // segment_id -> last edit time
  lastContent = new Map<number, string>(); // segment_id -> last sent content
  richControllers = new Map<number, RichStreamController>(); // segment_id -> rich draft controller
  // Segments whose draft streaming failed once and must not be retried. Without
  // this, a persistently failing draft (oversized content, flood wait) would be
  // retried on every text event, and each retry deletes the plain streamed
  // message and re-creates it — visible message churn every 500ms.
  richDraftAbandoned = new Set<number>();
}

/**
 * Send one streamed message to wherever this stream belongs.
 *
 * Without a target this is `ctx.reply` verbatim — same call, same
 * auto-threading, same failure modes as before targets existed. With one, it
 * is `api.sendMessage` at the target chat + topic, because `ctx.reply` would
 * deliver to the chat the triggering update came from.
 */
function sendStreamed(
  ctx: Context,
  state: StreamingState,
  text: string,
  other?: { parse_mode?: "HTML" }
): Promise<Message> {
  const target = state.target;
  if (!target) {
    return ctx.reply(text, other);
  }
  return ctx.api.sendMessage(target.chatId, text, {
    ...other,
    ...threadOpts(target.threadId),
  });
}

/**
 * Format content for Telegram, ensuring it fits within the message limit.
 * Truncates raw content and re-converts if HTML output exceeds the limit.
 */
function formatWithinLimit(
  content: string,
  safeLimit: number = TELEGRAM_SAFE_LIMIT
): string {
  let display =
    content.length > safeLimit ? content.slice(0, safeLimit) + "..." : content;
  let formatted = convertMarkdownToHtml(display);

  // HTML tags can inflate content beyond the limit - shrink until it fits
  if (formatted.length > TELEGRAM_MESSAGE_LIMIT) {
    const ratio = TELEGRAM_MESSAGE_LIMIT / formatted.length;
    display = content.slice(0, Math.floor(safeLimit * ratio * 0.95)) + "...";
    formatted = convertMarkdownToHtml(display);
  }

  return formatted;
}

// Conservative markdown chunk limit — HTML conversion adds tag overhead
const MARKDOWN_CHUNK_LIMIT = 3500;

/**
 * Returns the opening fence line (e.g. "```python") if text ends inside an
 * unclosed code block, or null if all fences are matched.
 */
function getUnclosedFence(text: string): string | null {
  let openFence: string | null = null;
  for (const line of text.split("\n")) {
    const m = line.match(/^```(\w*)$/);
    if (!m) continue;
    if (openFence === null) {
      openFence = `\`\`\`${m[1]}`;
    } else {
      openFence = null;
    }
  }
  return openFence;
}

/**
 * Split raw markdown at paragraph/line boundaries then convert each chunk to
 * HTML. Splitting before conversion guarantees no HTML tag can span a boundary.
 * Code fences that span a split point are closed and reopened so each chunk
 * is a self-contained markdown document.
 */
async function sendChunkedMessages(
  ctx: Context,
  state: StreamingState,
  rawContent: string,
): Promise<void> {
  const rawChunks: string[] = [];
  let remaining = rawContent;

  while (remaining.length > MARKDOWN_CHUNK_LIMIT) {
    let splitAt = remaining.lastIndexOf("\n\n", MARKDOWN_CHUNK_LIMIT);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n", MARKDOWN_CHUNK_LIMIT);
    if (splitAt <= 0) splitAt = MARKDOWN_CHUNK_LIMIT;
    rawChunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) rawChunks.push(remaining);

  // Close any code fence that spans a chunk boundary and reopen it in the next.
  const chunks: string[] = [];
  let pendingFence: string | null = null;
  for (const chunk of rawChunks) {
    const withOpener = pendingFence ? `${pendingFence}\n${chunk}` : chunk;
    const unclosed = getUnclosedFence(withOpener);
    chunks.push(unclosed !== null ? `${withOpener}\n\`\`\`` : withOpener);
    pendingFence = unclosed;
  }

  for (const chunk of chunks) {
    const formatted = convertMarkdownToHtml(chunk);
    try {
      await sendStreamed(ctx, state, formatted, { parse_mode: "HTML" });
    } catch {
      try {
        await sendStreamed(ctx, state, chunk);
      } catch (plainError) {
        console.debug("Failed to send chunk:", plainError);
      }
    }
  }
}

// ============== Rich Messages ==============

/**
 * Runtime capability cache for Rich Messages. There is no probe endpoint, so
 * support is discovered by trying:
 *   null  — untried
 *   true  — a rich call has succeeded at least once
 *   false — this server/client does not support the feature; stop trying
 *
 * Only errors that mean "the feature isn't there" set `false` (see
 * `isRichUnsupportedError`). Transient failures — network blips, flood waits,
 * a 400 from malformed markdown — fall back for that one message and leave the
 * flag alone, so a single hiccup can't disable Rich Messages for the whole
 * process lifetime.
 */
let richMessagesAvailable: boolean | null = null;

/**
 * Test seam: clears the capability cache so test cases don't leak state into
 * each other. Not called by the bot.
 */
export function __resetRichMessagesAvailableForTests(): void {
  richMessagesAvailable = null;
}

/**
 * True only for errors that mean Rich Messages aren't supported at all.
 *
 * The RICH_MESSAGE check is deliberately case-SENSITIVE: Telegram's
 * feature/error codes are SCREAMING_SNAKE constants (cf. the MESSAGE_TOO_LONG
 * check in the streaming path), whereas the lowercase `rich_message` string is
 * the *parameter name* echoed back by ordinary 400 validation errors — matching
 * that case-insensitively would poison the cache on exactly the transient
 * failures this classification exists to survive.
 */
function isRichUnsupportedError(error: unknown): boolean {
  const errorStr = String(error);
  const code = (error as { error_code?: unknown } | null)?.error_code;
  if (code === 404) return true;
  if (/method not found|unknown method|not supported/i.test(errorStr)) return true;
  // A RICH_MESSAGE_* code means the feature is absent — unless it's about the
  // content itself. Telegram's taxonomy for these is new and undocumented, so
  // exclude the limit/validation shapes explicitly: permanently disabling the
  // feature because one answer was too long is far worse than retrying a
  // genuinely unsupported call on the next message.
  if (/RICH_MESSAGE/.test(errorStr)) {
    return !/TOO_LONG|TOO_MANY|LIMIT|EXCEED|INVALID/.test(errorStr);
  }
  return false;
}

/**
 * Classify a failed rich call and log it. Poisons the capability cache only
 * for unsupported-feature errors; everything else is a one-message fallback.
 */
function noteRichFailure(method: string, error: unknown): void {
  if (isRichUnsupportedError(error)) {
    richMessagesAvailable = false;
    console.debug(
      `${method} unsupported — disabling Rich Messages for this process:`,
      error
    );
    return;
  }
  console.debug(`${method} failed, falling back for this message:`, error);
}

/**
 * Where a Rich Message for this stream has to be addressed, or null when no
 * destination can be resolved (no chat id ⇒ no rich call is possible; the raw
 * methods take an explicit chat_id).
 *
 * Unlike `ctx.reply` there is no auto-threading to inherit here, so the topic
 * is resolved explicitly — an unthreaded rich send into a forum lands in
 * General silently. Explicit target wins (the spawn path streams into a topic
 * that `ctx` knows nothing about); otherwise it is the conversation the update
 * came from, with General normalized to "no thread" exactly as everywhere else.
 */
function richDestination(
  ctx: Context,
  state: StreamingState
): { chatId: number; threadId?: number } | null {
  if (state.target) {
    return { chatId: state.target.chatId, threadId: state.target.threadId };
  }
  if (ctx.chat === undefined) return null;
  return { chatId: ctx.chat.id, threadId: convKeyFromCtx(ctx).threadId };
}

/**
 * Whether this content should go out as a Rich Message.
 *
 * There is deliberately no size ceiling here any more: oversized content is
 * split into several Rich Messages by `splitForRichMessages` at finalize time
 * rather than being demoted to the 4096-char plain chunker. The plain chunker
 * remains the fallback for a *failed* rich call, not for a large one.
 *
 * No chat-type or delivery-target gate either. `sendRichMessage` takes
 * `chat_id` (Integer|String) *and* `message_thread_id`, and both now travel
 * through `richDestination` into the controller — so a supergroup forum topic
 * is a first-class destination, not a place where the message would silently
 * land in General.
 */
function canUseRich(ctx: Context, state: StreamingState, content: string): boolean {
  if (!RICH_MESSAGES_ENABLED) return false;
  if (richMessagesAvailable === false) return false;
  if (richDestination(ctx, state) === null) return false;
  return shouldUseRichMessage(content);
}

/**
 * Whether live draft streaming may be attempted for this content.
 *
 * The private-chat guard stays, unlike the finalize path's: `sendRichMessage`
 * accepts any chat, but `sendRichMessageDraft`'s `chat_id` is documented
 * Integer-only, private chats only (see src/rich-api.d.ts, the confirmed wire
 * schema). A delivery target always points at the forum supergroup, and a
 * non-private `ctx.chat` is a group either way — both stream on the plain
 * editMessageText path and still finalize as a properly threaded Rich Message
 * at segment_end. The controller carries a threadId regardless, so this becomes
 * a one-line deletion if drafts ever gain forum support.
 */
function canUseRichDraft(ctx: Context, state: StreamingState, content: string): boolean {
  if (!RICH_MESSAGES_ENABLED || !RICH_STREAMING_ENABLED) return false;
  if (richMessagesAvailable === false) return false;
  if (state.target) return false;
  if (ctx.chat?.type !== "private") return false;
  // Same ceiling as the finalize path. Without this, content that grows past
  // 32k mid-stream keeps being pushed as a draft until the API rejects it,
  // which abandons the draft and leaves a truncated plain message flickering
  // in its place. Oversized content streams on the plain path and is chunked
  // at segment_end instead.
  if (exceedsRichMessageLimits(content)) return false;
  return shouldUseRichMessage(content);
}

/**
 * Delete the plain streamed message for a segment (if any) and forget it.
 * Same delete-then-resend pattern the chunking path already uses: leaving it
 * in place would duplicate the answer next to the Rich Message. A failed
 * delete is logged and ignored — it must never abort the send.
 */
async function dropPlainSegmentMessage(
  ctx: Context,
  state: StreamingState,
  segmentId: number
): Promise<void> {
  const msg = state.textMessages.get(segmentId);
  if (!msg) return;
  try {
    await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
  } catch (error) {
    console.debug("Failed to delete plain message before rich send:", error);
  }
  state.textMessages.delete(segmentId);
  state.lastContent.delete(segmentId);
}

/**
 * Push a throttled draft update for a segment, creating the controller on the
 * first eligible text event. Returns false when the caller should handle this
 * update on the plain streaming path instead (no chat id, draft path already
 * abandoned for this segment, or this update failed).
 *
 * Deliberately does NOT consult `isApproachingExpiry()`: drafts are refreshed
 * at least every STREAMING_THROTTLE_MS while streaming and finalized at
 * segment_end, so the ~30s ephemerality window isn't reached in practice, and
 * proactively finalizing mid-segment would re-introduce exactly the message
 * splitting this change removes. If a draft ever does expire silently,
 * segment_end's finalize still sends the complete message — nothing is lost.
 */
async function updateRichDraft(
  ctx: Context,
  state: StreamingState,
  segmentId: number,
  content: string
): Promise<boolean> {
  const dest = richDestination(ctx, state);
  if (dest === null) return false;
  if (state.richDraftAbandoned.has(segmentId)) return false;

  let controller = state.richControllers.get(segmentId);
  if (!controller) {
    // Content grew past the rich threshold mid-stream: drop the plain streamed
    // message so the draft (and the finalized Rich Message) isn't a duplicate.
    await dropPlainSegmentMessage(ctx, state, segmentId);
    controller = new RichStreamController(
      dest.chatId,
      ctx.api,
      STREAMING_THROTTLE_MS,
      dest.threadId
    );
    state.richControllers.set(segmentId, controller);
  }

  try {
    // No extra STREAMING_THROTTLE_MS gate here — the controller throttles
    // itself with the same interval, and gating twice would halve the rate.
    await controller.updateDraft(content);
    richMessagesAvailable = true;
    return true;
  } catch (error) {
    noteRichFailure("sendRichMessageDraft", error);
    state.richControllers.delete(segmentId);
    state.richDraftAbandoned.add(segmentId);
    return false;
  }
}

/**
 * Finalize a segment as a single Rich Message. Returns true when the segment
 * is fully handled — either the Rich Message went out, or the attempt failed
 * and the content was delivered by the existing chunker — and false when the
 * caller should run the unchanged plain path.
 */
async function finalizeRichSegment(
  ctx: Context,
  state: StreamingState,
  segmentId: number,
  content: string
): Promise<boolean> {
  const dest = richDestination(ctx, state);
  if (dest === null) return false;

  const existing = state.richControllers.get(segmentId);
  if (existing?.finalized) {
    // finalize() is only ever called from here and throws on a second call, so
    // this means the segment already went out as a Rich Message.
    console.debug(`Rich segment ${segmentId} already finalized — skipping`);
    return true;
  }

  await dropPlainSegmentMessage(ctx, state, segmentId);

  // One code path builds and sends the finalize call: reuse the streaming
  // controller when there is one, otherwise construct one on the spot (rich
  // streaming disabled, non-private chat, or content that only crossed the
  // rich threshold at the very end).
  let controller = existing;
  if (!controller) {
    controller = new RichStreamController(
      dest.chatId,
      ctx.api,
      STREAMING_THROTTLE_MS,
      dest.threadId
    );
    // Kept in the map so a repeated segment_end for this id hits the
    // already-finalized guard above instead of sending the answer twice.
    state.richControllers.set(segmentId, controller);
  }

  // Oversized content goes out as a run of Rich Messages rather than dropping
  // to the plain chunker: the first piece replaces the draft through the
  // controller, the continuation pieces are standalone sends. `pieces` is
  // `[content]` whenever it already fits, so the common case is unchanged.
  const pieces = splitForRichMessages(content);
  if (pieces.length > 1) {
    console.debug(
      `Rich segment ${segmentId} over the ceiling — sending as ${pieces.length} Rich Messages`
    );
  }

  let sent = 0;
  try {
    const msg = await controller.finalize(pieces[0]!);
    richMessagesAvailable = true;
    sent = 1;
    // Recorded so /stop and error paths can still find the segment's message.
    state.textMessages.set(segmentId, msg);
    state.lastContent.set(segmentId, pieces[0]!);

    for (let i = 1; i < pieces.length; i++) {
      await sendRichMessageChunk(ctx.api, dest.chatId, pieces[i]!, dest.threadId);
      sent = i + 1;
    }
    return true;
  } catch (error) {
    state.richControllers.delete(segmentId);
    noteRichFailure("sendRichMessage", error);
    // Never re-send what already landed. Nothing went out on a first-piece
    // failure, so the chunker gets the original content; on a later failure it
    // gets only the undelivered pieces, each of which already carries whatever
    // reopened fence or repeated table header it needs to stand alone.
    const undelivered = sent === 0 ? content : pieces.slice(sent).join("\n\n");
    if (undelivered.trim() !== "") {
      await sendChunkedMessages(ctx, state, undelivered);
    }
    return true;
  }
}

/**
 * Create a status callback for streaming updates.
 *
 * Where the output lands is decided by `state.target`: absent (every ordinary
 * handler) it is `ctx.reply`, which grammY threads back into the originating
 * topic on its own; present it is `api.sendMessage` at that chat + thread.
 * Edits and deletes need no routing of their own — they address the message
 * objects returned by whichever send created them.
 */
export function createStatusCallback(
  ctx: Context,
  state: StreamingState
): StatusCallback {
  return async (statusType: string, content: string, segmentId?: number) => {
    try {
      if (statusType === "thinking") {
        // Deliberately NOT wired to <tg-thinking>: thinking events arrive
        // before the text segment exists, so there's no way to know yet
        // whether that segment will take the rich path. The ephemeral message
        // below already works and is cleaned up on "done".
        // (RichStreamController.updateDraft keeps its optional thinkingContent
        // parameter for a later change; this path doesn't pass it.)
        // Show thinking inline, compact (first 500 chars)
        const preview =
          content.length > 500 ? content.slice(0, 500) + "..." : content;
        const escaped = escapeHtml(preview);
        const thinkingMsg = await sendStreamed(ctx, state, `🧠 <i>${escaped}</i>`, {
          parse_mode: "HTML",
        });
        state.toolMessages.push(thinkingMsg);
      } else if (statusType === "tool") {
        const toolMsg = await sendStreamed(ctx, state, content, { parse_mode: "HTML" });
        state.toolMessages.push(toolMsg);
      } else if (statusType === "text" && segmentId !== undefined) {
        // Live draft streaming. On failure this returns false and the update
        // falls through to the unchanged plain path below, so no update — and
        // no content — is ever lost.
        if (canUseRichDraft(ctx, state, content)) {
          const streamed = await updateRichDraft(ctx, state, segmentId, content);
          if (streamed) return;
        }

        const now = Date.now();
        const lastEdit = state.lastEditTimes.get(segmentId) || 0;

        if (!state.textMessages.has(segmentId)) {
          // New segment - create message
          const formatted = formatWithinLimit(content);
          try {
            const msg = await sendStreamed(ctx, state, formatted, { parse_mode: "HTML" });
            state.textMessages.set(segmentId, msg);
            state.lastContent.set(segmentId, formatted);
          } catch (htmlError) {
            // HTML parse failed, fall back to plain text
            console.debug("HTML reply failed, using plain text:", htmlError);
            const msg = await sendStreamed(ctx, state, formatted);
            state.textMessages.set(segmentId, msg);
            state.lastContent.set(segmentId, formatted);
          }
          state.lastEditTimes.set(segmentId, now);
        } else if (now - lastEdit > STREAMING_THROTTLE_MS) {
          // Update existing segment message (throttled)
          const msg = state.textMessages.get(segmentId)!;
          const formatted = formatWithinLimit(content);
          // Skip if content unchanged
          if (formatted === state.lastContent.get(segmentId)) {
            return;
          }
          try {
            await ctx.api.editMessageText(
              msg.chat.id,
              msg.message_id,
              formatted,
              {
                parse_mode: "HTML",
              }
            );
            state.lastContent.set(segmentId, formatted);
          } catch (error) {
            const errorStr = String(error);
            if (errorStr.includes("MESSAGE_TOO_LONG")) {
              // Skip this intermediate update - segment_end will chunk properly
              console.debug(
                "Streaming edit too long, deferring to segment_end"
              );
            } else {
              console.debug("HTML edit failed, trying plain text:", error);
              try {
                await ctx.api.editMessageText(
                  msg.chat.id,
                  msg.message_id,
                  formatted
                );
                state.lastContent.set(segmentId, formatted);
              } catch (editError) {
                console.debug("Edit message failed:", editError);
              }
            }
          }
          state.lastEditTimes.set(segmentId, now);
        }
      } else if (statusType === "segment_end" && segmentId !== undefined) {
        // Rich finalize first: one coherent document instead of chunks. Handles
        // its own fallback (chunker) on failure, so a true return means done.
        if (content && canUseRich(ctx, state, content)) {
          const sent = await finalizeRichSegment(ctx, state, segmentId, content);
          if (sent) return;
        }

        if (content && !state.textMessages.has(segmentId)) {
          // No message for this segment yet. Usually a short response that
          // never tripped the >20 char streaming guard — but it can also be a
          // large one whose plain message was dropped when rich streaming took
          // over, and which then failed the Rich Message ceiling. Chunk in that
          // case: a single reply would be rejected as too long and the answer
          // would be lost.
          const formatted = convertMarkdownToHtml(content);
          if (formatted.length > TELEGRAM_MESSAGE_LIMIT) {
            await sendChunkedMessages(ctx, state, content);
            return;
          }
          try {
            const msg = await sendStreamed(ctx, state, formatted, { parse_mode: "HTML" });
            state.textMessages.set(segmentId, msg);
            state.lastContent.set(segmentId, formatted);
          } catch {
            try {
              const msg = await sendStreamed(ctx, state, content);
              state.textMessages.set(segmentId, msg);
              state.lastContent.set(segmentId, content);
            } catch (plainError) {
              console.debug("Failed to send short response:", plainError);
            }
          }
        } else if (state.textMessages.has(segmentId) && content) {
          const msg = state.textMessages.get(segmentId)!;
          const formatted = convertMarkdownToHtml(content);

          // Skip if content unchanged
          if (formatted === state.lastContent.get(segmentId)) {
            return;
          }

          if (formatted.length <= TELEGRAM_MESSAGE_LIMIT) {
            try {
              await ctx.api.editMessageText(
                msg.chat.id,
                msg.message_id,
                formatted,
                {
                  parse_mode: "HTML",
                }
              );
            } catch (error) {
              const errorStr = String(error);
              if (errorStr.includes("MESSAGE_TOO_LONG")) {
                // HTML overhead pushed it over - delete and chunk
                try {
                  await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
                } catch (delError) {
                  console.debug("Failed to delete for chunking:", delError);
                }
                await sendChunkedMessages(ctx, state, content);
              } else {
                console.debug("Failed to edit final message:", error);
              }
            }
          } else {
            // Too long - delete and split
            try {
              await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
            } catch (error) {
              console.debug("Failed to delete message for splitting:", error);
            }
            await sendChunkedMessages(ctx, state, content);
          }
        }
      } else if (statusType === "done") {
        // Delete tool messages - text messages stay
        for (const toolMsg of state.toolMessages) {
          try {
            await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
          } catch (error) {
            console.debug("Failed to delete tool message:", error);
          }
        }
        // Drop controller references. No abort() call: every controller here
        // has either been finalized at segment_end (abort would be a no-op on
        // it) or belongs to a segment whose draft simply expires client-side —
        // the Bot API has no cancel-a-draft method.
        state.richControllers.clear();
        state.richDraftAbandoned.clear();
      }
    } catch (error) {
      console.error("Status callback error:", error);
    }
  };
}
