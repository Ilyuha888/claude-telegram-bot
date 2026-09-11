/**
 * Claude Telegram Bot - TypeScript/Bun Edition
 *
 * Control Claude Code from your phone via Telegram.
 */

import { Bot } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { autoRetry } from "@grammyjs/auto-retry";
import { TELEGRAM_TOKEN, WORKING_DIR, ALLOWED_USER, GROUP_CHAT_ID, RESTART_FILE } from "./config";
import { convKeyFromCtx, convKeyStr } from "./conversation";
import { isRichMessage } from "./rich";
import { describeMessageShape, describeRichShape, unhandledContentKind } from "./utils";
import { isAuthorized } from "./security";
import { unlinkSync, readFileSync, existsSync } from "fs";
import {
  handleStart,
  handleNew,
  handleStop,
  handleStatus,
  handleResume,
  handleRestart,
  handleRetry,
  handleCompact,
  handleModel,
  handleTopic,
  handleCloseCommand,
  handleText,
  handleVoice,
  handlePhoto,
  handleDocument,
  handleAudio,
  handleVideo,
  handleCallback,
} from "./handlers";
import {
  handleWork, handleSessions, handleAttach,
  handleRepos, handleMenu,
} from "./handlers/mode2";
import { menuCommands } from "./commands-manifest";

// Create bot instance
const bot = new Bot(TELEGRAM_TOKEN);

// Retry on Telegram flood-wait (429) and transient 5xx/network errors instead
// of dropping the call. Streaming edits and rich-message drafts fire several
// API calls per second, which is exactly the traffic that trips rate limits.
bot.api.config.use(autoRetry());

// Sequentialize non-command messages per user (prevents race conditions)
// Commands bypass sequentialization so they work immediately
bot.use(
  sequentialize((ctx) => {
    // Commands are not sequentialized - they work immediately
    if (ctx.message?.text?.startsWith("/")) {
      return undefined;
    }
    // Messages with ! prefix bypass queue (interrupt)
    if (ctx.message?.text?.startsWith("!")) {
      return undefined;
    }
    // Callback queries (button clicks) are not sequentialized
    if (ctx.callbackQuery) {
      return undefined;
    }
    // Other messages are sequentialized per conversation (chat + forum topic)
    if (!ctx.chat) return undefined;
    return convKeyStr(convKeyFromCtx(ctx));
  })
);

// ============== Command Handlers ==============

bot.command("start", handleStart);
bot.command("new", handleNew);
// Registered unconditionally: with TELEGRAM_GROUP_CHAT_ID unset it replies with
// the setup instructions instead of doing nothing. It is hidden from the
// command menu and /start help in that case (see commands-manifest.ts).
bot.command("topic", handleTopic);
bot.command("compact", handleCompact);
bot.command("stop", handleStop);
bot.command("status", handleStatus);
bot.command("resume", handleResume);
bot.command("restart", handleRestart);
bot.command("retry", handleRetry);
bot.command("model", handleModel);

// ============== Mode-2 Command Handlers ==============

bot.command("work",     handleWork);
bot.command("sessions", handleSessions);
bot.command("attach",   handleAttach);
// One verb, two objects: `/close <slug>` is mode-2's work session, bare
// `/close` is the forum topic you sent it in. See handleCloseCommand.
bot.command("close",    handleCloseCommand);
bot.command("repos",    handleRepos);
bot.command("menu",     handleMenu);

// ============== Message Handlers ==============

// Text messages
bot.on("message:text", handleText);

// Voice messages
bot.on("message:voice", handleVoice);

// Photo messages
bot.on("message:photo", handlePhoto);

// Document messages
bot.on("message:document", handleDocument);

// Audio messages
bot.on("message:audio", handleAudio);

// Video messages (regular videos and video notes)
bot.on("message:video", handleVideo);
bot.on("message:video_note", handleVideo);

// Rich Messages (Bot API 10.1+). Registered last, and by hand rather than as a
// `message:rich_message` filter query, because @grammyjs/types doesn't know the
// field yet — grammY would reject the query string at startup.
//
// This is not a nicety. A Rich Message carries its content in
// `rich_message.blocks` and leaves `text` unset, so forwarding one of the bot's
// own long answers back to it matched *no* handler above: no reply, no log,
// nothing. The message simply disappeared, which is exactly what "big messages
// don't go through to the bot" looked like from the outside. Routed to
// handleText because by this point it is text — buildMessageContext reads the
// blocks via incomingRichText().
bot.on("message", async (ctx, next) => {
  if (!isRichMessage(ctx.message)) return next();
  await handleText(ctx);
});

// Last resort. Anything reaching here is a message the bot has no handler for,
// and staying silent about it is the failure mode this whole change exists to
// remove: the user cannot tell "ignored" from "never arrived". Service messages
// (someone joined, a topic was created, a pin changed) are not user input and
// are skipped — an acknowledgement for those would be noise in every topic.
bot.on("message", async (ctx) => {
  if (!isAuthorized(ctx.from?.id, ALLOWED_USER)) return;

  // Logged for EVERYTHING that gets this far, before deciding whether to reply.
  //
  // The first version only logged when unhandledContentKind named the content,
  // which meant an unrecognised shape reached here and vanished without a trace
  // — the exact failure this fallback exists to prevent, reintroduced one layer
  // down. A shape nobody anticipated is precisely the case worth a log line:
  // that is how the field name of a message type this bot can't yet read gets
  // discovered, instead of being guessed at from documentation.
  console.warn(
    `[bot] unhandled message reached the fallback: fields=${describeMessageShape(ctx.message)}` +
      ` rich=${describeRichShape(ctx.message)}`,
  );

  const kind = unhandledContentKind(ctx.message);
  if (!kind) return;

  console.warn(`[bot] unhandled message content: ${kind}`);
  // Plain ctx.reply: it auto-threads from the incoming message, so this lands
  // in the topic it was sent in without threading it by hand.
  await ctx.reply(
    `🤷 I got a ${kind} and can't read it — nothing from that message reached Claude.\n\n` +
      "Plain text, a photo, a voice note or a document all work.",
  );
});

