/**
 * Atomic, serialized store for the Claude session history
 * (`${BOT_DATA_DIR}/chat-session-history.json`).
 *
 * Same pattern as src/topics-store.ts and src/mode2/*-store.ts: one serial
 * write queue, tmp-write + atomic rename, empty default on ENOENT, corrupted
 * file moved aside rather than overwritten.
 *
 * Why it exists. The history used to be read synchronously and written with a
 * bare fire-and-forget `Bun.write` straight from `ClaudeSession.saveSession`,
 * with nothing serializing the gap between the read and the write. That was
 * safe only because there was exactly one conversation: grammY's per-chat
 * sequentializer made two concurrent saves impossible. Per-conversation
 * sessions removed that guarantee — two topics can finish queries in the same
 * tick, and then
 *
 *     A loads → B loads the same snapshot → A writes → B writes
 *
 * leaves a file that never contained A's entry. A restart in that window sends
 * topic A back to a fresh session: the same cross-conversation integrity
 * failure per-key resume exists to prevent, arrived at from the other side.
 *
 * So the read and the mutation happen inside one serialized critical section,
 * and the write is atomic — a crash mid-write can no longer truncate the file
 * that every conversation's resume depends on.
 */

import { readFileSync } from "fs";
import { readFile, writeFile, rename } from "fs/promises";
import { SESSION_FILE } from "./config";
import { convKeyStr } from "./conversation";
import type { SavedSession, SessionHistory } from "./types";

/**
 * How many saved sessions to keep per conversation.
 *
 * Was a single global cap of 5. Both numbers had to change once conversations
 * became plural: 5 was already tight for one chat, and a *global* cap lets one
 * busy conversation evict every other one's entries — twenty DM turns would
 * push a topic's only resumable session out of the file, and that topic would
 * silently start fresh on its next message with nothing logged. Capping per
 * ConversationKey makes each conversation's history independent of how chatty
 * the others are.
 */
const MAX_SESSIONS_PER_CONVERSATION = 20;

/**
 * File-size backstop across all conversations — a SOFT cap, deliberately.
 *
 * It is only ever applied to entries a conversation can afford to lose: each
 * conversation's most recent entry is exempt, because dropping it is exactly
 * the starvation MAX_SESSIONS_PER_CONVERSATION exists to prevent. So the real
 * floor is "one entry per conversation", and with more than this many
 * conversations the file legitimately exceeds the number: 300 conversations
 * holding one session each retain all 300. That is intended — the alternative
 * is silently making 100 conversations unresumable to save a few KB.
 */
const SESSION_HISTORY_SOFT_CAP = 200;

/** Grouping key for pruning — `convKeyStr` over a saved entry. */
function savedKeyStr(s: SavedSession): string {
  const chatId = s.chat_id ?? undefined;
  if (chatId === undefined) return "legacy";
  return convKeyStr({ chatId, threadId: s.thread_id ?? undefined });
}

/**
 * Trim the session history, newest-first order in and out.
 *
 * Per conversation first (MAX_SESSIONS_PER_CONVERSATION, a hard cap), then the
 * soft global cap (SESSION_HISTORY_SOFT_CAP), which drops oldest-first but
 * never a conversation's most recent entry. When every conversation holds a
 * single entry nothing is droppable and the result stays above the soft cap by
 * design — see the constant.
 */
export function pruneSessions(sessions: SavedSession[]): SavedSession[] {
  const perKey = new Map<string, number>();
  const kept: SavedSession[] = [];
  for (const s of sessions) {
    const k = savedKeyStr(s);
    const n = perKey.get(k) ?? 0;
    if (n >= MAX_SESSIONS_PER_CONVERSATION) continue;
    perKey.set(k, n + 1);
    kept.push(s);
  }

  if (kept.length <= SESSION_HISTORY_SOFT_CAP) return kept;

  // Mark each conversation's newest entry (its first occurrence in this
  // newest-first list) as exempt, then drop oldest-first from what remains.
  const seen = new Set<string>();
  const isNewestForKey = kept.map((s) => {
    const k = savedKeyStr(s);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  let over = kept.length - SESSION_HISTORY_SOFT_CAP;
  const survivors: SavedSession[] = [];
  for (let i = kept.length - 1; i >= 0; i--) {
    if (over > 0 && !isNewestForKey[i]) {
      over--;
      continue;
    }
    survivors.unshift(kept[i]!);
  }
  return survivors;
}

/**
 * Test seam: point the store at a scratch file so tests don't write into the
 * real BOT_DATA_DIR. Not called by the bot.
 */
let sessionFile: string = SESSION_FILE;
export function __setSessionFileForTests(path: string): void {
  sessionFile = path;
}

let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn);
  queue = result.catch(() => {});
  return result;
}

function parse(raw: string): SessionHistory {
  const parsed = JSON.parse(raw) as SessionHistory;
  if (!Array.isArray(parsed.sessions)) return { sessions: [] };
  return parsed;
}

async function load(): Promise<SessionHistory> {
  try {
    return parse(await readFile(sessionFile, "utf-8"));
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { sessions: [] };
    }
    // Only the write path backs up: returning an empty history and then saving
    // over it would destroy every conversation's resume point on a single
    // transient parse failure. Moved aside, the data is still there.
    const corrupted = `${sessionFile}.corrupted-${Date.now()}`;
    try {
      await rename(sessionFile, corrupted);
    } catch {
      /* best effort */
    }
    console.error(`[session-store] corrupted, backed up to ${corrupted}`);
    return { sessions: [] };
  }
}

/**
 * Read the history synchronously, for the read-only callers (`getSessionList`,
 * `resumeSession`, `adoptSession`). Read-only, so it needs no place in the
 * write queue — and unlike `load` it never moves a corrupted file aside, since
 * /status must not have side effects.
 */
export function loadHistorySync(): SessionHistory {
  try {
    return parse(readFileSync(sessionFile, "utf-8"));
  } catch {
    return { sessions: [] };
  }
}

async function save(data: SessionHistory): Promise<void> {
  const tmp = `${sessionFile}.tmp-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmp, sessionFile);
}

/**
 * Insert or update one session entry, then prune.
 *
 * The caller passes a fully-built entry rather than a mutator: the write runs
 * behind the queue, and by the time it does the originating ClaudeSession may
 * have been killed or moved on, so the entry has to describe the session as it
 * was when the save was requested.
 */
export function upsertSession(entry: SavedSession): Promise<void> {
  return enqueue(async () => {
    const data = await load();
    const idx = data.sessions.findIndex((s) => s.session_id === entry.session_id);
    if (idx !== -1) {
      data.sessions[idx] = entry;
    } else {
      data.sessions.unshift(entry);
    }
    data.sessions = pruneSessions(data.sessions);
    await save(data);
  });
}
