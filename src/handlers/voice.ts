/**
 * Voice message handler for Claude Telegram Bot.
 *
 * Prepares a part and hands it to the turn collector; `runTurn` in src/turn does
 * everything after that. The transcript is still posted here, and the typing
 * indicator still runs for the download and transcription, because six seconds
 * of silence is what makes a voice note look like a hang.
 */

import type { Context } from "grammy";
import { unlinkSync } from "fs";
import { convKeyFromCtx } from "../conversation";
import { ALLOWED_USER, TEMP_DIR, TRANSCRIPTION_AVAILABLE } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import {
  auditLogRateLimit,
  transcribeVoice,
  startTypingIndicator,
  buildMessageContext,
} from "../utils";
import { beginArrival, endArrival, hasPending, submitPart } from "../turn/collector";

/**
 * Handle incoming voice messages.
 */
export async function handleVoice(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const voice = ctx.message?.voice;

  if (!userId || !voice || !chatId) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USER)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // 2. Check if transcription is available
  if (!TRANSCRIPTION_AVAILABLE) {
    await ctx.reply(
      "Voice transcription is not configured. Set OPENAI_API_KEY in .env"
    );
    return;
  }

  const convKey = convKeyFromCtx(ctx);

  // 3. Claim an arrival slot. Synchronous, before the first await: a voice note
  // takes seconds to transcribe, and this is what stops a text message that
  // arrived beside it from being dispatched without it.
  const seq = beginArrival(convKey);
  const typing = startTypingIndicator(ctx);

  let voicePath: string | null = null;

  try {
    // 4. Rate limit check. Skipped mid-burst — one forward of five messages is
    // one user action, not five against the bucket.
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

    // 5. Download voice file
    const file = await ctx.getFile();
    const timestamp = Date.now();
    voicePath = `${TEMP_DIR}/voice_${timestamp}.ogg`;

    const downloadRes = await fetch(
      `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`
    );
    const buffer = await downloadRes.arrayBuffer();
    await Bun.write(voicePath, buffer);

    // 6. Transcribe
    const statusMsg = await ctx.reply("🎤 Transcribing...");

    const transcript = await transcribeVoice(voicePath);
    if (!transcript) {
      await ctx.api.editMessageText(
        chatId,
        statusMsg.message_id,
        "❌ Transcription failed."
      );
      return;
    }

    // 7. Show transcript (truncate display if needed - full transcript still sent to Claude)
    const maxDisplay = 4000; // Leave room for 🎤 "" wrapper within 4096 limit
    const displayTranscript =
      transcript.length > maxDisplay
        ? transcript.slice(0, maxDisplay) + "…"
        : transcript;
    await ctx.api.editMessageText(
      chatId,
      statusMsg.message_id,
      `🎤 "${displayTranscript}"`
    );

    // 8. Hand it over — enriched with the voice notice and any forward/reply
    // provenance, audited against the raw transcript rather than the prompt.
    const enrichedMessage = buildMessageContext(ctx, { voiceTranscript: transcript });
    submitPart(ctx, convKey, {
      kind: "voice",
      seq,
      messageId: ctx.message?.message_id,
      text: enrichedMessage,
      media: [],
      audit: { kind: "VOICE", summary: transcript },
      titleSeed: transcript,
      bytes: enrichedMessage.length,
    });
  } catch (error) {
    console.error("Error processing voice:", error);
    await ctx.reply("❌ Failed to process voice message.");
  } finally {
    typing.stop();
    endArrival(convKey);

    // The .ogg was only ever needed for transcription, which is over either way,
    // so it is not handed to the turn as a cleanup path.
    if (voicePath) {
      try {
        unlinkSync(voicePath);
      } catch (error) {
        console.debug("Failed to delete voice file:", error);
      }
    }
  }
}
