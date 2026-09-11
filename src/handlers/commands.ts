/**
 * Command handlers for Claude Telegram Bot.
 *
 * /start, /new, /topic, /close, /model, /stop, /status, /resume, /restart,
 * /retry, /compact
 */

import { Context } from "grammy";
import { registry } from "../session-registry";
import { convKeyFromCtx } from "../conversation";
import { autoResumeTtlMs, WORKING_DIR, ALLOWED_USER, RESTART_FILE } from "../config";
import { isAuthorized } from "../security";
import { auditLog, formatClaudeErrorReply } from "../utils";
import { escapeHtml } from "../formatting";
import { isValidModelId, loadRuntimeConfig, setModel } from "../runtime-config";
import { renderHelp } from "../commands-manifest";
import {
  closeTopic,
  spawnTopicSession,
  topicsEnabled,
  topicName,
  topicLink,
} from "../topics";
import * as topicsStore from "../topics-store";
import { runExclusive } from "../turn/dispatcher";
import { dropPending, isCollecting, pendingCount } from "../turn/collector";
import { handleClose as handleWorkSessionClose } from "./mode2/close";

const SUMMARIZATION_PROMPT =
  "Summarize this entire conversation as a self-contained handoff brief for a future instance of yourself. " +
  "Include: the user's overall goal, key decisions made and why, current task state, open questions, and any " +
  "file paths or identifiers worth carrying forward. Be terse — aim for under 1500 characters. Output the brief " +
  "only, no preamble.";

/**
 * /start - Show welcome message and status.
 */
export async function handleStart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";

  if (!isAuthorized(userId, ALLOWED_USER)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  const session = registry.get(convKeyFromCtx(ctx));
  const status = session.isActive ? "Active session" : "No active session";
  const workDir = WORKING_DIR;

  await ctx.reply(
    `🤖 <b>Claude Telegram Bot</b>\n\n` +
      `Status: ${status}\n` +
      `Working directory: <code>${workDir}</code>\n\n` +
      `<b>Commands:</b>\n` +
      `${renderHelp()}\n\n` +
      `<b>Tips:</b>\n` +
      `• Prefix with <code>!</code> to interrupt current query\n` +
      `• Use "think" keyword for extended reasoning\n` +
      `• Send photos, voice, or documents`,
    { parse_mode: "HTML" }
  );
}

/**
 * /new - Start a fresh session.
 */
export async function handleNew(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USER)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const convKey = convKeyFromCtx(ctx);
  const session = registry.get(convKey);

  // Buffered messages go first, before the kill. Flushing them afterwards would
  // seed and title a *fresh* session from input the user has just disowned —
  // and they'd arrive with no visible connection to the messages that produced
  // them.
  const dropped = await dropPending(convKey, "/new");

  // Stop any running query
  if (session.isRunning) {
    const result = await session.stop();
    if (result) {
      await Bun.sleep(100);
      session.clearStopRequested();
    }
  }

  // Clear session
  await session.kill();

  await ctx.reply(
    "🆕 Session cleared. Next message starts fresh." +
      (dropped > 0
        ? `\n\n${dropped} unsent message${dropped === 1 ? " was" : "s were"} discarded.`
        : "")
  );
}

/**
 * /topic [name] - Open a new forum topic with its own Claude session.
 *
 * The session is created empty: the user's first message in the topic starts
 * it. Nothing is killed here — whatever is running in this chat keeps running.
 */
export async function handleTopic(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USER)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (!topicsEnabled()) {
    await ctx.reply(
      "🧵 Parallel sessions need a forum supergroup.\n\n" +
        "Set <code>TELEGRAM_GROUP_CHAT_ID</code> in .env to a supergroup that has " +
        'Topics enabled, with this bot as an admin holding "Manage Topics", then restart.',
      { parse_mode: "HTML" }
    );
    return;
  }

  const requested = ctx.match ? String(ctx.match).trim() : "";
  const name = topicName(requested);

  try {
    const key = await spawnTopicSession(ctx.api, { name, ctx });
    const link = key.threadId !== undefined ? topicLink(key.chatId, key.threadId) : null;
    const heading = link
      ? `🧵 <a href="${link}">${escapeHtml(name)}</a>`
      : `🧵 <b>${escapeHtml(name)}</b>`;
    await ctx.reply(`${heading}\n\nOpened. Messages you send there run in their own session.`, {
      parse_mode: "HTML",
    });
  } catch (e) {
    await ctx.reply(
      `❌ ${escapeHtml(String(e instanceof Error ? e.message : e).slice(0, 400))}`,
      { parse_mode: "HTML" }
    );
  }
}

