/**
 * Per-conversation ClaudeSession registry.
 *
 * Replaces the old module-scope singleton (`export const session` in
 * session.ts) with a map keyed by ConversationKey, so each chat/topic gets
 * its own independent ClaudeSession. With forum topics unused (threadId
 * always undefined), every lookup for a given chat returns the same
 * instance — identical to today's single-session behavior.
 */

import { ClaudeSession } from "./session";
import type { ConversationKey } from "./conversation";
import { convKeyStr } from "./conversation";

interface Entry {
  session: ClaudeSession;
  /**
   * When this instance was last handed out.
   *
   * The eviction clock needs a floor that exists before the first turn:
   * `ClaudeSession.lastActivity` is null on a fresh instance and again after
   * `kill()`, so a topic spawned-but-not-yet-used, or one just cleared with
   * /new, would otherwise read as infinitely idle and be evicted immediately.
   * Bumped by `get()` — every handler goes through it, so any command touching
   * a conversation (even /status) counts as keeping it alive.
   */
  lastAccess: number;
}

class SessionRegistry {
  private sessions = new Map<string, Entry>();

  get(key: ConversationKey): ClaudeSession {
    const k = convKeyStr(key);
    let e = this.sessions.get(k);
    if (!e) {
      // The key travels into the instance, not just the map: it is what
      // saveSession stamps onto history entries and what tryAutoResume filters
      // by, so a session must know which conversation it belongs to from the
      // moment it exists — before its first turn, which is when auto-resume
      // decides whether to inherit a transcript.
      e = { session: new ClaudeSession({ key }), lastAccess: Date.now() };
      this.sessions.set(k, e);
    } else {
      e.lastAccess = Date.now();
    }
    return e.session;
  }

  /**
   * Look up a live instance without creating one — and without counting as
   * activity.
   *
   * Both halves matter to the lifecycle layer, which asks "is anything running
   * in this topic?" about topics it is considering closing. `get()` would
   * materialise a session for every topic it scanned and then reset its idle
   * clock, so the reaper would resurrect exactly what it is trying to reap.
   */
  peek(key: ConversationKey): ClaudeSession | undefined {
    return this.sessions.get(convKeyStr(key))?.session;
  }

  async kill(key: ConversationKey): Promise<void> {
    const k = convKeyStr(key);
    const e = this.sessions.get(k);
    if (e) {
      await e.session.kill();
      this.sessions.delete(k);
    }
  }

  isAnyRunning(): boolean {
    for (const e of this.sessions.values()) {
      if (e.session.isRunning) return true;
    }
    return false;
  }

  /** How many conversations are held in memory. For logging and tests. */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Drop in-memory instances idle longer than `maxIdleMs`. Returns the keys
   * dropped, newest-first order not guaranteed.
   *
   * Invisible by design: a ClaudeSession between turns is just an object plus a
   * resumable `sessionId` that is already on disk, so the next message in that
   * conversation re-creates the instance and `tryAutoResume` — filtered by the
   * same ConversationKey — hands the SDK session straight back. Nothing is
   * killed here for that reason: `ClaudeSession.kill()` means "start fresh next
   * time", which is the opposite of what eviction wants. The instance is simply
   * forgotten.
   *
   * Three things are never evicted:
   *  - a session with a query in flight (or mid-`startProcessing`), which would
   *    orphan the running claude subprocess and its status callbacks;
   *  - a session holding an unconsumed /compact handoff, the one piece of state
   *    that lives only in memory and cost the user a turn to produce;
   *  - a conversation named in `pinned`, which is how the caller reports work
   *    this class cannot see. A conversation collecting a burst has no running
   *    query — that is the whole point of the collection window — so it reads
   *    as perfectly idle from here.
   */
  evictIdle(maxIdleMs: number, now = Date.now(), pinned?: ReadonlySet<string>): string[] {
    if (!Number.isFinite(maxIdleMs) || maxIdleMs <= 0) return [];

    const evicted: string[] = [];
    for (const [k, e] of this.sessions) {
      if (e.session.isRunning) continue;
      if (e.session.pendingHandoff) continue;
      if (pinned?.has(k)) continue;
      const last = Math.max(e.lastAccess, e.session.lastActivity?.getTime() ?? 0);
      if (now - last < maxIdleMs) continue;
      this.sessions.delete(k);
      evicted.push(k);
    }
    return evicted;
  }
}

export const registry = new SessionRegistry();
