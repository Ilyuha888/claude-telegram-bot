/**
 * Claude Telegram Bot - TypeScript/Bun Edition
 *
 * Control Claude Code from your phone via Telegram.
 */

import { Bot } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { TELEGRAM_TOKEN, WORKING_DIR, ALLOWED_USERS, RESTART_FILE } from "./config";
import { unlinkSync, readFileSync, existsSync } from "fs";
import {
  handleStart,
  handleNew,
  handleStop,
  handleStatus,
  handleResume,
  handleRestart,
  handleRetry,
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
  handleClose, handleRepos, handleMenu,
} from "./handlers/mode2";

// Create bot instance
const bot = new Bot(TELEGRAM_TOKEN);

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
    // Other messages are sequentialized per chat
    return ctx.chat?.id.toString();
  })
);

// ============== Command Handlers ==============

bot.command("start", handleStart);
bot.command("new", handleNew);
bot.command("stop", handleStop);
bot.command("status", handleStatus);
bot.command("resume", handleResume);
bot.command("restart", handleRestart);
bot.command("retry", handleRetry);

// ============== Mode-2 Command Handlers ==============

bot.command("work",     handleWork);
bot.command("sessions", handleSessions);
bot.command("attach",   handleAttach);
bot.command("close",    handleClose);
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
console.log(`Allowed users: ${ALLOWED_USERS.length}`);
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
  const commandList = [
    { command: "new",     description: "Start fresh session" },
    { command: "stop",    description: "Stop current query" },
    { command: "retry",   description: "Retry last message" },
    { command: "status",  description: "Show status" },
    { command: "resume",  description: "Resume last session" },
    { command: "restart", description: "Restart the bot" },
    { command: "menu",    description: "Repos · Sessions · Work" },
  ];
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

// Mode-2 boot tasks: resume dead sessions, then start idle reaper
import { resumeOnBoot, startReaper } from "./mode2/reaper";
import { startScheduler, stopScheduler } from "./scheduler";
resumeOnBoot().catch((err) => console.error("resumeOnBoot error:", err));
startReaper();
startScheduler(bot).catch((err) => console.error("startScheduler error:", err));

// Graceful shutdown
const stopRunner = () => {
  if (runner.isRunning()) {
    console.log("Stopping bot...");
    runner.stop();
  }
};

process.on("SIGINT", () => {
  console.log("Received SIGINT");
  stopScheduler().catch(() => {});
  stopRunner();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM");
  stopScheduler().catch(() => {});
  stopRunner();
  process.exit(0);
});