/**
 * A resume window as a human would say it — "24h", "30 days". The topic window
 * is measured in weeks, and "post within 720h" is not a sentence anyone parses.
 */
function formatTtl(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * /close — close the forum topic this was sent in, and retire its session.
 *
 * Refuses outside a topic. A DM and the General topic both resolve to
 * `threadId === undefined` (see convKeyFromCtx), and neither can be closed:
 * General is the supergroup's root and a DM is not a topic at all.
 */
export async function handleCloseTopic(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";

  if (!isAuthorized(userId, ALLOWED_USER)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const key = convKeyFromCtx(ctx);
  if (key.threadId === undefined) {
    const lines = [
      topicsEnabled()
        ? "🧵 No topic to close here — this is the General topic or a direct chat."
        : "🧵 No topic to close here.",
      "",
      "Use <code>/new</code> to clear this conversation and start fresh" +
        (topicsEnabled()
          ? ", or <code>/topic</code> to open one that can be closed."
          : "."),
      "",
      "To close a <b>work</b> session instead: <code>/close &lt;slug&gt;</code> (see /sessions).",
    ];
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
    return;
  }

  const topic = await topicsStore.get(key.threadId);
  const name = topic?.name ?? `thread ${key.threadId}`;

  // Abort a query in flight before anything else.
  //
  // `registry.kill()` inside closeTopic clears the session's *state* — it never
  // touches the abort controller. Without this the claude subprocess would
  // outlive the close and keep streaming edits into a topic Telegram has
  // locked, which the bot (an admin with "Manage Topics") is uniquely able to
  // do and the user is uniquely unable to stop.
  //
  // Stop-and-close rather than refuse-if-busy, which is what the cap and the
  // idle reaper do. Those two are opportunistic: they are choosing among
  // topics and can always pick another, so skipping a busy one costs nothing.
  // `/close` names one topic and has no alternative — refusing would just mean
  // typing /stop and /close for a single intent. The interruption is reported
  // instead of hidden.
  //
  // `peek`, not `get`: closing a topic must never materialise a session that
  // wasn't in memory.
  // Same reasoning one step earlier: a burst still collecting for this topic
  // would otherwise flush into a topic Telegram has locked.
  const dropped = await dropPending(key, "topic closed");

  const session = registry.peek(key);
  let interrupted = false;
  if (session?.isRunning) {
    interrupted = true;
    const result = await session.stop();
    if (result) {
      // Same 100ms as /new: stop() only fires the abort signal, and the
      // unwinding turn's last edits should land while the topic is still open.
      await Bun.sleep(100);
      session.clearStopRequested();
    }
  }

  // Confirmation next, close last. Telegram lets an admin with "Manage Topics"
  // post into a closed topic — which this bot must be, or it could not close
  // one — but that is the only thing standing between the confirmation and a
  // TOPIC_CLOSED rejection, and the ordering costs nothing. If the close then
  // fails, the correction below lands in a topic that is demonstrably still open.
  // The window is the auto-resume TTL, not a hardcoded day: a deployment that
  // configures the TTL would otherwise be told the wrong number by the one
  // message that exists to set this expectation. Reads the *topic* window —
  // this command only ever runs inside a topic.
  await ctx.reply(
    `🧵 <b>${escapeHtml(name)}</b> closed.` +
      (interrupted ? " The query that was running has been interrupted." : "") +
      (dropped > 0
        ? ` ${dropped} unsent message${dropped === 1 ? " was" : "s were"} discarded.`
        : "") +
      "\n\nThe conversation is kept: reopen the topic from its menu and post within " +
      `${formatTtl(autoResumeTtlMs(key.threadId))} to carry on where you left off.`,
    { parse_mode: "HTML" }
  );

  const res = await closeTopic(ctx.api, { chat_id: key.chatId, thread_id: key.threadId }, "user");

  if (!res.ok) {
    await ctx.reply(
      "❌ Actually, I couldn't close it — the topic is still open.\n\n" +
        'This needs the bot to be an admin here with the "Manage Topics" permission.\n\n' +
        `Telegram said: <code>${escapeHtml(String(res.error).slice(0, 200))}</code>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  await auditLog(userId ?? 0, username, "TOPIC_CLOSE", `${name} (thread ${key.threadId})`).catch(
    () => {}
  );
}

/**
 * `/close` dispatcher.
 *
 * The name was already taken by mode-2's work-session close (`/close <slug>`),
 * and splitting it into two commands would have meant two near-identical verbs
 * in the menu. So the argument decides: a slug closes that work session, no
 * argument closes the forum topic you are standing in. The two objects never
 * overlap — a work session is a tmux server on a repo, a topic is a Telegram
 * thread — and the no-argument branch explains the other form when it can't do
 * anything useful.
 */
export async function handleCloseCommand(ctx: Context): Promise<void> {
  const slug = ctx.match ? String(ctx.match).trim() : "";
  if (slug) {
    await handleWorkSessionClose(ctx);
    return;
  }
  await handleCloseTopic(ctx);
}

/**
 * /model - Show or change the model used for new sessions.
 *
 * Writes runtime-config.json, which both modes re-read when they start a
 * session — so this takes effect on the next /new, with no service restart.
 */
export async function handleModel(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USER)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const session = registry.get(convKeyFromCtx(ctx));
  const arg = ctx.match ? String(ctx.match).trim() : "";

  if (!arg) {
    const cfg = await loadRuntimeConfig();
    const lines = [
      `🧠 <b>Model</b>`,
      `Configured: <code>${escapeHtml(cfg.model)}</code>`,
    ];
    if (session.resolvedModel) {
      lines.push(`Running now: <code>${escapeHtml(session.resolvedModel)}</code>`);
    }
    if (session.isActive) {
      lines.push(`\n<i>A session is active — a change applies after /new.</i>`);
    }
    lines.push(
      `\nChange it: <code>/model claude-opus-5[1m]</code>`,
      `The <code>[1m]</code> suffix selects the 1M-token context variant.`
    );
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
    return;
  }

  if (!isValidModelId(arg)) {
    await ctx.reply(
      `❌ <code>${escapeHtml(arg)}</code> doesn't look like a model id.\n` +
      `Expected something like <code>claude-opus-5[1m]</code> or <code>claude-sonnet-4-6</code>.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  try {
    const cfg = await setModel(arg);
    await ctx.reply(
      `✅ Model set to <code>${escapeHtml(cfg.model)}</code>.\n\n` +
      (session.isActive
        ? `Send /new to start a session on it — the current one keeps its model.`
        : `Your next message starts a session on it.`),
      { parse_mode: "HTML" }
    );
  } catch (e) {
    await ctx.reply(`❌ Couldn't save the model: ${escapeHtml(String(e).slice(0, 200))}`, {
      parse_mode: "HTML",
    });
  }
}

/**
 * /stop - Stop the current query (silently).
 */
export async function handleStop(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USER)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const convKey = convKeyFromCtx(ctx);
  const session = registry.get(convKey);

  // "Stop" has to mean the messages queued behind the query too — otherwise the
  // turn the user just killed starts again a second later. Reported by editing
  // the collecting card, which keeps /stop's "posts no new message" contract
  // true without pretending nothing happened.
  await dropPending(convKey, "stopped");

  if (session.isRunning) {
    const result = await session.stop();
    if (result) {
      // Wait for the abort to be processed, then clear stopRequested so next message can proceed
      await Bun.sleep(100);
      session.clearStopRequested();
    }
    // Silent stop - no message shown
  }
  // If nothing running, also stay silent
}

