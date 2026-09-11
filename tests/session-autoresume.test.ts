/**
 * Tests for who a ClaudeSession is allowed to auto-resume.
 *
 * Two invariants live here, and both are load-bearing for parallel topics:
 *
 *  - **Conversation scoping.** A session may only adopt a transcript saved
 *    under its own ConversationKey. Without this, a brand-new topic's first
 *    message picks up the globally newest session on disk and silently
 *    continues an unrelated conversation.
 *  - **`persist: false` never resumes.** The scheduler's ephemeral session
 *    cannot save, so it has nothing to continue.
 *
 * The on-disk history is stubbed per instance (`loadSessionHistory`), so the
 * real `getSessionList` filter runs and nothing touches the real
 * chat-session-history.json.
 *
 * Run with: bun test tests/session-autoresume.test.ts
 */

import { describe, test, expect } from "bun:test";
import { ClaudeSession, savedSessionMatchesKey } from "../src/session";
import { pruneSessions } from "../src/session-store";
import { classifyClaudeError } from "../src/utils";
import { ALLOWED_USER, WORKING_DIR } from "../src/config";
import type { ConversationKey } from "../src/conversation";
import type { SavedSession, SessionHistory } from "../src/types";

/** The one conversation the bot had before topics: the DM, no thread. */
const DM: ConversationKey = { chatId: ALLOWED_USER, threadId: undefined };
const GROUP = -1002222222222;
const TOPIC_A: ConversationKey = { chatId: GROUP, threadId: 11 };
const TOPIC_B: ConversationKey = { chatId: GROUP, threadId: 22 };
/** The supergroup's General topic — normalized to "no thread", like a DM. */
const GENERAL: ConversationKey = { chatId: GROUP, threadId: undefined };

/** A history entry written before chat_id/thread_id existed. */
function legacy(id: string, ageMs = 60_000): SavedSession {
  return {
    session_id: id,
    saved_at: new Date(Date.now() - ageMs).toISOString(),
    title: `title for ${id}`,
    working_dir: WORKING_DIR,
  };
}

/** A history entry written by the current code, stamped with its owner. */
function saved(id: string, key: ConversationKey, ageMs = 60_000): SavedSession {
  return { ...legacy(id, ageMs), chat_id: key.chatId, thread_id: key.threadId };
}

/** A session for `key` whose on-disk history is a fixed list. */
function sessionFor(
  key: ConversationKey | undefined,
  ...list: SavedSession[]
): ClaudeSession {
  const s = new ClaudeSession({ key });
  (
    s as unknown as { loadSessionHistory: () => SessionHistory }
  ).loadSessionHistory = () => ({ sessions: list });
  return s;
}

describe("tryAutoResume", () => {
  test("a fresh instance adopts its own conversation's newest session", () => {
    const s = sessionFor(DM, legacy("sess-newest"));

    s.tryAutoResume();

    // Not a bug to defend against — this is what makes a restart continue the
    // DM conversation the user was in.
    expect(s.sessionId).toBe("sess-newest");
    expect(s.isActive).toBe(true);
  });

  test("after kill() it does NOT adopt anything — this is what 'start fresh' means", async () => {
    const s = sessionFor(DM, legacy("sess-newest"));

    await s.kill();
    s.tryAutoResume();

    expect(s.sessionId).toBeNull();
    expect(s.isActive).toBe(false);
  });

  test("the kill() suppression is one-shot, but the key filter behind it is not", async () => {
    const s = sessionFor(DM, legacy("sess-newest"));

    await s.kill();
    s.tryAutoResume();
    expect(s.sessionId).toBeNull();

    // Second turn of the same instance — the in-memory flag is spent. It only
    // ever guarded THIS conversation's own history, which is legitimate to
    // resume; what must never happen (another conversation's session) is now
    // prevented by the key filter, which survives restarts and eviction.
    s.tryAutoResume();
    expect(s.sessionId).toBe("sess-newest");
  });

  test("an already-active session is never re-pointed at another one", () => {
    const s = sessionFor(DM, legacy("sess-newest"));
    s.sessionId = "sess-current";

    s.tryAutoResume();

    expect(s.sessionId).toBe("sess-current");
  });

  test("nothing to resume leaves the session inactive", () => {
    const empty = sessionFor(DM);
    empty.tryAutoResume();
    expect(empty.sessionId).toBeNull();

    // Stale beyond the 24h TTL is treated the same way.
    const stale = sessionFor(DM, legacy("sess-old", 48 * 60 * 60 * 1000));
    stale.tryAutoResume();
    expect(stale.sessionId).toBeNull();
  });
});