// ============== Callback Queries ==============

bot.on("callback_query:data", handleCallback);

// ============== Error Handler ==============

bot.catch((err) => {
  console.error("Bot error:", err);
});

// ============== Startup ==============

console.log("=".repeat(50));
console.log("Claude Telegram Bot - TypeScript Edition");
console.log("=".repeat(50));
console.log(`Working directory: ${WORKING_DIR}`);
console.log(`Allowed user: ${ALLOWED_USER}`);
if (GROUP_CHAT_ID !== null) {
  // The two setup steps that fail silently: without "Manage Topics" the bot
  // can't create a topic at all, and with privacy mode on it never sees the
  // messages sent inside one.
  console.log(`Forum topics: enabled in chat ${GROUP_CHAT_ID}`);
  console.log(
    '  requires: Topics on, bot admin with "Manage Topics", privacy mode disabled in @BotFather'
  );
}
console.log("Starting bot...");

// Get bot info first
const botInfo = await bot.api.getMe();
console.log(`Bot started: @${botInfo.username}`);

// Register the / autocomplete menu with Telegram.
// Without this, Telegram shows whatever was last set via BotFather (often stale).
// Write to all_private_chats scope — it outranks the default scope for private
// chats, which is the only kind this bot serves. Without this, a stale
// all_private_chats list left over from BotFather can mask the default list.
try {
  const commandList = menuCommands();
  await bot.api.setMyCommands(commandList, {
    scope: { type: "all_private_chats" },
  });
  await bot.api.setMyCommands(commandList);
  console.log("Registered / command menu with Telegram (all_private_chats + default)");
} catch (err) {
  console.warn("Failed to register commands with Telegram:", err);
}

// Check for pending restart message to update
if (existsSync(RESTART_FILE)) {
  try {
    const data = JSON.parse(readFileSync(RESTART_FILE, "utf-8"));
    const age = Date.now() - data.timestamp;

    // Only update if restart was recent (within 30 seconds)
    if (age < 30000 && data.chat_id && data.message_id) {
      await bot.api.editMessageText(
        data.chat_id,
        data.message_id,
        "✅ Bot restarted"
      );
    }
    unlinkSync(RESTART_FILE);
  } catch (e) {
    console.warn("Failed to update restart message:", e);
    try { unlinkSync(RESTART_FILE); } catch {}
  }
}

// Start with concurrent runner (commands work immediately)
const runner = run(bot);

// Mode-2 boot tasks: publish the RC host environment, resume dead sessions,
// then start the idle reaper.
import { resumeOnBoot, startReaper } from "./mode2/reaper";
import { pushTmuxEnvironment } from "./mode2/sh";
import { startScheduler, stopScheduler } from "./scheduler";
import { warnPendingOnShutdown } from "./turn/collector";
import { reregisterTopics } from "./topics";
import { startTopicReaper } from "./topic-reaper";
// Awaited, and deliberately ordered before resumeOnBoot: the tmux server hands
// its global environment to each session it forks, so resuming first would leave
// the earliest-resumed hosts without CLAUDE_CODE_PATH or an augmented PATH.
// Never throws — a server that isn't up yet is handled at spawn time instead.
await pushTmuxEnvironment();
resumeOnBoot().catch((err) => console.error("resumeOnBoot error:", err));
startReaper();
startScheduler(bot).catch((err) => console.error("startScheduler error:", err));

// Hand each open forum topic its own SDK session back, so the first message
// after a restart continues that topic's conversation instead of starting
// fresh. No-op when TELEGRAM_GROUP_CHAT_ID is unset.
reregisterTopics().catch((err) => console.error("reregisterTopics error:", err));

// Evict idle in-memory sessions and close long-idle topics. No-op when
// TELEGRAM_GROUP_CHAT_ID is unset.
startTopicReaper(bot.api);

// Graceful shutdown
const stopRunner = () => {
  if (runner.isRunning()) {
    console.log("Stopping bot...");
    runner.stop();
  }
};

/**
 * Buffered messages die with the process, so say so on the way out.
 *
 * Hard-capped and best-effort: the exit must not become conditional on Telegram
 * answering. Without the notice the user is left looking at a `📥 Collecting…`
 * card that resolves to nothing, and no other part of the system will ever
 * mention those messages again — the same "a failure nobody sees" shape as the
 * silent routine failures in scheduler.ts.
 */
const shutdown = (signal: string) => {
  console.log(`Received ${signal}`);
  stopScheduler().catch(() => {});
  stopRunner();
  Promise.race([warnPendingOnShutdown(), Bun.sleep(2000)])
    .catch((err) => console.error("shutdown notice failed:", err))
    .finally(() => process.exit(0));
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