/**
 * /status - Show detailed status.
 */
export async function handleStatus(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USER)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const convKey = convKeyFromCtx(ctx);
  const session = registry.get(convKey);
  const lines: string[] = ["📊 <b>Bot Status</b>\n"];

  // Which conversation this readout is about. Everything below is per-key —
  // /status in a topic reports that topic's session, not a global one — so say
  // which key, or the numbers are ambiguous the moment a second topic exists.
  if (convKey.threadId !== undefined) {
    const topic = await topicsStore.get(convKey.threadId);
    lines.push(
      `🧵 Topic: ${escapeHtml(topic?.name ?? `thread ${convKey.threadId}`)}\n`
    );
  }

  // Model first — this is the question that kept getting answered wrong.
  // resolvedModel comes from the SDK init event, so it reports what is actually
  // running rather than what was requested.
  const cfg = await loadRuntimeConfig();
  const running = session.resolvedModel;
  if (running && running !== cfg.model) {
    lines.push(`🧠 Model: <code>${escapeHtml(running)}</code>`);
    lines.push(`   └─ configured: <code>${escapeHtml(cfg.model)}</code> (applies on /new)`);
  } else {
    lines.push(`🧠 Model: <code>${escapeHtml(running ?? cfg.model)}</code>${running ? "" : " (configured; no session yet)"}`);
  }
  if (session.claudeCodeVersion) {
    lines.push(`   └─ CLI ${escapeHtml(session.claudeCodeVersion)}`);
  }

  // Context occupancy, from the snapshot taken during the last turn. Reading
  // it live here doesn't work: the CLI subprocess that answers getContextUsage()
  // is already gone once a turn ends.
  const usage = session.lastContextUsage;
  if (usage) {
    const pct = Math.round(usage.percentage);
    const bars = Math.max(0, Math.min(10, Math.round(usage.percentage / 10)));
    lines.push(
      `\n📐 Context: ${"█".repeat(bars)}${"░".repeat(10 - bars)} ${pct}%`,
      `   ${usage.totalTokens.toLocaleString()} / ${usage.maxTokens.toLocaleString()} tokens`
    );
    // "Free space" is the unused remainder and deferred tool schemas aren't
    // loaded, so neither is consumption — listing them by size would put
    // "Free space: 968,007" at the top of a usage breakdown.
    const top = usage.categories
      .filter((c) => c.tokens > 0 && !c.isDeferred && !/free space/i.test(c.name))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 3);
    for (const c of top) {
      lines.push(`   └─ ${escapeHtml(c.name)}: ${c.tokens.toLocaleString()}`);
    }
  } else if (session.isActive) {
    lines.push(`\n📐 Context: (no reading yet — send a message)`);
  }

  // Session status
  lines.push("");
  if (session.isActive) {
    lines.push(`✅ Session: Active (${session.sessionId?.slice(0, 8)}...)`);
  } else {
    lines.push("⚪ Session: None");
  }

  // Resumable history for THIS conversation only — the same list /resume
  // offers. A global count here would promise sessions that /resume in this
  // topic will never show.
  const resumable = session.getSessionList(convKey).length;
  if (resumable > 0) {
    lines.push(`   └─ ${resumable} resumable here (/resume)`);
  }

  // Query status
  if (session.isRunning) {
    const elapsed = session.queryStarted
      ? Math.floor((Date.now() - session.queryStarted.getTime()) / 1000)
      : 0;
    lines.push(`🔄 Query: Running (${elapsed}s)`);
    if (session.currentTool) {
      lines.push(`   └─ ${session.currentTool}`);
    }
  } else {
    lines.push("⚪ Query: Idle");
    if (session.lastTool) {
      lines.push(`   └─ Last: ${session.lastTool}`);
    }
  }

  // Free diagnostic, and the only one there is: a stuck arrival count shows up
  // as a conversation that quietly stops answering, with nothing in the session
  // state to explain it.
  const queued = pendingCount(convKey);
  if (queued > 0) {
    lines.push(`📥 ${queued} message${queued === 1 ? "" : "s"} queued`);
  } else if (isCollecting(convKey)) {
    lines.push("📥 Collecting…");
  }

  // Last activity
  if (session.lastActivity) {
    const ago = Math.floor(
      (Date.now() - session.lastActivity.getTime()) / 1000
    );
    lines.push(`\n⏱️ Last activity: ${ago}s ago`);
  }

  // Usage stats
  if (session.lastUsage) {
    const usage = session.lastUsage;
    lines.push(
      `\n📈 Last query usage:`,
      `   Input: ${usage.input_tokens?.toLocaleString() || "?"} tokens`,
      `   Output: ${usage.output_tokens?.toLocaleString() || "?"} tokens`
    );
    if (usage.cache_read_input_tokens) {
      lines.push(
        `   Cache read: ${usage.cache_read_input_tokens.toLocaleString()}`
      );
    }
  }

  // Error status
  if (session.lastError) {
    const ago = session.lastErrorTime
      ? Math.floor((Date.now() - session.lastErrorTime.getTime()) / 1000)
      : "?";
    lines.push(`\n⚠️ Last error (${ago}s ago):`, `   ${session.lastError}`);
  }

  // Working directory
  lines.push(`\n📁 Working dir: <code>${WORKING_DIR}</code>`);

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