// ── the resume window is per conversation kind ────────────────────────────────

/** The notice the next turn will show the user, if any. */
function notice(s: ClaudeSession): string | null {
  return (s as unknown as { _pendingAutoResumeNotice: string | null })
    ._pendingAutoResumeNotice;
}

const HOUR = 60 * 60 * 1000;

describe("auto-resume window differs for topics and DMs", () => {
  // The reported bug: a "Daily focus" topic idle ~31h answered from an empty
  // context. A DM is a rolling scratchpad where a day-old resume is confusing;
  // a topic is a named thread the user opens deliberately and closes by hand,
  // and continuing it next week is the whole point of having topics.
  test("a topic resumes across a gap that would expire a DM", () => {
    const dm = sessionFor(DM, saved("sess-dm", DM, 31 * HOUR));
    dm.tryAutoResume();
    expect(dm.sessionId).toBeNull();

    const topic = sessionFor(TOPIC_A, saved("sess-topic", TOPIC_A, 31 * HOUR));
    topic.tryAutoResume();
    expect(topic.sessionId).toBe("sess-topic");
  });

  test("a topic still expires eventually", () => {
    // Past the 720h topic window. The wall exists because Claude Code deletes
    // its own transcripts after ~30 days, so a longer window would only mint
    // session ids that fail on use.
    const s = sessionFor(TOPIC_A, saved("sess-ancient", TOPIC_A, 800 * HOUR));
    s.tryAutoResume();
    expect(s.sessionId).toBeNull();
  });

  test("General topic is on the DM window, matching its shared key", () => {
    // GENERAL normalizes to threadId undefined, so it must behave like the DM
    // everywhere — including here.
    const s = sessionFor(GENERAL, saved("sess-general", GENERAL, 31 * HOUR));
    s.tryAutoResume();
    expect(s.sessionId).toBeNull();
  });
});

// ── declining to resume is never silent ──────────────────────────────────────

describe("a declined auto-resume tells the user", () => {
  // The actual cost of the original bug was not the fresh context — it was that
  // nothing said so, so the user spent a conversation asking a bot with no
  // memory what it remembered.
  test("an expired session leaves a notice pointing at /resume", () => {
    const s = sessionFor(DM, saved("sess-old", DM, 31 * HOUR));
    s.tryAutoResume();

    const n = notice(s);
    expect(n).toContain("started fresh");
    expect(n).toContain("/resume");
  });

  // No notice for an errored history, deliberately: getSessionList drops those
  // entries for /resume too, so there would be nothing to point the user at.
  test("an errored-only history stays silent", () => {
    const s = sessionFor(TOPIC_A, { ...saved("sess-bad", TOPIC_A), errored: true });
    s.tryAutoResume();

    expect(s.sessionId).toBeNull();
    expect(notice(s)).toBeNull();
  });

  test("an empty history stays silent — there is nothing to report", () => {
    const s = sessionFor(TOPIC_A);
    s.tryAutoResume();
    expect(notice(s)).toBeNull();
  });

  test("a successful resume still reports what it resumed", () => {
    const s = sessionFor(TOPIC_A, saved("sess-ok", TOPIC_A, 2 * HOUR));
    s.tryAutoResume();
    expect(notice(s)).toContain("resumed");
  });
});

describe("tryAutoResume is scoped to one conversation", () => {
  test("a topic resumes its own session", () => {
    const s = sessionFor(TOPIC_A, saved("sess-b", TOPIC_B), saved("sess-a", TOPIC_A));

    s.tryAutoResume();

    // Note sess-b is FIRST in the list (newest). Global "newest wins" would
    // have picked it; the key filter removes it from consideration entirely.
    expect(s.sessionId).toBe("sess-a");
  });

  test("a topic does not resume another topic's session", () => {
    const s = sessionFor(TOPIC_A, saved("sess-b", TOPIC_B));

    s.tryAutoResume();

    expect(s.sessionId).toBeNull();
  });

  test("a topic does not resume the DM's session", () => {
    const s = sessionFor(TOPIC_A, saved("sess-dm", DM), legacy("sess-legacy"));

    s.tryAutoResume();

    expect(s.sessionId).toBeNull();
  });

  test("the DM does not resume a topic's session", () => {
    const s = sessionFor(DM, saved("sess-a", TOPIC_A));

    s.tryAutoResume();

    expect(s.sessionId).toBeNull();
  });

  test("a brand-new topic with a full history of other conversations starts fresh", () => {
    // The exact scenario the spawn path used to paper over with kill(): a topic
    // that has never held a conversation, created after a restart, with plenty
    // of other sessions on disk.
    const s = sessionFor(
      { chatId: GROUP, threadId: 99 },
      saved("sess-a", TOPIC_A),
      saved("sess-b", TOPIC_B),
      saved("sess-dm", DM),
      legacy("sess-legacy")
    );

    s.tryAutoResume();

    expect(s.sessionId).toBeNull();
  });
});

