/**
 * Photo message handler for Claude Telegram Bot.
 *
 * One photo, one part. Albums are no longer buffered here: an album item is an
 * ordinary part that happens to carry a `media_group_id`, which the collector
 * reads as a floor on the debounce window. Telegram splitting one user action
 * into N updates is protocol handling and must keep working even with burst
 * batching switched off; grouping a burst is a product decision. Two levels of
 * buffering would stack their latencies and make the `inflight` accounting a
 * guess.
 *
 * The visible change: every photo's own caption now reaches Claude, bound to
 * that photo. The old album buffer kept one caption for the whole group and
 * silently discarded the captions of items 2..N.
 */

import type { Context } from "grammy";
import type { UserContentBlock } from "../session";
import { convKeyFromCtx } from "../conversation";
import { ALLOWED_USER, TEMP_DIR } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import {
  auditLogRateLimit,
  buildMessageContext,
  startTypingIndicator,
} from "../utils";
import { beginArrival, endArrival, hasPending, submitPart } from "../turn/collector";

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
 * Handle incoming photo messages.
 */
export async function handlePhoto(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const mediaGroupId = ctx.message?.media_group_id;
  const caption = ctx.message?.caption;

  if (!userId || !chatId) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USER)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  const convKey = convKeyFromCtx(ctx);

  // 2. Claim an arrival slot, synchronously, before the download.
  const seq = beginArrival(convKey);
  const typing = startTypingIndicator(ctx);

  // Album items don't each get a status message — they'd flicker three of them
  // for one user action. The collecting card covers that case instead.
  let statusMsg: Awaited<ReturnType<typeof ctx.reply>> | null = null;

  try {
    // 3. Rate limit. Skipped mid-burst, which is also what keeps an album from
    // being charged once per photo — the rule the old album buffer applied by
    // checking only its first item.
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

    console.log(`Received photo from @${username}`);

    if (!mediaGroupId) {
      statusMsg = await ctx.reply("📷 Processing image...");
    }

    // 4. Download
    let photoPath: string;
    try {
      photoPath = await downloadPhoto(ctx);
    } catch (error) {
      console.error("Failed to download photo:", error);
      await replaceStatus(ctx, statusMsg, "❌ Failed to download photo.");
      statusMsg = null;
      return;
    }

    // 5. Read the bytes for the vision block. The file stays on disk: the
    // attachment hint in the prompt points at it, and the persistence contract
    // in CLAUDE.md is that the agent can Read it during the turn.
    const media: UserContentBlock[] = [];
    let bytes = 0;
    try {
      const data = await Bun.file(photoPath).arrayBuffer();
      const base64Data = Buffer.from(data).toString("base64");
      bytes = base64Data.length;
      media.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: base64Data },
      });
    } catch (err) {
      console.error(`Failed to read photo ${photoPath}:`, err);
      await replaceStatus(ctx, statusMsg, "❌ Failed to read the downloaded photo.");
      statusMsg = null;
      return;
    }

    // 6. Per-photo prompt text: this photo's own caption, its own forward/reply
    // provenance, and its own path on disk.
    const text = buildMessageContext(ctx, { attachments: [photoPath] });

    submitPart(ctx, convKey, {
      kind: "photo",
      seq,
      messageId: ctx.message?.message_id,
      mediaGroupId,
      text,
      media,
      audit: { kind: "PHOTO", summary: `[Photo]${caption ? ` ${caption}` : ""}` },
      titleSeed: caption || "[Foto]",
      bytes: bytes + text.length,
    });
  } catch (error) {
    console.error("Photo processing error:", error);
    await ctx.reply("❌ Failed to process photo.");
  } finally {
    typing.stop();
    endArrival(convKey);

    // The status message has done its job the moment the part is queued; the
    // answer itself may be a whole burst away.
    if (statusMsg) {
      try {
        await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
      } catch (error) {
        console.debug("Failed to delete status message:", error);
      }
    }
  }
}

/** Turn the status message into an error, or post one if it never appeared. */
async function replaceStatus(
  ctx: Context,
  statusMsg: Awaited<ReturnType<typeof ctx.reply>> | null,
  text: string
): Promise<void> {
  if (!statusMsg) {
    await ctx.reply(text);
    return;
  }
  try {
    await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, text);
  } catch (editError) {
    console.debug("Failed to edit status message:", editError);
    await ctx.reply(text);
  }
}
