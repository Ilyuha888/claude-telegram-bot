/**
 * Tests for `resumeOnBoot` (src/mode2/reaper.ts) and the tmux-server helpers it
 * depends on (src/mode2/sh.ts).
 *
 * The contract that matters here: a failed respawn must only retire the session
 * record when the failure is TERMINAL. Now that RC hosts outlive the bot (they
 * live in claude-rc-tmux.service's cgroup, not the bot's), the common failure is
 * "that session already exists" — and retiring the record on that would orphan a
 * healthy, running host, because /sessions, /attach and /close all filter on
 * `closed`. The same applies when the spawn guard refuses because the tmux server
 * is missing or mis-placed.
 *
 * `sh`, `store`, `auditLog` and `loadRuntimeConfig` are module-mocked; reaper runs
 * for real.
 *
 * Bun's module mocks are process-wide and keyed by resolved path — they do NOT
 * end with this file. Two precautions, both load-bearing: each mock spreads the
 * real module so no export goes missing, and afterAll puts the real namespaces
 * back. (See tests/close-command.test.ts for the same dance.)
 *
 * Run with: bun test tests/reaper-resume.test.ts
 */

import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import type { ShResult } from "../src/mode2/types";
import {
  TMUX_SERVER_UNAVAILABLE,
  isTransientSpawnFailure,
  buildNewSessionArgs,
  buildSetEnvArgs,
  rcHostEnvironment,
} from "../src/mode2/sh";

// Snapshots, not the namespace objects: mock.module mutates the live namespace,
// so holding a reference would hand back the *mocked* functions in afterAll and
// restore nothing.
const realSh = { ...(await import("../src/mode2/sh")) };
const realStore = { ...(await import("../src/mode2/store")) };
const realUtils = { ...(await import("../src/utils")) };
const realRuntimeConfig = { ...(await import("../src/runtime-config")) };

afterAll(() => {
  mock.module("../src/mode2/sh", () => ({ ...realSh }));
  mock.module("../src/mode2/store", () => ({ ...realStore }));
  mock.module("../src/utils", () => ({ ...realUtils }));
  mock.module("../src/runtime-config", () => ({ ...realRuntimeConfig }));
});

const ok: ShResult = { ok: true, stdout: "", stderr: "", code: 0 };
function fail(stderr: string): ShResult {
  return { ok: false, stdout: "", stderr, code: 1 };
}

function session(over: Partial<Record<string, unknown>> = {}) {
  return {
    slug: "bot-abc123",
    repo: "claude-telegram-bot",
    path: "/home/user/repos/claude-telegram-bot",
    worktree_path: null,
    branch: null,
    tmux_name: "work-bot-abc123",
    rc_name: "bot-abc123",
    created_at: "2026-07-20T10:00:00.000Z",
    last_attached_at: "2026-07-20T10:00:00.000Z",
    closed: false,
    ...over,
  };
}

// --- mutable mock state ------------------------------------------------------

let sessions: ReturnType<typeof session>[] = [];
let hasSession = false;
let spawnResult: ShResult = ok;
const spawns: { name: string; cwd: string; rcName: string; model?: string }[] = [];
const closed: { slug: string; reason: string }[] = [];
const touched: string[] = [];

mock.module("../src/mode2/store", () => ({
  ...realStore,
  list: async () => sessions,
  markClosed: async (slug: string, reason: string) => {
    closed.push({ slug, reason });
  },
  touch: async (slug: string) => {
    touched.push(slug);
  },
}));

mock.module("../src/mode2/sh", () => ({
  ...realSh,
  tmuxHasSession: async () => hasSession,
  tmuxNewSession: async (name: string, cwd: string, rcName: string, model?: string) => {
    spawns.push({ name, cwd, rcName, model });
    return spawnResult;
  },
}));

mock.module("../src/utils", () => ({
  ...realUtils,
  auditLog: async () => {},
}));

mock.module("../src/runtime-config", () => ({
  ...realRuntimeConfig,
  loadRuntimeConfig: async () => ({ model: "claude-test-model" }),
}));

const { resumeOnBoot } = await import("../src/mode2/reaper");

beforeEach(() => {
  sessions = [session()];
  hasSession = false;
  spawnResult = ok;
  spawns.length = 0;
  closed.length = 0;
  touched.length = 0;
});

// ---------------------------------------------------------------------------

describe("resumeOnBoot — a surviving host is left alone", () => {
  test("a live tmux session is not respawned", async () => {
    hasSession = true;

    await resumeOnBoot();

    // The whole point of the detachment work: after a bot restart the host is
    // still there, so there is nothing to resume.
    expect(spawns).toEqual([]);
    expect(closed).toEqual([]);
  });

  test("a closed record is skipped entirely", async () => {
    sessions = [session({ closed: true })];

    await resumeOnBoot();

    expect(spawns).toEqual([]);
    expect(closed).toEqual([]);
  });
});