describe("persist: false never auto-resumes", () => {
  test("the scheduler's ephemeral session does not adopt the newest conversation", () => {
    // The pre-existing bug this closes: persist:false stopped the ephemeral
    // session WRITING history but not READING it, so every scheduled routine
    // ran inside — and advanced — the user's newest conversation.
    const s = new ClaudeSession({ persist: false });
    (
      s as unknown as { loadSessionHistory: () => SessionHistory }
    ).loadSessionHistory = () => ({ sessions: [legacy("sess-newest")] });

    s.tryAutoResume();

    expect(s.sessionId).toBeNull();
    expect(s.isActive).toBe(false);
  });

  test("not even for a session that does carry a conversation key", () => {
    const s = new ClaudeSession({ persist: false, key: DM });
    (
      s as unknown as { loadSessionHistory: () => SessionHistory }
    ).loadSessionHistory = () => ({ sessions: [legacy("sess-newest")] });

    s.tryAutoResume();

    expect(s.sessionId).toBeNull();
  });
});

describe("savedSessionMatchesKey", () => {
  test("a legacy entry belongs to the DM conversation and nowhere else", () => {
    const e = legacy("x");
    expect(savedSessionMatchesKey(e, DM)).toBe(true);
    expect(savedSessionMatchesKey(e, TOPIC_A)).toBe(false);
    // Same chat as no topic, but not the DM: the supergroup's General topic
    // is still a different conversation from the pre-topics DM.
    expect(savedSessionMatchesKey(e, GENERAL)).toBe(false);
  });

  test("a keyed entry matches only the identical key", () => {
    const e = saved("x", TOPIC_A);
    expect(savedSessionMatchesKey(e, TOPIC_A)).toBe(true);
    expect(savedSessionMatchesKey(e, TOPIC_B)).toBe(false);
    expect(savedSessionMatchesKey(e, GENERAL)).toBe(false);
    expect(savedSessionMatchesKey(e, DM)).toBe(false);
  });

  test("a chat-only entry means 'no topic', never 'any topic'", () => {
    const e = saved("x", GENERAL);
    expect(savedSessionMatchesKey(e, GENERAL)).toBe(true);
    expect(savedSessionMatchesKey(e, TOPIC_A)).toBe(false);
  });

  test("no key at all means no conversation filter", () => {
    expect(savedSessionMatchesKey(saved("x", TOPIC_A), undefined)).toBe(true);
    expect(savedSessionMatchesKey(legacy("y"), undefined)).toBe(true);
  });
});

describe("getSessionList", () => {
  test("lists only the caller's conversation, newest first", () => {
    const s = sessionFor(
      TOPIC_A,
      saved("a2", TOPIC_A),
      saved("b1", TOPIC_B),
      saved("a1", TOPIC_A, 120_000)
    );

    expect(s.getSessionList().map((x) => x.session_id)).toEqual(["a2", "a1"]);
    // An explicit key overrides the instance's own — this is what /resume and
    // /status pass.
    expect(s.getSessionList(TOPIC_B).map((x) => x.session_id)).toEqual(["b1"]);
    // Passing undefined re-selects the default rather than unscoping: a keyed
    // instance cannot be talked into a global list.
    expect(s.getSessionList(undefined).map((x) => x.session_id)).toEqual(["a2", "a1"]);
  });

  test("an instance with no key at all sees the whole file", () => {
    const s = sessionFor(undefined, saved("a1", TOPIC_A), legacy("l1"));
    expect(s.getSessionList().length).toBe(2);
  });

  test("a session saved for another working dir is still excluded", () => {
    const s = sessionFor(TOPIC_A, {
      ...saved("elsewhere", TOPIC_A),
      working_dir: "/somewhere/else",
    });

    expect(s.getSessionList()).toEqual([]);
  });
});

