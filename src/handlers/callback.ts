/**
 * Callback query handler for Claude Telegram Bot.
 *
 * Handles inline keyboard button presses (ask_user MCP integration).
 */

import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { unlinkSync } from "fs";
import { session } from "../session";
import { resolvePermissionRequest } from "./permission";
import { resolveQuestionRequest } from "./question";
import { ALLOWED_USERS } from "../config";
import { isAuthorized } from "../security";
import { handleSessions, handleRepos, handleWork, handleClose, handleMode2Callback } from "./mode2";
import { auditLog, startTypingIndicator } from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";

/**
 * Handle callback queries from inline keyboards.
 */
export async function handleCallback(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const callbackData = ctx.callbackQuery?.data;

  if (!userId || !chatId || !callbackData) {
    await ctx.answerCallbackQuery();
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.answerCallbackQuery({ text: "Unauthorized" });
    return;
  }

  // 2. Handle resume callbacks: resume:{session_id}
  if (callbackData.startsWith("resume:")) {
    await handleResumeCallback(ctx, callbackData);
    return;
  }

  // 3. Handle permission requests: permask:{request_id}:{allow|deny}
  if (callbackData.startsWith("permask:")) {
    await handlePermissionCallback(ctx, callbackData);
    return;
  }

  // 3c. Handle Mode-2 inline nav callbacks: m2:{action}
  if (callbackData.startsWith("m2:")) {
    await handleMode2Callback(ctx, callbackData.slice("m2:".length));
    return;
  }

  // Legacy menu: callbacks (kept for any in-flight keyboards)
  if (callbackData.startsWith("menu:")) {
    await handleLegacyMenuCallback(ctx, callbackData);
    return;
  }

  // 3b. Handle AskUserQuestion answers: askq:{request_id}:{option_index}
  if (callbackData.startsWith("askq:")) {
    await handleQuestionCallback(ctx, callbackData);
    return;
  }

  // 4. Parse callback data: askuser:{request_id}:{option_index}
  if (!callbackData.startsWith("askuser:")) {
    await ctx.answerCallbackQuery();
    return;
  }

  const parts = callbackData.split(":");
  if (parts.length !== 3) {
    await ctx.answerCallbackQuery({ text: "Invalid callback data" });
    return;
  }

  const requestId = parts[1]!;
  const optionIndex = parseInt(parts[2]!, 10);

  // 3. Load request file
  const requestFile = `/tmp/ask-user-${requestId}.json`;
  let requestData: {
    question: string;
    options: string[];
    status: string;
  };

  try {
    const file = Bun.file(requestFile);
    const text = await file.text();
    requestData = JSON.parse(text);
  } catch (error) {
    console.error(`Failed to load ask-user request ${requestId}:`, error);
    await ctx.answerCallbackQuery({ text: "Request expired or invalid" });
    return;
  }

  // 4. Get selected option
  if (optionIndex < 0 || optionIndex >= requestData.options.length) {
    await ctx.answerCallbackQuery({ text: "Invalid option" });
    return;
  }

  const selectedOption = requestData.options[optionIndex]!;

  // 5. Update the message to show selection
  try {
    await ctx.editMessageText(`✓ ${selectedOption}`);
  } catch (error) {
    console.debug("Failed to edit callback message:", error);
  }

  // 6. Answer the callback
  await ctx.answerCallbackQuery({
    text: `Selected: ${selectedOption.slice(0, 50)}`,
  });

  // 7. Delete request file
  try {
    unlinkSync(requestFile);
  } catch (error) {
    console.debug("Failed to delete request file:", error);
  }

  // 8. Send the choice to Claude as a message
  const message = selectedOption;

  // Interrupt any running query - button responses are always immediate
  if (session.isRunning) {
    console.log("Interrupting current query for button response");
    await session.stop();
    // Small delay to ensure clean interruption
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Start typing
  const typing = startTypingIndicator(ctx);

  // Create streaming state
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  try {
    const response = await session.sendMessageStreaming(
      message,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );

    await auditLog(userId, username, "CALLBACK", message, response);
  } catch (error) {
    console.error("Error processing callback:", error);

    for (const toolMsg of state.toolMessages) {
      try {
        await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
      } catch (error) {
        console.debug("Failed to delete tool message:", error);
      }
    }

    if (String(error).includes("abort") || String(error).includes("cancel")) {
      // Only show "Query stopped" if it was an explicit stop, not an interrupt from a new message
      const wasInterrupt = session.consumeInterruptFlag();
      if (!wasInterrupt) {
        await ctx.reply("🛑 Query stopped.");
      }
    } else {
      await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`);
    }
  } finally {
    typing.stop();
  }
}

/**
 * Handle permission requests (permask:{requestId}:{allow|deny}).
 * Does NOT stop the current session — resolves the in-flight canUseTool Promise
 * so streaming can continue after the user's decision.
 */
async function handlePermissionCallback(
  ctx: Context,
  callbackData: string
): Promise<void> {
  const parts = callbackData.split(":");
  const requestId = parts[1];
  const decision = parts[2];

  if (!requestId || (decision !== "allow" && decision !== "deny")) {
    await ctx.answerCallbackQuery({ text: "Invalid permission callback" });
    return;
  }

  const { ok, toolDisplay } = resolvePermissionRequest(requestId, decision as "allow" | "deny");

  if (!ok) {
    await ctx.answerCallbackQuery({ text: "Request expired or already resolved" });
    return;
  }

  const verdict = decision === "allow" ? "✅ Allowed" : "❌ Denied";
  const MAX_TOOL_LEN = 120;
  const toolSuffix = toolDisplay
    ? ` · ${toolDisplay.length > MAX_TOOL_LEN ? toolDisplay.slice(0, MAX_TOOL_LEN - 1) + "…" : toolDisplay}`
    : "";
  const label = `${verdict}${toolSuffix}`;

  // Remove inline keyboard buttons and update text
  try {
    await ctx.editMessageText(label, { reply_markup: new InlineKeyboard() });
  } catch (editErr) {
    console.warn("Failed to edit permission message:", editErr);
    // Fallback: try to at least remove the keyboard
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
    } catch {
      // non-critical
    }
  }

  await ctx.answerCallbackQuery({ text: verdict });

  // Send typing indicator so user knows streaming is continuing
  if (decision === "allow" && ctx.chat?.id) {
    try {
      await ctx.api.sendChatAction(ctx.chat.id, "typing");
    } catch {
      // non-critical
    }
  }
  // No session.stop() here — the streaming loop continues after the promise resolves
}

/**
 * Handle AskUserQuestion answers (askq:{requestId}:{optionIndex}).
 * Resolves the in-flight question Promise with the user's selection so Claude
 * receives the answer via deny-with-message and continues streaming.
 */
async function handleQuestionCallback(
  ctx: Context,
  callbackData: string
): Promise<void> {
  const parts = callbackData.split(":");
  if (parts.length !== 3) {
    await ctx.answerCallbackQuery({ text: "Invalid question callback" });
    return;
  }

  const requestId = parts[1]!;
  const optionIndex = parseInt(parts[2]!, 10);

  if (Number.isNaN(optionIndex)) {
    await ctx.answerCallbackQuery({ text: "Invalid option index" });
    return;
  }

  const { ok, label } = resolveQuestionRequest(requestId, optionIndex);

  if (!ok) {
    await ctx.answerCallbackQuery({
      text: "This question has already been answered or timed out",
    });
    return;
  }

  const confirmation = `✅ Answered: ${label}`;
  try {
    await ctx.editMessageText(confirmation, { reply_markup: new InlineKeyboard() });
  } catch (editErr) {
    console.warn("Failed to edit question message:", editErr);
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
    } catch {
      // non-critical
    }
  }

  await ctx.answerCallbackQuery({ text: `Selected: ${(label || "").slice(0, 50)}` });

  if (ctx.chat?.id) {
    try {
      await ctx.api.sendChatAction(ctx.chat.id, "typing");
    } catch {
      // non-critical
    }
  }
}

/**
 * Handle resume session callback (resume:{session_id}).
 */
async function handleResumeCallback(
  ctx: Context,
  callbackData: string
): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const sessionId = callbackData.replace("resume:", "");

  if (!sessionId || !userId || !chatId) {
    await ctx.answerCallbackQuery({ text: "ID sessione non valido" });
    return;
  }

  // Check if session is already active
  if (session.isActive) {
    await ctx.answerCallbackQuery({ text: "Sessione già attiva" });
    return;
  }

  // Resume the selected session
  const [success, message] = session.resumeSession(sessionId);

  if (!success) {
    await ctx.answerCallbackQuery({ text: message, show_alert: true });
    return;
  }

  // Update the original message to show selection
  try {
    await ctx.editMessageText(`✅ ${message}`);
  } catch (error) {
    console.debug("Failed to edit resume message:", error);
  }
  await ctx.answerCallbackQuery({ text: "Sessione ripresa!" });

  // Send a hidden recap prompt to Claude
  const recapPrompt =
    "Please write a very concise recap of where we are in this conversation, to refresh my memory. Max 2-3 sentences.";

  const typing = startTypingIndicator(ctx);
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  try {
    await session.sendMessageStreaming(
      recapPrompt,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );
  } catch (error) {
    console.error("Error getting recap:", error);
    // Don't show error to user - session is still resumed, recap just failed
  } finally {
    typing.stop();
  }
}

async function handleLegacyMenuCallback(ctx: Context, callbackData: string): Promise<void> {
  const action = callbackData.slice("menu:".length);
  await ctx.answerCallbackQuery();
  switch (action) {
    case "sessions": return handleSessions(ctx);
    case "repos":    return handleRepos(ctx);
    case "work":     return handleWork(ctx);
    case "close":    return handleClose(ctx);
    default:
      await ctx.reply("Unknown menu action.");
  }
}
