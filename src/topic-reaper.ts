/**
 * Lifecycle reaper for parallel conversations.
 *
 * Two jobs on one tick — evict idle in-memory sessions, close idle forum
 * topics — plus the third member of the family, the MAX_ACTIVE_TOPICS cap,
 * which lives in `topics.ts` because it runs on the spawn path rather than on
 * a timer.
 *
 * A sibling of `mode2/reaper.ts`, not an extension of it, for the same reason
 * `topics-store.ts` sits in `src/` and not `src/mode2/`: that reaper is about
 * mode-2 work sessions — tmux servers, git worktrees, `mode2/store.ts` — with
 * its own idle threshold measured in days and its own boot-resume. This one is
 * about the core conversation layer. Merging them would mean one tick with two
 * unrelated thresholds, two unrelated stores and one shared failure mode: a
 * throw scanning topics would stop reaping worktrees. The scan/tick shape,
 * the JSON console events and the audit-log calls are copied from it
 * deliberately.
 *
 * Everything here is inert when TELEGRAM_GROUP_CHAT_ID is unset. Session
 * eviction would technically be harmless in a plain DM, but "flag off ⇒ nothing
 * new runs" is worth more than bounding one object.
 */

import type { Api } from "grammy";
import {
  GROUP_CHAT_ID,
  SESSION_IDLE_EVICT_MINUTES,
  TOPIC_IDLE_CLOSE_DAYS,
  TOPIC_REAPER_INTERVAL_MS,
} from "./config";
import { registry } from "./session-registry";
import { collectingKeys, isCollecting } from "./turn/collector";
import { closeTopic } from "./topics";
import * as topicsStore from "./topics-store";
import { auditLog } from "./utils";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Drop registry instances nobody has used for SESSION_IDLE_EVICT_MINUTES.
 *
 * Invisible to the user: see `SessionRegistry.evictIdle` for why an evicted
 * conversation comes back intact on its next message. This only bounds the
 * memory of a process that may hold twenty conversations for weeks.
 *
 * Conversations mid-burst are pinned. The registry cannot see them: a
 * conversation collecting a burst — or with a voice note still transcribing —
 * has no running query, so it reads as idle right up until the turn it is about
 * to start.
 */
export function evictIdleSessions(now = Date.now()): string[] {
  if (GROUP_CHAT_ID === null) return [];
  const evicted = registry.evictIdle(
    SESSION_IDLE_EVICT_MINUTES * 60_000,
    now,
    collectingKeys()
  );
  for (const key of evicted) {
    console.log(
      JSON.stringify({
        event: "topics.reaper.evict",
        key,
        idle_minutes: SESSION_IDLE_EVICT_MINUTES,
      })
    );
  }
  return evicted;
}

/**
 * Close topics untouched for TOPIC_IDLE_CLOSE_DAYS. `0` disables it.
 *
 * Returns how many were closed. Each one gets a note posted into it first: a
 * topic that simply vanishes from the active list looks like the bot lost it,
 * and the note is also the only place the user learns the conversation is still
 * resumable. Posted before the close because a closed topic may refuse new
 * messages.
 */
export async function closeIdleTopics(api: Api, now = Date.now()): Promise<number> {
  if (GROUP_CHAT_ID === null) return 0;
  if (!Number.isFinite(TOPIC_IDLE_CLOSE_DAYS) || TOPIC_IDLE_CLOSE_DAYS <= 0) return 0;

  const maxIdleMs = TOPIC_IDLE_CLOSE_DAYS * DAY_MS;

  let topics: topicsStore.TopicEntry[];
  try {
    topics = await topicsStore.list();
  } catch (err) {
    console.error(JSON.stringify({ event: "topics.reaper.read_failed", error: String(err) }));
    return 0;
  }

  let closed = 0;
  for (const t of topics) {
    if (t.closed) continue;

    const lastActive = new Date(t.last_active_at).getTime();
    // Unlike the cap, an unreadable timestamp here means "leave it alone": the
    // cap is choosing between topics and must pick someone, this is deciding
    // whether to take something away, and a corrupted field is not consent.
    if (!Number.isFinite(lastActive)) continue;

    const idleMs = now - lastActive;
    if (idleMs < maxIdleMs) continue;

    // A running query means someone is watching this topic answer right now,
    // whatever the stored timestamp says. Same for a burst still collecting —
    // which `last_active_at` cannot show, because it is only written once the
    // turn starts.
    const key = { chatId: t.chat_id, threadId: t.thread_id };
    if (registry.peek(key)?.isRunning) continue;
    if (isCollecting(key)) continue;

    const days = Math.floor(idleMs / DAY_MS);
    const res = await closeTopic(
      api,
      t,
      `idle ${days}d`,
      `🧵 Closing this topic — no activity for ${days} day${days === 1 ? "" : "s"}.\n` +
        "Reopen it from the topic menu to pick the conversation back up."
    );
    if (!res.ok) continue;

    closed++;
    await auditLog(
      0,
      "reaper",
      "TOPIC_IDLE_CLOSE",
      `${t.name} (thread ${t.thread_id}) idle_days=${days}`
    ).catch(() => {});
    console.log(
      JSON.stringify({
        event: "topics.reaper.close",
        thread_id: t.thread_id,
        name: t.name,
        idle_days: days,
      })
    );
  }

  return closed;
}

/** One full pass. Exported so tests can drive it without a timer. */
export async function topicReaperTick(api: Api, now = Date.now()): Promise<void> {
  if (GROUP_CHAT_ID === null) return;
  evictIdleSessions(now);
  await closeIdleTopics(api, now);
}

export function startTopicReaper(api: Api): void {
  if (GROUP_CHAT_ID === null) return;
  console.log(
    `[topics] lifecycle reaper every ${Math.round(TOPIC_REAPER_INTERVAL_MS / 60000)}m ` +
      `(evict sessions after ${SESSION_IDLE_EVICT_MINUTES}m, ` +
      `close topics after ${TOPIC_IDLE_CLOSE_DAYS > 0 ? `${TOPIC_IDLE_CLOSE_DAYS}d` : "never"})`
  );
  setInterval(() => {
    topicReaperTick(api).catch((err) => {
      console.error(JSON.stringify({ event: "topics.reaper.error", error: String(err) }));
    });
  }, TOPIC_REAPER_INTERVAL_MS);
}