describe("resumeOnBoot — failures that must NOT retire the record", () => {
  test("'duplicate session' leaves the record open", async () => {
    // tmux reports this when the session already exists — i.e. a healthy host is
    // running. Closing the record here would make it unreachable by /sessions,
    // /attach and /close while the process keeps burning tokens.
    spawnResult = fail("duplicate session: work-bot-abc123");

    await resumeOnBoot();

    expect(closed).toEqual([]);
  });

  test("the spawn guard refusing leaves the record open", async () => {
    spawnResult = fail(`${TMUX_SERVER_UNAVAILABLE} no tmux server is running`);

    await resumeOnBoot();

    expect(closed).toEqual([]);
  });

  test("the tmux server being down leaves the record open", async () => {
    spawnResult = fail("no server running on /tmp/tmux-1000/default");

    await resumeOnBoot();

    expect(closed).toEqual([]);
  });
});

describe("resumeOnBoot — failures that SHOULD retire the record", () => {
  test("a genuinely broken spawn still closes the record", async () => {
    // A working directory that no longer exists can never succeed on retry, so
    // the record should not linger forever.
    spawnResult = fail("can't establish current directory: No such file or directory");

    await resumeOnBoot();

    expect(closed).toEqual([{ slug: "bot-abc123", reason: "boot_resume_failed" }]);
  });
});

describe("resumeOnBoot — idle clock", () => {
  test("a successful respawn resets last_attached_at", async () => {
    // Otherwise the 7-day idle threshold is still measured from the last
    // /attach, so a session resumed after a long gap is reaped by the next tick
    // despite having just been rebuilt.
    await resumeOnBoot();

    expect(spawns.length).toBe(1);
    expect(touched).toEqual(["bot-abc123"]);
  });

  test("a failed respawn does not reset it", async () => {
    spawnResult = fail("duplicate session: work-bot-abc123");

    await resumeOnBoot();

    expect(touched).toEqual([]);
  });

  test("the configured model is passed through to the spawn", async () => {
    await resumeOnBoot();

    expect(spawns[0]!.model).toBe("claude-test-model");
  });
});

// ---------------------------------------------------------------------------
// sh.ts pure helpers
// ---------------------------------------------------------------------------

describe("isTransientSpawnFailure", () => {
  test.each([
    ["duplicate session: work-foo", true],
    ["DUPLICATE SESSION: work-foo", true],
    [`${TMUX_SERVER_UNAVAILABLE} whatever detail`, true],
    ["no server running on /tmp/tmux-1000/default", true],
    ["error connecting to /tmp/tmux-1000/default", true],
    ["can't establish current directory", false],
    ["", false],
  ])("%p -> %p", (stderr, expected) => {
    expect(isTransientSpawnFailure(stderr as string)).toBe(expected);
  });
});

describe("buildNewSessionArgs", () => {
  test("builds a detached session with cwd and the RC command last", () => {
    const args = buildNewSessionArgs("/usr/bin/tmux", "/bin/claude", "work-x", "/repo", "x");

    expect(args.slice(0, 5)).toEqual(["/usr/bin/tmux", "new-session", "-d", "-s", "work-x"]);
    expect(args).toContain("-c");
    expect(args[args.length - 2]).toBe("/repo");
    expect(args[args.length - 1]).toBe(
      "'/bin/claude' remote-control --name 'x' --spawn same-dir --capacity 1"
    );
  });

  test("injects the model as session env, since remote-control has no --model", () => {
    const args = buildNewSessionArgs("tmux", "claude", "work-x", "/repo", "x", "some-model");

    expect(args).toContain("-e");
    expect(args).toContain("ANTHROPIC_MODEL=some-model");
  });

  test("omits the env flag entirely when no model is given", () => {
    const args = buildNewSessionArgs("tmux", "claude", "work-x", "/repo", "x");

    expect(args).not.toContain("-e");
    expect(args.join(" ")).not.toContain("ANTHROPIC_MODEL");
  });
});

describe("buildSetEnvArgs", () => {
  test("targets the server's global environment", () => {
    // -g matters: without it the value lands on one session instead of becoming
    // the default every future session inherits.
    expect(buildSetEnvArgs("tmux", "PATH", "/a:/b")).toEqual([
      "tmux",
      "set-environment",
      "-g",
      "PATH",
      "/a:/b",
    ]);
  });
});

describe("rcHostEnvironment", () => {
  test("carries no secrets", () => {
    // RC hosts used to inherit the bot's whole .env, so the Telegram token and
    // the OpenAI key sat in every host's /proc/<pid>/environ. Neither is needed:
    // `claude remote-control` authenticates through ~/.claude, and the OpenAI key
    // belongs to the bot's own voice path.
    const keys = Object.keys(rcHostEnvironment());

    expect(keys).not.toContain("TELEGRAM_BOT_TOKEN");
    expect(keys).not.toContain("OPENAI_API_KEY");
    expect(keys.sort()).toEqual(["ALLOWED_PATHS", "CLAUDE_CODE_PATH", "HOME", "PATH"]);
  });

  test("does not carry the model, which is per-session", () => {
    expect(Object.keys(rcHostEnvironment())).not.toContain("ANTHROPIC_MODEL");
  });
});