/**
 * /resume - Show list of sessions to resume with inline keyboard.
 */
export async function handleResume(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USER)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const convKey = convKeyFromCtx(ctx);
  const session = registry.get(convKey);

  if (session.isActive) {
    await ctx.reply("Sessione già attiva. Usa /new per iniziare da capo.");
    return;
  }

  // Saved sessions for THIS conversation. Passed explicitly rather than relying
  // on the instance default, because the scoping is the point: offering a topic
  // the DM's sessions (or another topic's) would splice an unrelated transcript
  // into this thread on one tap.
  const sessions = session.getSessionList(convKey);

  if (sessions.length === 0) {
    await ctx.reply("❌ Nessuna sessione salvata per questa conversazione.");
    return;
  }

  // Build inline keyboard with session list
  const buttons = sessions.map((s) => {
    // Format date: "18/01 10:30"
    const date = new Date(s.saved_at);
    const dateStr = date.toLocaleDateString("it-IT", {
      day: "2-digit",
      month: "2-digit",
    });
    const timeStr = date.toLocaleTimeString("it-IT", {
      hour: "2-digit",
      minute: "2-digit",
    });

    // Truncate title for button (max ~40 chars to fit)
    const titlePreview =
      s.title.length > 35 ? s.title.slice(0, 32) + "..." : s.title;

    return [
      {
        text: `📅 ${dateStr} ${timeStr} - "${titlePreview}"`,
        callback_data: `resume:${s.session_id}`,
      },
    ];
  });

  await ctx.reply("📋 <b>Sessioni salvate</b>\n\nSeleziona una sessione da riprendere:", {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: buttons,
    },
  });
}