describe("adoptSession", () => {
  test("pre-seeds an id and then blocks auto-resume", () => {
    const s = sessionFor(TOPIC_A, saved("sess-a", TOPIC_A));

    expect(s.adoptSession("sess-from-topics-json", "Visa paperwork")).toBe(true);
    expect(s.sessionId).toBe("sess-from-topics-json");
    expect(s.conversationTitle).toBe("Visa paperwork");

    // Boot re-registration and auto-resume must not both fire.
    s.tryAutoResume();
    expect(s.sessionId).toBe("sess-from-topics-json");
  });

  test("refuses to clobber a live session, and refuses an errored id", () => {
    const live = sessionFor(TOPIC_A);
    live.sessionId = "sess-live";
    expect(live.adoptSession("sess-other")).toBe(false);
    expect(live.sessionId).toBe("sess-live");

    const errored = sessionFor(TOPIC_A, {
      ...saved("sess-bad", TOPIC_A),
      errored: true,
    });
    expect(errored.adoptSession("sess-bad")).toBe(false);
    expect(errored.sessionId).toBeNull();
  });
});

describe("pruneSessions", () => {
  test("keeps the 20 most recent per conversation, not globally", () => {
    // 25 DM turns plus one quiet topic. Under a global cap of 20 the topic's
    // only session would be evicted and that topic would silently start fresh.
    const history: SavedSession[] = [];
    for (let i = 0; i < 25; i++) history.push(saved(`dm-${i}`, DM, i * 1000));
    history.push(saved("topic-only", TOPIC_A, 999_000));

    const kept = pruneSessions(history);
    const ids = kept.map((s) => s.session_id);

    expect(ids).toContain("topic-only");
    expect(ids.filter((id) => id.startsWith("dm-")).length).toBe(20);
    // Oldest DM entries are the ones dropped.
    expect(ids).toContain("dm-0");
    expect(ids).not.toContain("dm-24");
  });

  test("legacy entries are one conversation of their own", () => {
    const history = [legacy("l1"), saved("a1", TOPIC_A), legacy("l2")];
    expect(pruneSessions(history).length).toBe(3);
  });

  test("the global cap is SOFT: one entry per conversation is never droppable", () => {
    // 300 conversations holding a single session each. Every entry is its
    // conversation's newest, so nothing is eligible to drop and the result
    // legitimately exceeds the 200 soft cap. Pinned deliberately: the
    // alternative — enforcing 200 — would make 100 conversations unresumable.
    const history: SavedSession[] = [];
    for (let c = 0; c < 300; c++) {
      history.push(saved(`c${c}-only`, { chatId: GROUP, threadId: c + 1 }));
    }

    expect(pruneSessions(history).length).toBe(300);
  });

  test("the global cap never drops a conversation's newest entry", () => {
    // 30 conversations × 20 sessions = 600, well past the 200 ceiling.
    const history: SavedSession[] = [];
    for (let c = 0; c < 30; c++) {
      for (let i = 0; i < 20; i++) {
        history.push(saved(`c${c}-s${i}`, { chatId: GROUP, threadId: c + 1 }, i * 1000));
      }
    }

    const kept = pruneSessions(history);
    const ids = new Set(kept.map((s) => s.session_id));

    expect(kept.length).toBe(200);
    for (let c = 0; c < 30; c++) {
      // s0 is the most recent for each conversation (ageMs 0).
      expect(ids.has(`c${c}-s0`)).toBe(true);
    }
  });
});

// ── error classification for a collected transcript ──────────────────────────

describe("session_gone classification", () => {
  // What makes the long topic window safe: a session id inside the window whose
  // transcript Claude Code has already collected fails on use, and the session
  // has to drop it rather than retry it forever.
  test("recognises the SDK's missing-conversation errors", () => {
    expect(classifyClaudeError(new Error("No conversation found with session ID: abc"))).toBe(
      "session_gone",
    );
    expect(classifyClaudeError(new Error("Session ID abc was not found"))).toBe("session_gone");
  });

  test("does not claim tmux's 'no such session'", () => {
    // A false positive here kills a healthy session, and this is mode 2's
    // wording for a missing RC host — it must stay generic.
    expect(classifyClaudeError(new Error("no such session: claude-rc-foo"))).toBe("generic");
  });

  test("leaves the other kinds alone", () => {
    expect(classifyClaudeError(new Error("prompt is too long"))).toBe("context_limit");
    expect(classifyClaudeError(new Error("AbortError: operation cancelled"))).toBe("cancellation");
    expect(classifyClaudeError(new Error("something else broke"))).toBe("generic");
  });
});
