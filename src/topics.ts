/**
 * Spawning Claude sessions into Telegram forum topics.
 *
 * One primitive, `spawnTopicSession`, used by every entry point that wants a
 * conversation to start somewhere new instead of taking over the current one:
 * the `/topic` command and the scheduler's notification buttons.
 *
 * Everything here requires TELEGRAM_GROUP_CHAT_ID. With it unset the bot has
 * no supergroup to create topics in, so callers must gate on `topicsEnabled()`
 * and keep their single-chat behaviour.
 */

import type { Api, Context } from "grammy";
import { autoResumeTtlMs, GROUP_CHAT_ID, MAX_ACTIVE_TOPICS } from "./config";
import type { ConversationKey } from "./conversation";
import { threadOpts } from "./conversation";
import { registry } from "./session-registry";
import * as topicsStore from "./topics-store";
import { StreamingState, createStatusCallback } from "./handlers/streaming";
import { auditLog, formatClaudeErrorReply, startTypingIndicator } from "./utils";
import { runExclusive } from "./turn/dispatcher";

/** Telegram's hard limit on forum topic names. */
const TOPIC_NAME_MAX = 128;

/**
 * What the user has to do by hand before any of this works. Surfaced verbatim
 * on failure — createForumTopic's own error ("not enough rights") does not say
 * which right, in which chat, or that Topics must be switched on at all.
 */
const SETUP_HINT =
  "Forum topics need a one-time setup: the chat in TELEGRAM_GROUP_CHAT_ID must be a " +
  "supergroup with Topics enabled, and the bot must be an admin there with the " +
  '"Manage Topics" permission.';

export function topicsEnabled(): boolean {
  return GROUP_CHAT_ID !== null;
}

/**
 * Trim a title to something Telegram will accept. Empty input falls back to a
 * timestamped name rather than failing the call.
 */
export function topicName(raw: string): string {
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (trimmed === "") return defaultTopicName();
  return trimmed.length > TOPIC_NAME_MAX
    ? trimmed.slice(0, TOPIC_NAME_MAX - 1) + "…"
    : trimmed;
}

/**
 * Join a base name and a disambiguating suffix without losing the suffix.
 *
 * `topicName` truncates from the right, which would cut off the very stamp that
 * makes the name unique, so the base is trimmed to make room instead.
 */
function withSuffix(base: string, suffix: string): string {
  const room = TOPIC_NAME_MAX - suffix.length;
  const trimmed =
    base.length > room ? base.slice(0, Math.max(1, room - 1)) + "…" : base;
  return trimmed + suffix;
}

/**
 * A name no other OPEN topic is using.
 *
 * Telegram is happy to create two topics called "Daily focus", and nothing in
 * this codebase breaks when it does — `topics.json` keys on `thread_id`, the
 * registry keys on `(chatId, threadId)`, and no lookup anywhere resolves a
 * topic by name. The cost is entirely human: pressing "Open in new chat" on a
 * recurring routine every morning fills the sidebar with identical rows and no
 * way to tell which is which, and the only thing bounding that pile is the
 * reaper quietly closing the oldest.
 *
 * So a unique name is left exactly as the user typed it — `/topic refactor
 * auth` should not become `refactor auth · 29 Jul` — and only a real collision
 * earns a stamp: first the date, then the time, then a counter for the
 * pathological case of two spawns inside the same minute.
 *
 * Closed topics deliberately don't reserve their names: closing a topic is how
 * the user says they're done with it, and its name should become reusable.
 */
export async function uniqueTopicName(base: string, now = new Date()): Promise<string> {
  let open: Set<string>;
  try {
    open = new Set((await topicsStore.list()).filter((t) => !t.closed).map((t) => t.name));
  } catch (err) {
    // A store read failure must not block the spawn — a duplicate name is
    // cosmetic, and failing here would cost the user their session.
    console.warn("[topics] couldn't read topics.json for name disambiguation:", err);
    return base;
  }

  if (!open.has(base)) return base;

  const stamp = (opts: Intl.DateTimeFormatOptions) =>
    now.toLocaleString("en-GB", { timeZone: "Europe/Moscow", ...opts });

  const candidates = [
    withSuffix(base, ` · ${stamp({ month: "short", day: "numeric" })}`),
    withSuffix(
      base,
      ` · ${stamp({ month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`,
    ),
  ];
  for (const candidate of candidates) {
    if (!open.has(candidate)) return candidate;
  }

  for (let n = 2; n < 100; n++) {
    const candidate = withSuffix(candidates[1]!, ` (${n})`);
    if (!open.has(candidate)) return candidate;
  }
  return candidates[1]!;
}