/**
 * /restart - Restart the bot process.
 */
export async function handleRestart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USER)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const msg = await ctx.reply("🔄 Restarting bot...");

  // Save message info so we can update it after restart
  if (chatId && msg.message_id) {
    try {
      await Bun.write(
        RESTART_FILE,
        JSON.stringify({
          chat_id: chatId,
          message_id: msg.message_id,
          timestamp: Date.now(),
        })
      );
    } catch (e) {
      console.warn("Failed to save restart info:", e);
    }
  }

  // Give time for the message to send
  await Bun.sleep(500);

  // Exit - launchd will restart us
  process.exit(0);
}

/**
 * /compact - Summarize current session into a handoff brief, then kill it.
 * The brief is prepended to the user's next message via session.pendingHandoff.
 * Must be invoked before the context wall — summarization needs context room.
 */
export async function handleCompact(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";

  if (!isAuthorized(userId, ALLOWED_USER)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const convKey = convKeyFromCtx(ctx);
  const session = registry.get(convKey);

  if (!session.isActive) {
    await ctx.reply("Nothing to compact — no session running.");
    return;
  }

  if (session.isRunning) {
    await ctx.reply("⏳ A query is in progress. /stop first, then /compact.");
    return;
  }

  // Refused rather than flushed: /compact kills the session, so a batch that
  // landed a second later would race the summarisation turn into a session
  // being torn down. Waiting out the collection window costs a second.
  if (isCollecting(convKey)) {
    await ctx.reply("⏳ Still collecting messages. Try /compact again in a moment.");
    return;
  }

  await ctx.reply("📦 Compacting session… this takes one turn.");

  const stopProcessing = session.startProcessing();
  try {
    // No-op status callback: we don't want streaming events surfacing to the user
    // for this internal summarization turn.
    const noop = async () => {};
    const summary = await runExclusive(convKey, () =>
      session.sendMessageStreaming(
        SUMMARIZATION_PROMPT,
        username,
        userId!,
        noop,
        ctx.chat?.id,
        ctx,
        convKey.threadId
      )
    );

    // sendMessageStreaming has non-answer return values; storing one as the
    // handoff would silently replace the brief with a sentinel string.
    const usable =
      summary.trim().length >= 40 &&
      summary !== "[Waiting for user selection]" &&
      summary !== "No response from Claude.";

    if (!usable) {
      await ctx.reply(
        "⚠️ Compaction didn't produce a usable summary, so the session was left as-is. " +
        "Try again, or /new to start fresh."
      );
      return;
    }

    await session.kill();
    // Set after kill() — kill() clears pendingHandoff so an abandoned compact
    // can't leak a stale brief into an unrelated session later.
    session.pendingHandoff = summary;

    // Telegram limit is 4096; keep room for the wrapper text.
    const preview = summary.length > 3500 ? summary.slice(0, 3500) + "\n…[truncated]" : summary;
    await ctx.reply(
      `✅ Session compacted. Next message starts fresh — the brief below will be prepended:\n\n${preview}`
    );
  } catch (error) {
    console.error("Compact failed:", error);
    // On a context_limit the session has already been killed inside
    // sendMessageStreaming, so the reply's "next message starts fresh" is true.
    await ctx.reply(formatClaudeErrorReply(error));
  } finally {
    stopProcessing();
  }
}

/**
 * A context that looks like the user having sent `text`, for replaying a turn.
 *
 * Why a real `Context` and not `{ ...ctx, message: { ... } }`: grammY defines
 * `chat`, `from`, `msg`, `message`, `reply` and the rest as accessors and
 * methods on `Context.prototype`, and object spread copies neither. The spread
 * produced an object with an `update` and nothing else — no `reply` to answer
 * with, no `chat`/`from` to authorise against — so /retry threw on its first
 * line of real work. (Before the conversation-key refactor it got as far as
 * `ctx.reply` and threw there; afterwards `convKeyFromCtx` throws first on
 * `ctx.chat`. Same broken object, earlier symptom.)
 *
 * The update is rebuilt instead, which is the thing grammY actually derives
 * everything from. `entities` is dropped with it: they describe offsets into
 * the "/retry" text and are meaningless against the replacement, and a stale
 * `bot_command` entity spanning the new text is exactly the sort of thing a
 * future filter would trip over.
 */
export function buildRetryContext(ctx: Context, text: string): Context {
  const original = ctx.message!;
  const { entities: _dropped, ...message } = original;
  return new Context(
    { ...ctx.update, message: { ...message, text } },
    ctx.api,
    ctx.me
  );
}

/**
 * /retry - Retry the last message (resume session and re-send).
 */
export async function handleRetry(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USER)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const convKey = convKeyFromCtx(ctx);
  const session = registry.get(convKey);

  // Check if there's a message to retry
  if (!session.lastMessage) {
    await ctx.reply("❌ No message to retry.");
    return;
  }

  // Check if something is already running
  if (session.isRunning) {
    await ctx.reply("⏳ A query is already running. Use /stop first.");
    return;
  }

  // A retry replays the *last* message; queueing it behind a batch that hasn't
  // been sent yet would reorder the conversation, and replaying into a turn
  // about to include new input is not what the user asked for.
  if (isCollecting(convKey)) {
    await ctx.reply("⏳ Still collecting messages. Try /retry again in a moment.");
    return;
  }

  // Every path below rebuilds the update, so there has to be one to rebuild.
  // A command can only arrive on a message, but /retry is exported and the
  // failure without this guard is a confusing throw inside grammY.
  if (!ctx.message) {
    await ctx.reply("❌ /retry only works on a message.");
    return;
  }

  const message = session.lastMessage;
  await ctx.reply(`🔄 Retrying: "${message.slice(0, 50)}${message.length > 50 ? "..." : ""}"`);

  // Replay the message through the normal text path, from a context that is a
  // real grammY Context (see buildRetryContext) rather than a spread of one.
  const { handleText } = await import("./text");
  await handleText(buildRetryContext(ctx, message));
}
