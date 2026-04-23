/**
 * Photo message handler for Claude Telegram Bot.
 *
 * Supports single photos and media groups (albums) with 1s buffering.
 */

import type { Context } from "grammy";
import type { UserContentBlock } from "../session";
import { session } from "../session";
import { ALLOWED_USERS, TEMP_DIR } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import { auditLog, auditLogRateLimit, buildMessageContext, startTypingIndicator } from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";
import { createMediaGroupBuffer, handleProcessingError } from "./media-group";

// Create photo-specific media group buffer
const photoBuffer = createMediaGroupBuffer({
  emoji: "📷",
  itemLabel: "photo",
  itemLabelPlural: "photos",
});

/**
 * Download a photo and return the local path.
 */
async function downloadPhoto(ctx: Context): Promise<string> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) {
    throw new Error("No photo in message");
  }

  // Get the largest photo
  const file = await ctx.getFile();

  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  const photoPath = `${TEMP_DIR}/photo_${timestamp}_${random}.jpg`;

  // Download
  const response = await fetch(
    `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`
  );
  const buffer = await response.arrayBuffer();
  await Bun.write(photoPath, buffer);

  return photoPath;
}

/**
 * Process photos with Claude.
 */
async function processPhotos(
  ctx: Context,
  photoPaths: string[],
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number
): Promise<void> {
  // Mark processing started
  const stopProcessing = session.startProcessing();

  // Build content blocks
  const blocks: UserContentBlock[] = [];

  if (caption) {
    blocks.push({ type: 'text', text: caption });
  } else {
    blocks.push({ type: 'text', text: photoPaths.length === 1 ? 'User sent a photo:' : `User sent ${photoPaths.length} photos:` });
  }

  for (const photoPath of photoPaths) {
    try {
      const data = await Bun.file(photoPath).arrayBuffer();
      const base64Data = Buffer.from(data).toString('base64');
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: base64Data }
      });
    } catch (err) {
      console.error(`Failed to read photo ${photoPath}:`, err);
      blocks.push({ type: 'text', text: `[Photo unavailable: ${photoPath}]` });
    }
  }

  // Set conversation title (if new session)
  if (!session.isActive) {
    const rawTitle = caption || "[Foto]";
    const title =
      rawTitle.length > 50 ? rawTitle.slice(0, 47) + "..." : rawTitle;
    session.conversationTitle = title;
  }

  // Start typing
  const typing = startTypingIndicator(ctx);

  // Create streaming state
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  try {
    const response = await session.sendMessageStreaming(
      blocks,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );

    const auditSummary = `[Photo x${photoPaths.length}]${caption ? ` ${caption}` : ''}`;
    await auditLog(userId, username, "PHOTO", auditSummary, response);
  } catch (error) {
    await handleProcessingError(ctx, error, state.toolMessages);
  } finally {
    stopProcessing();
    typing.stop();
  }
}

/**
 * Handle incoming photo messages.
 */
export async function handlePhoto(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const mediaGroupId = ctx.message?.media_group_id;

  if (!userId || !chatId) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // 2. For single photos, show status and rate limit early
  let statusMsg: Awaited<ReturnType<typeof ctx.reply>> | null = null;
  if (!mediaGroupId) {
    console.log(`Received photo from @${username}`);
    // Rate limit
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      await auditLogRateLimit(userId, username, retryAfter!);
      await ctx.reply(
        `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
      );
      return;
    }

    // Show status immediately
    statusMsg = await ctx.reply("📷 Processing image...");
  }

  // 3. Download photo
  let photoPath: string;
  try {
    photoPath = await downloadPhoto(ctx);
  } catch (error) {
    console.error("Failed to download photo:", error);
    if (statusMsg) {
      try {
        await ctx.api.editMessageText(
          statusMsg.chat.id,
          statusMsg.message_id,
          "❌ Failed to download photo."
        );
      } catch (editError) {
        console.debug("Failed to edit status message:", editError);
        await ctx.reply("❌ Failed to download photo.");
      }
    } else {
      await ctx.reply("❌ Failed to download photo.");
    }
    return;
  }

  // 4. Single photo - process immediately
  if (!mediaGroupId && statusMsg) {
    await processPhotos(
      ctx,
      [photoPath],
      buildMessageContext(ctx, { attachments: [photoPath] }) || undefined,
      userId,
      username,
      chatId
    );

    // Clean up status message
    try {
      await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
    } catch (error) {
      console.debug("Failed to delete status message:", error);
    }
    return;
  }

  // 5. Media group - buffer with timeout
  if (!mediaGroupId) return; // TypeScript guard

  await photoBuffer.addToGroup(
    mediaGroupId,
    photoPath,
    ctx,
    userId,
    username,
    processPhotos
  );
}