/** Name used by /topic when the user gives none. */
export function defaultTopicName(now = new Date()): string {
  const stamp = now.toLocaleString("en-GB", {
    timeZone: "Europe/Moscow",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Session ${stamp}`;
}

/**
 * Deep link to a topic, or null when one can't be built.
 *
 * Private supergroups are addressed as t.me/c/<id-without-the--100-prefix>,
 * which is the only shape this bot ever sees; anything else (a public
 * @username group, a plain group id) gets no link rather than a broken one.
 */
export function topicLink(chatId: number, threadId: number): string | null {
  const s = String(chatId);
  if (!s.startsWith("-100")) return null;
  return `https://t.me/c/${s.slice(4)}/${threadId}`;
}

/**
 * Give an open topic its session back after a restart, when nothing else can.
 *
 * Called once at boot (src/index.ts, after startScheduler). The primary resume
 * path is `ClaudeSession.tryAutoResume`, which now filters the session history
 * by ConversationKey and therefore already hands each topic its own
 * conversation on the first message after a restart. This loop covers the one
 * gap that path has: a topic whose history entries have been pruned away,
 * leaving `topics.json` as the only surviving record that the conversation
 * exists.
 *
 * Hence the deliberate `continue` when the history has anything at all for a
 * topic. Pre-empting tryAutoResume would be worse there:
 *  - tryAutoResume evaluates its 24h TTL when the user actually posts, whereas
 *    anything decided here freezes that judgement at boot — a topic reopened
 *    two days after a restart should start fresh, and only the lazy path can
 *    know that;
 *  - it also picks the newest matching entry, while this path can only offer
 *    the one id `topics.json` happens to hold.
 *
 * What is no longer a reason: the recorded id used to be written at *spawn*
 * only, so a `/new` inside the topic left it pointing at an abandoned
 * conversation. `ClaudeSession.noteTopicSession` now rewrites it on the first
 * turn of every session, so the recorded id is the live one — which is what
 * makes the pruned-history case below safe to act on at all.
 *
 * Where it does act, it also restores the topic's title for /status, and
 * setting `sessionId` makes the later tryAutoResume a no-op — so the two paths
 * can never both fire and disagree. Returns how many topics it restored.
 */
export async function reregisterTopics(now = Date.now()): Promise<number> {
  if (GROUP_CHAT_ID === null) return 0;

  let entries: topicsStore.TopicEntry[];
  try {
    entries = await topicsStore.list();
  } catch (err) {
    console.error("[topics] re-registration failed to read topics.json:", err);
    return 0;
  }

  let restored = 0;
  for (const t of entries) {
    if (t.closed || !t.session_id) continue;
    // Same wall tryAutoResume applies, measured against the topic's own last
    // activity — and it has to be the *topic* wall, not the DM one. These
    // entries all have a thread_id by construction, so reading the DM TTL here
    // would retire on boot exactly the topics tryAutoResume would then happily
    // resume from history: same conversation, two different answers depending
    // on whether the bot had restarted.
    const idleMs = now - new Date(t.last_active_at).getTime();
    if (!Number.isFinite(idleMs) || idleMs > autoResumeTtlMs(t.thread_id)) continue;

    const session = registry.get({ chatId: t.chat_id, threadId: t.thread_id });
    if (session.getSessionList().length > 0) continue;
    if (session.adoptSession(t.session_id, t.name)) restored++;
  }

  if (restored > 0) {
    console.log(
      `[topics] re-registered ${restored} topic session(s) from topics.json after restart`
    );
  }
  return restored;
}

/**
 * Did Telegram refuse because the topic is already closed?
 *
 * Best-effort string match — grammY surfaces the raw API description and
 * Telegram has used both TOPIC_CLOSED and TOPIC_ALREADY_CLOSED for this. The
 * consequence of guessing wrong is small in either direction: a false positive
 * marks a topic closed that is not (self-heals on the next turn, see
 * `topicsStore.touch`), a false negative leaves an already-closed topic
 * counted as open until the user posts in it.
 */
function isAlreadyClosed(err: unknown): boolean {
  return /TOPIC_(ALREADY_)?CLOSED/i.test(String(err));
}

export interface CloseTopicResult {
  ok: boolean;
  /** Telegram's complaint, when it had one. */
  error?: string;
}

/**
 * Close a forum topic and retire its session.
 *
 * The one place all three closing paths go through — the `/close` command, the
 * idle auto-close, and the MAX_ACTIVE_TOPICS eviction — so they cannot drift.
 * Order is Telegram first, local state second: on a refusal (no
 * "Manage Topics" right, most likely) nothing local changes, because a store
 * that says "closed" about a topic the user can still type in is worse than
 * one that is merely out of date.
 *
 * `closeForumTopic`, never `deleteForumTopic`: closing is reversible from the
 * Telegram UI and keeps the transcript. The SDK session is deliberately left in
 * `chat-session-history.json` too, so reopening the topic and posting inside
 * the auto-resume TTL continues the same conversation.
 *
 * `notice` is posted into the topic first, for the paths where the bot closes a
 * topic on its own initiative and a silent disappearance would read as a bug.
 * Before, not after: a closed topic may reject new messages. Best effort — a
 * failed courtesy note is not a reason to keep the topic open.
 */
export async function closeTopic(
  api: Api,
  topic: { chat_id: number; thread_id: number },
  reason: string,
  notice?: string
): Promise<CloseTopicResult> {
  if (notice) {
    try {
      await api.sendMessage(topic.chat_id, notice, threadOpts(topic.thread_id));
    } catch (err) {
      console.warn(`[topics] couldn't post the close notice in thread ${topic.thread_id}: ${err}`);
    }
  }

  try {
    await api.closeForumTopic(topic.chat_id, topic.thread_id);
  } catch (err) {
    if (!isAlreadyClosed(err)) {
      console.error(`[topics] closeForumTopic(${topic.thread_id}) failed:`, err);
      return { ok: false, error: String(err) };
    }
    console.log(`[topics] thread ${topic.thread_id} was already closed`);
  }

  await registry.kill({ chatId: topic.chat_id, threadId: topic.thread_id });
  await topicsStore.markClosed(topic.thread_id);
  console.log(`[topics] closed thread ${topic.thread_id} (${reason})`);
  return { ok: true };
}

/**
 * Make room for one more topic, closing the oldest-idle one if the cap is hit.
 *
 * Runs BEFORE `createForumTopic`, so the supergroup never visibly exceeds
 * MAX_ACTIVE_TOPICS. A topic with a query in flight is never a candidate — its
 * user is watching it answer — and if that leaves nothing to close the spawn
 * fails rather than quietly blowing past the cap: an unbounded topic list is a
 * worse surprise than a refused /topic with a reason attached.
 *
 * `MAX_ACTIVE_TOPICS <= 0` disables the cap.
 */
export async function enforceTopicCap(api: Api, now = Date.now()): Promise<void> {
  if (!Number.isFinite(MAX_ACTIVE_TOPICS) || MAX_ACTIVE_TOPICS <= 0) return;

  const open = (await topicsStore.list()).filter((t) => !t.closed);
  // `open.length` counts what exists; the +1 is the topic about to be created.
  const overBy = open.length + 1 - MAX_ACTIVE_TOPICS;
  if (overBy <= 0) return;

  const idleFirst = open
    .filter((t) => !registry.peek({ chatId: t.chat_id, threadId: t.thread_id })?.isRunning)
    .map((t) => {
      const at = new Date(t.last_active_at).getTime();
      // An unparseable timestamp reads as maximally idle rather than as "now":
      // a corrupted field should make a topic collectable, not immortal.
      return { t, idleAt: Number.isFinite(at) ? at : 0 };
    })
    .sort((a, b) => a.idleAt - b.idleAt);

  if (idleFirst.length < overBy) {
    throw new Error(
      `Topic limit reached (${open.length}/${MAX_ACTIVE_TOPICS}) and every topic has a query running. ` +
        "Wait for one to finish, or /close a topic you're done with."
    );
  }

  for (const { t, idleAt } of idleFirst.slice(0, overBy)) {
    const idleMin = Math.round((now - idleAt) / 60000);
    const res = await closeTopic(
      api,
      t,
      `cap ${MAX_ACTIVE_TOPICS}`,
      `🧵 Closing this topic — it was the longest idle, and the ${MAX_ACTIVE_TOPICS}-topic limit was reached.\n` +
        "Reopen it from the topic menu to pick the conversation back up."
    );
    if (!res.ok) {
      throw new Error(
        `Topic limit reached (${open.length}/${MAX_ACTIVE_TOPICS}) and the oldest one couldn't be closed to make room. ` +
          `Telegram said: ${String(res.error).slice(0, 200)}`
      );
    }
    console.log(
      `[topics] cap ${MAX_ACTIVE_TOPICS} reached — closed "${t.name}" (thread ${t.thread_id}, idle ${idleMin}m)`
    );
    auditLog(0, "reaper", "TOPIC_CAP_CLOSE", `${t.name} (thread ${t.thread_id}) idle_min=${idleMin}`).catch(
      () => {}
    );
  }
}

export interface SpawnTopicOptions {
  /** Topic title. Truncated to Telegram's 128-char limit. */
  name: string;
  /** Optional first message sent into the fresh session. */
  primingPrompt?: string;
  /** Only for user identity (from.id / from.username) — never for routing. */
  ctx: Context;
  /**
   * Called as soon as the topic exists, before the priming turn — which can
   * run for minutes. Lets a caller hand the user a link straight away instead
   * of after the answer. Failures here are logged and ignored.
   */
  onTopicCreated?: (key: ConversationKey) => void | Promise<void>;
}

/**
 * Create a forum topic and, optionally, prime a fresh session inside it.
 *
 * Returns the new ConversationKey. Throws when topics aren't configured or
 * when Telegram refuses to create one; a failure of the *priming* turn is
 * reported into the new topic instead, because by then the topic exists and
 * the user is looking at it.
 */
export async function spawnTopicSession(
  api: Api,
  opts: SpawnTopicOptions
): Promise<ConversationKey> {
  if (GROUP_CHAT_ID === null) {
    throw new Error(
      "Forum topics are not configured: set TELEGRAM_GROUP_CHAT_ID to a supergroup id. " +
        SETUP_HINT
    );
  }

  // Disambiguated before the cap check, so the name that gets created is the
  // name the cap accounted for.
  const name = await uniqueTopicName(topicName(opts.name));

  // Before the topic exists, so the cap is a real ceiling rather than a
  // cleanup pass. Throws when it can't make room; the callers (/topic, the
  // notification button) already surface a spawn failure to the user.
  await enforceTopicCap(api);

  let threadId: number;
  try {
    const topic = await api.createForumTopic(GROUP_CHAT_ID, name);
    threadId = topic.message_thread_id;
  } catch (err) {
    console.error("[topics] createForumTopic failed:", err);
    throw new Error(
      `Couldn't create the topic. ${SETUP_HINT}\n\nTelegram said: ${String(err).slice(0, 200)}`
    );
  }

  const key: ConversationKey = { chatId: GROUP_CHAT_ID, threadId };
  const now = new Date().toISOString();
  await topicsStore.upsert({
    thread_id: threadId,
    chat_id: GROUP_CHAT_ID,
    name,
    created_at: now,
    session_id: null,
    last_active_at: now,
  });

  const userId = opts.ctx.from?.id ?? 0;
  const username = opts.ctx.from?.username ?? "unknown";
  auditLog(userId, username, "TOPIC_SPAWN", `${name} (thread ${threadId})`).catch(
    () => {}
  );
  console.log(`[topics] spawned "${name}" as thread ${threadId}`);

  // No kill() here any more, and none is needed. Auto-resume is filtered by
  // ConversationKey (savedSessionMatchesKey in session.ts): a thread id that
  // has never held a conversation matches no saved entry — not another topic's,
  // not the DM's, not a legacy one — so a fresh instance starts fresh because
  // there is nothing for it to inherit, and that holds across restarts and
  // registry eviction rather than only for the lifetime of one in-memory flag.
  //
  // Nor can this key collide with a live instance: a forum topic's thread id is
  // the message id of the service message that created it, and message ids are
  // monotonic within a chat, so createForumTopic never hands back an id the
  // registry has already seen.
  const session = registry.get(key);

  if (opts.onTopicCreated) {
    try {
      await opts.onTopicCreated(key);
    } catch (err) {
      console.error("[topics] onTopicCreated hook failed:", err);
    }
  }

  const primingPrompt = opts.primingPrompt;
  if (!primingPrompt) return key;

  // The target is what makes the streamed answer land in the NEW topic: every
  // send in the status callback is forced to (GROUP_CHAT_ID, threadId) instead
  // of replying to wherever opts.ctx came from.
  const state = new StreamingState({ chatId: GROUP_CHAT_ID, threadId });
  const statusCallback = createStatusCallback(opts.ctx, state);
  const typing = startTypingIndicator(opts.ctx, { chatId: GROUP_CHAT_ID, threadId });

  try {
    await runExclusive(key, () =>
      session.sendMessageStreaming(
        primingPrompt,
        username,
        userId,
        statusCallback,
        // key.chatId, not GROUP_CHAT_ID: identical value, but TypeScript drops
        // the `!== null` narrowing of an imported binding inside a closure.
        key.chatId,
        opts.ctx,
        threadId
      )
    );
  } catch (err) {
    console.error(`[topics] priming thread ${threadId} failed:`, err);
    try {
      // Reported into the new topic, not back to opts.ctx: the topic exists,
      // the user is being sent there, and an error posted anywhere else would
      // leave it looking silently empty.
      await api.sendMessage(
        GROUP_CHAT_ID,
        formatClaudeErrorReply(err),
        threadOpts(threadId)
      );
    } catch (sendErr) {
      console.error("[topics] failed to report priming error:", sendErr);
    }
  } finally {
    typing.stop();
    // No setSessionId/touch here: the session records both itself now
    // (ClaudeSession.noteTopicSession / noteTopicActivity), on the first SDK
    // event and at the start of the turn respectively. Doing it again from
    // out here would only re-derive the same values a beat later — and would
    // still miss every turn that does not go through a spawn, which was the
    // reason the bookkeeping moved inside.
  }

  return key;
}
