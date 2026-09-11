/**
 * Video handler for Claude Telegram Bot.
 *
 * Downloads video files and passes them to video-processing skill for transcription.
 */

import type { Context } from "grammy";
import { convKeyFromCtx } from "../conversation";
import { ALLOWED_USER, TEMP_DIR } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import {
  auditLogRateLimit,
  buildMessageContext,
  startTypingIndicator,
} from "../utils";
import { beginArrival, endArrival, hasPending, submitPart } from "../turn/collector";

// Max video size (50MB - reasonable for short clips/voice memos)
const MAX_VIDEO_SIZE = 50 * 1024 * 1024;

/**
 * Download a video and return the local path.
 */
async function downloadVideo(ctx: Context): Promise<string> {
  const video = ctx.message?.video || ctx.message?.video_note;
  if (!video) {
    throw new Error("No video in message");
  }

  const file = await ctx.getFile();
  const timestamp = Date.now();

  // Use mp4 extension for regular videos, mp4 for video notes too
  const extension = ctx.message?.video_note ? "mp4" : "mp4";
  const videoPath = `${TEMP_DIR}/video_${timestamp}.${extension}`;

  // Download
  const response = await fetch(
    `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`
  );
  const buffer = await response.arrayBuffer();
  await Bun.write(videoPath, buffer);

  return videoPath;
}

/**
 * Handle incoming video messages.
 */
export async function handleVideo(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const video = ctx.message?.video || ctx.message?.video_note;
  const caption = ctx.message?.caption;

  if (!userId || !chatId || !video) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USER)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // 2. Check file size
  if (video.file_size && video.file_size > MAX_VIDEO_SIZE) {
    await ctx.reply(
      `❌ Video too large. Maximum size is ${MAX_VIDEO_SIZE / 1024 / 1024}MB.`
    );
    return;
  }

  const convKey = convKeyFromCtx(ctx);

  // 3. Claim an arrival slot, synchronously, before the download.
  const seq = beginArrival(convKey);
  const typing = startTypingIndicator(ctx);

  try {
    // 4. Rate limit check — skipped mid-burst, see voice.ts.
    if (!hasPending(convKey)) {
      const [allowed, retryAfter] = rateLimiter.check(userId);
      if (!allowed) {
        await auditLogRateLimit(userId, username, retryAfter!);
        await ctx.reply(
          `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
        );
        return;
      }
    }

    console.log(`Received video from @${username}`);

    // 5. Download video
    const statusMsg = await ctx.reply("📹 Downloading video...");

    let videoPath: string;
    try {
      videoPath = await downloadVideo(ctx);
    } catch (error) {
      console.error("Failed to download video:", error);
      await ctx.api.editMessageText(
        chatId,
        statusMsg.message_id,
        "❌ Failed to download video."
      );
      return;
    }

    // The download status is replaced by the turn's own output, so it goes now
    // rather than after an answer that may be a whole batch away.
    try {
      await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
    } catch {
      // Ignore deletion errors
    }

    // 6. Build the prompt. Through buildMessageContext, so a video inherits the
    // provenance headers everything else gets — a forwarded clip used to arrive
    // as a bare path with no [Forwarded from …] — and so the path is advertised
    // in the same [Attachments on disk: …] block the persistence contract in
    // CLAUDE.md describes, rather than in prose only this handler wrote.
    //
    // The file is deliberately NOT listed as a cleanup path: the
    // video-processing skill reads it from disk, and temp cleanup is left to the
    // directory, exactly as before.
    const context = buildMessageContext(ctx, { attachments: [videoPath] });
    const prompt = caption
      ? context
      : `${context}\n\nPlease transcribe it for me.`;

    submitPart(ctx, convKey, {
      kind: "video",
      seq,
      messageId: ctx.message?.message_id,
      text: prompt,
      media: [],
      audit: { kind: "VIDEO", summary: caption || "[video]" },
      titleSeed: caption || "[Video]",
      bytes: prompt.length,
    });
  } catch (error) {
    console.error("Video processing error:", error);
    await ctx.reply("❌ Failed to process video.");
  } finally {
    typing.stop();
    endArrival(convKey);
  }
}
