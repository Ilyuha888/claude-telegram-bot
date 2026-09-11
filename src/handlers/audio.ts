/**
 * Audio handler for Claude Telegram Bot.
 *
 * Handles native Telegram audio messages and audio files sent as documents.
 * Transcribes using OpenAI (same as voice messages), then hands the transcript
 * to the turn collector.
 */

import type { Context } from "grammy";
import { unlinkSync } from "fs";
import { convKeyFromCtx } from "../conversation";
import { ALLOWED_USER, TEMP_DIR, TRANSCRIPTION_AVAILABLE } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import {
  auditLogRateLimit,
  buildMessageContext,
  transcribeVoice,
  startTypingIndicator,
} from "../utils";
import { beginArrival, endArrival, hasPending, submitPart } from "../turn/collector";

// Supported audio file extensions
const AUDIO_EXTENSIONS = [
  ".mp3",
  ".m4a",
  ".ogg",
  ".wav",
  ".aac",
  ".flac",
  ".opus",
  ".wma",
];

/**
 * Check if a file is an audio file by extension or mime type.
 */
export function isAudioFile(fileName?: string, mimeType?: string): boolean {
  if (mimeType?.startsWith("audio/")) {
    return true;
  }
  if (fileName) {
    const ext = "." + (fileName.split(".").pop() || "").toLowerCase();
    return AUDIO_EXTENSIONS.includes(ext);
  }
  return false;
}

/**
 * Transcribe an audio file and submit it as one part of the next turn.
 *
 * The caller owns the arrival: it must have called `beginArrival` synchronously
 * at handler entry and must call `endArrival` in a `finally`, passing the seq in
 * here. Claiming it inside this function instead would register the arrival only
 * after the file had finished downloading, which is exactly the window in which
 * a sibling message can be dispatched without this one.
 *
 * `attachments` advertises the file to the agent as a path on disk. Pass it only
 * when the file should outlive transcription — it makes the file the turn's to
 * clean up rather than this function's.
 *
 * Shared by `handleAudio` and the audio-as-document path in document.ts.
 */
export async function processAudioFile(
  ctx: Context,
  filePath: string,
  chatId: number,
  seq: number,
  attachments?: string[]
): Promise<void> {
  if (!TRANSCRIPTION_AVAILABLE) {
    await ctx.reply(
      "Voice transcription is not configured. Set OPENAI_API_KEY in .env"
    );
    return;
  }

  const convKey = convKeyFromCtx(ctx);
  const typing = startTypingIndicator(ctx);

  // A file advertised on disk has to still be there when the agent goes to read
  // it, and the turn can now be a whole burst away.
  const keepForTurn = Boolean(attachments?.length);
  let submitted = false;

  try {
    // Transcribe
    const statusMsg = await ctx.reply("🎤 Transcribing audio...");

    const transcript = await transcribeVoice(filePath);
    if (!transcript) {
      await ctx.api.editMessageText(
        chatId,
        statusMsg.message_id,
        "❌ Transcription failed."
      );
      return;
    }

    // Show transcript
    const maxDisplay = 4000;
    const displayTranscript =
      transcript.length > maxDisplay
        ? transcript.slice(0, maxDisplay) + "…"
        : transcript;
    await ctx.api.editMessageText(
      chatId,
      statusMsg.message_id,
      `🎤 "${displayTranscript}"`
    );

    // Build the prompt through buildMessageContext so an audio file inherits the
    // same provenance headers every other message type gets — a forwarded voice
    // memo used to arrive as a bare transcript with no [Forwarded from …] at all.
    // The caption is appended rather than left to buildMessageContext, which
    // suppresses the message body when a transcript is supplied.
    const context = buildMessageContext(ctx, {
      voiceTranscript: transcript,
      attachments,
    });
    const caption = ctx.message?.caption?.trim();
    const prompt = caption ? `${context}\n\n---\n\n${caption}` : context;

    submitted = submitPart(ctx, convKey, {
      kind: "audio",
      seq,
      messageId: ctx.message?.message_id,
      text: prompt,
      media: [],
      audit: { kind: "AUDIO", summary: transcript },
      titleSeed: transcript,
      cleanupPaths: keepForTurn ? [filePath] : undefined,
      bytes: prompt.length,
    });
  } catch (error) {
    console.error("Error processing audio:", error);
    await ctx.reply("❌ Failed to process audio file.");
  } finally {
    typing.stop();

    // Unless the turn was told the file exists, transcription was the only thing
    // that needed it and it goes now.
    if (!keepForTurn || !submitted) {
      try {
        unlinkSync(filePath);
      } catch (error) {
        console.debug("Failed to delete audio file:", error);
      }
    }
  }
}

/**
 * Handle incoming native Telegram audio messages.
 */
export async function handleAudio(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const audio = ctx.message?.audio;

  if (!userId || !chatId || !audio) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USER)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  const convKey = convKeyFromCtx(ctx);

  // 2. Claim an arrival slot, synchronously, before the download begins.
  const seq = beginArrival(convKey);

  try {
    // 3. Rate limit check — skipped mid-burst, see voice.ts.
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

    console.log(`Received audio from @${username}`);

    // 4. Download audio file
    let audioPath: string;
    try {
      const file = await ctx.getFile();
      const timestamp = Date.now();
      const ext = audio.file_name?.split(".").pop() || "mp3";
      audioPath = `${TEMP_DIR}/audio_${timestamp}.${ext}`;

      const response = await fetch(
        `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`
      );
      const buffer = await response.arrayBuffer();
      await Bun.write(audioPath, buffer);
    } catch (error) {
      console.error("Failed to download audio:", error);
      await ctx.reply("❌ Failed to download audio file.");
      return;
    }

    // 5. Transcribe and submit
    await processAudioFile(ctx, audioPath, chatId, seq);
  } finally {
    endArrival(convKey);
  }
}
