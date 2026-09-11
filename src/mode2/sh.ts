import { readFileSync } from "fs";
import type { ShResult } from "./types";
import { TmuxMissing } from "./errors";
import { ALLOWED_PATHS } from "../config";

let _tmuxPath: string | null | undefined = undefined;
let _claudePath: string | null | undefined = undefined;

function getTmux(): string {
  if (_tmuxPath === undefined) {
    _tmuxPath = Bun.which("tmux") ?? null;
  }
  if (!_tmuxPath) throw new TmuxMissing();
  return _tmuxPath;
}

function getClaude(): string {
  if (_claudePath === undefined) {
    _claudePath =
      Bun.which("claude") ??
      process.env.CLAUDE_CLI_PATH ??
      process.env.CLAUDE_CODE_PATH ??
      null;
  }
  return _claudePath ?? "claude"; // fall back to bare name if not found
}

async function run(cmd: string[]): Promise<ShResult> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), code };
}

export async function tmuxHasSession(name: string): Promise<boolean> {
  const r = await run([getTmux(), "has-session", "-t", name]);
  return r.ok;
}

// ============== The external tmux server (claude-rc-tmux.service) ==============

/**
 * Marker prefix on the stderr of a refused spawn, so callers can tell "the
 * long-lived tmux server isn't reachable" (transient — retry later, keep the
 * session record open) apart from a genuine spawn failure. `resumeOnBoot` in
 * reaper.ts keys its close-or-not decision off this; see isTransientSpawnFailure.
 */
export const TMUX_SERVER_UNAVAILABLE = "claude-rc-tmux-unavailable:";

/** tmux's own wording when no server owns the socket. Both forms occur. */
const NO_SERVER_RE = /no server running|error connecting/i;

/**
 * The environment RC hosts need — and deliberately nothing else.
 *
 * A tmux server freezes its global environment from whichever client first
 * started it. While the bot started the server, that meant every RC host
 * inherited the bot's entire .env, so `TELEGRAM_BOT_TOKEN` and `OPENAI_API_KEY`
 * sat in each host's /proc/<pid>/environ for anything in the session to read.
 * Now the server comes from claude-rc-tmux.service with a bare environment and
 * the bot pushes back only these four. Neither secret is here on purpose:
 * `claude remote-control` authenticates through ~/.claude, and OPENAI_API_KEY
 * belongs to the bot's own voice path.
 *
 * ANTHROPIC_MODEL is absent too — it is per-session, passed via
 * `tmux new-session -e` below, because sessions can disagree about the model.
 */
export function rcHostEnvironment(): Record<string, string> {
  return {
    HOME: process.env.HOME ?? "",
    // config.ts rewrites process.env.PATH at import to prepend ~/.local/bin and
    // ~/.bun/bin, so this is the augmented value, not the unit's bare PATH.
    PATH: process.env.PATH ?? "",
    CLAUDE_CODE_PATH: getClaude(),
    ALLOWED_PATHS: ALLOWED_PATHS.join(","),
  };
}

/** Pure: the argv for one `set-environment -g` call. Split out to be testable. */
export function buildSetEnvArgs(tmux: string, key: string, value: string): string[] {
  return [tmux, "set-environment", "-g", key, value];
}

/**
 * Publish `rcHostEnvironment()` into the tmux server's global environment, so
 * sessions created afterwards inherit it.
 *
 * Affects FUTURE sessions only — a host already running keeps the environment it
 * was forked with, which is why a .env change needs the tmux unit restarted (and
 * that kills sessions) rather than just the bot.
 *
 * Never throws and never blocks boot: the server legitimately may not be up yet
 * on a cold start, and the spawn-time guard below is what actually protects
 * correctness. Must be awaited BEFORE resumeOnBoot(), or the first resumed hosts
 * are forked from an unpopulated environment.
 */
export async function pushTmuxEnvironment(): Promise<void> {
  let tmux: string;
  try {
    tmux = getTmux();
  } catch {
    return; // no tmux at all: mode 2 is unavailable anyway
  }

  for (const [key, value] of Object.entries(rcHostEnvironment())) {
    if (!value) continue;
    const r = await run(buildSetEnvArgs(tmux, key, value));
    if (!r.ok) {
      console.warn(`[mode2] tmux set-environment -g ${key} failed: ${r.stderr}`);
    }
  }
}

/** Read a process's cgroup line, or null when /proc is unavailable (macOS dev). */
function cgroupOf(pid: number | "self"): string | null {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, "utf-8").trim();
  } catch {
    return null;
  }
}

/**
 * Ask the running tmux server for its own pid.
 *
 * `list-sessions` is tried first because it is a safe probe: with no server it
 * fails without starting one. `display-message` is the fallback for a server
 * that is up but has zero sessions (possible now that `tmux -D` disables
 * exit-empty), where list-sessions prints nothing.
 *
 * Returns null when the pid can't be established — which is treated as
 * "unknown", not "bad".
 */
async function tmuxServerPid(tmux: string): Promise<{ pid: number | null; noServer: boolean }> {
  const listed = await run([tmux, "list-sessions", "-F", "#{pid}"]);
  if (!listed.ok && NO_SERVER_RE.test(listed.stderr)) {
    return { pid: null, noServer: true };
  }

  const fromList = parseInt(listed.stdout.split("\n")[0] ?? "", 10);
  if (Number.isFinite(fromList) && fromList > 0) return { pid: fromList, noServer: false };

  const shown = await run([tmux, "display-message", "-p", "#{pid}"]);
  if (!shown.ok && NO_SERVER_RE.test(shown.stderr)) {
    return { pid: null, noServer: true };
  }
  const fromShow = parseInt(shown.stdout.trim(), 10);
  return { pid: Number.isFinite(fromShow) && fromShow > 0 ? fromShow : null, noServer: false };
}

/**
 * Refuse to create a session unless the tmux server lives OUTSIDE this process's
 * cgroup.
 *
 * This guards the one way the original bug returns silently. `tmux new-session`
 * will happily start a server if none is running — and that server, forked from
 * the bot, lands in the bot's cgroup, so every pane it owns dies on the next
 * `systemctl restart claude-telegram-bot` exactly as before. Nothing about that
 * failure is visible: the spawn succeeds and the session works until the next
 * restart.
 *
 * Returns null when the spawn may proceed, or an ShResult to hand straight back
 * to the caller when it may not.
 */
async function assertTmuxServerExternal(tmux: string): Promise<ShResult | null> {
  const { pid, noServer } = await tmuxServerPid(tmux);

  if (noServer) {
    const detail =
      "no tmux server is running, and starting one from the bot would put every " +
      "RC host back in the bot's cgroup (killed on the next restart). " +
      "Start it with: sudo systemctl start claude-rc-tmux";
    console.error(
      JSON.stringify({ event: "mode2.tmux.no_server", remedy: "systemctl start claude-rc-tmux" })
    );
    return { ok: false, stdout: "", stderr: `${TMUX_SERVER_UNAVAILABLE} ${detail}`, code: 1 };
  }

  // pid unknown, or /proc unreadable: can't prove anything either way, so warn
  // rather than block. Refusing here would take mode 2 down on any platform
  // without /proc, where this bug doesn't exist in the first place.
  if (pid === null) return null;
  const server = cgroupOf(pid);
  const self = cgroupOf("self");
  if (server === null || self === null) {
    console.warn("[mode2] could not read /proc cgroups; skipping tmux cgroup check");
    return null;
  }

  if (server === self) {
    const detail =
      `the tmux server (pid ${pid}) shares this process's cgroup (${self}), so its ` +
      "sessions would be killed by a bot restart. This means claude-rc-tmux.service " +
      "is not running and a server was started from the bot instead. Fix with: " +
      "sudo systemctl restart claude-rc-tmux (kills existing sessions)";
    console.error(
      JSON.stringify({
        event: "mode2.tmux.in_service_cgroup",
        server_pid: pid,
        cgroup: self,
        remedy: "systemctl restart claude-rc-tmux",
      })
    );
    return { ok: false, stdout: "", stderr: `${TMUX_SERVER_UNAVAILABLE} ${detail}`, code: 1 };
  }

  return null;
}

/** True when a failed tmuxNewSession should NOT retire the session record. */
export function isTransientSpawnFailure(stderr: string): boolean {
  // The guard refused: the server is missing or mis-placed. The record is fine.
  if (stderr.includes(TMUX_SERVER_UNAVAILABLE)) return true;
  // The session is already there — the normal case now that hosts outlive the
  // bot. Retiring the record here would orphan a healthy, running host.
  if (/duplicate session/i.test(stderr)) return true;
  // Server went away between the guard and the spawn, or is mid-restart.
  if (NO_SERVER_RE.test(stderr)) return true;
  return false;
}

/** Pure: the argv for a new RC session. Split out so the shape is testable. */
export function buildNewSessionArgs(
  tmux: string,
  claude: string,
  name: string,
  cwd: string,
  rcName: string,
  model?: string
): string[] {
  const cmd = `'${claude}' remote-control --name '${rcName}' --spawn same-dir --capacity 1`;
  const args = [tmux, "new-session", "-d", "-s", name];
  if (model) args.push("-e", `ANTHROPIC_MODEL=${model}`);
  args.push("-c", cwd, cmd);
  return args;
}

/**
 * Spawn a Claude Code remote-control server under tmux.
 *
 * `model` is injected as ANTHROPIC_MODEL via `tmux new-session -e` (tmux >= 3.0)
 * rather than a flag: the `remote-control` subcommand has no `--model`. Without
 * it the session silently inherits whatever ~/.claude/settings.json happens to
 * say, which is how mode 1 and mode 2 drifted onto different models.
 *
 * Refuses when the tmux server is missing or shares this cgroup — see
 * assertTmuxServerExternal. Callers get a normal !ok ShResult; those that retire
 * session records must first check isTransientSpawnFailure.
 */
export async function tmuxNewSession(
  name: string,
  cwd: string,
  rcName: string,
  model?: string
): Promise<ShResult> {
  const tmux = getTmux();
  const refusal = await assertTmuxServerExternal(tmux);
  if (refusal) return refusal;
  return run(buildNewSessionArgs(tmux, getClaude(), name, cwd, rcName, model));
}

export async function tmuxKillSession(name: string): Promise<ShResult> {
  return run([getTmux(), "kill-session", "-t", name]);
}

/**
 * Gracefully exit an RC server by sending Ctrl-C, then force-kill after a timeout.
 * Ctrl-C causes `claude remote-control` to clean up sessions on claude.ai/code.
 */
export async function tmuxGracefulExit(name: string, timeoutMs = 1500): Promise<void> {
  const alive = await tmuxHasSession(name);
  if (!alive) return;
  await run([getTmux(), "send-keys", "-t", name, "C-c", ""]);
  // Wait for the process to exit on its own
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    if (!(await tmuxHasSession(name))) return;
  }
  // Still alive — force kill
  await tmuxKillSession(name);
}

export async function tmuxListWorkSessions(): Promise<string[]> {
  const r = await run([getTmux(), "list-sessions", "-F", "#{session_name}"]);
  if (!r.ok) return [];
  return r.stdout.split("\n").filter((s) => s.startsWith("work-"));
}

export async function getRcSessionUrl(tmuxName: string): Promise<string | null> {
  const r = await run([getTmux(), "capture-pane", "-t", tmuxName, "-p"]);
  if (!r.ok) return null;
  const match = r.stdout.match(/https:\/\/claude\.ai\/code\/session_\S+/);
  return match?.[0] ?? null;
}

export async function gitListBranches(repoPath: string): Promise<string[]> {
  const r = await run(["git", "-C", repoPath, "branch", "--sort=-committerdate", "--format=%(refname:short)"]);
  if (!r.ok || !r.stdout) return [];
  return r.stdout.split("\n").map((b) => b.trim()).filter(Boolean);
}

/**
 * Returns the default branch name (main/master/etc.) for a repo.
 * Tries HEAD symbolic ref first, then falls back to checking for "main" or "master".
 */
export async function gitDefaultBranch(repoPath: string): Promise<string> {
  // Try to read HEAD → refs/heads/<name>
  const r = await run(["git", "-C", repoPath, "symbolic-ref", "--short", "HEAD"]);
  if (r.ok && r.stdout) return r.stdout.trim();
  // Fallback: check common names
  const branches = await gitListBranches(repoPath);
  if (branches.includes("main")) return "main";
  if (branches.includes("master")) return "master";
  return "main"; // last resort
}

/**
 * Resolve the start point for a new session branch, preferring the freshest
 * remote state over whatever the local checkout happens to be sitting on.
 *
 * Fetches origin first, then returns `origin/<default-branch>` if it resolves.
 * Falls back to the local default branch for repos with no remote, no network,
 * or a remote that has never been fetched — a worktree off a slightly stale
 * local branch beats refusing to spawn.
 */
export async function gitFreshStartPoint(
  repoPath: string,
): Promise<{ ref: string; fromRemote: boolean; note: string }> {
  // NB: gitDefaultBranch() reports the *checked-out* branch, which is not what
  // we want here — spawning from a repo that happens to sit on a feature
  // branch must still branch from the remote's default.
  const local = await gitDefaultBranch(repoPath);

  const hasRemote = await run(["git", "-C", repoPath, "remote", "get-url", "origin"]);
  if (!hasRemote.ok) {
    return { ref: local, fromRemote: false, note: `⚠️ local ${local} (no origin remote)` };
  }

  const fetched = await run(["git", "-C", repoPath, "fetch", "--quiet", "origin"]);
  if (!fetched.ok) {
    // Don't refuse to spawn — but never let a stale local base pass silently,
    // since branching off fresh remote state is the whole point.
    return {
      ref: local,
      fromRemote: false,
      note: `⚠️ local ${local} — fetch failed: ${fetched.stderr.slice(0, 60)}`,
    };
  }

  // refs/remotes/origin/HEAD names the remote's default branch. It is often
  // unset on clones, so ask the remote to record it, then fall back to the
  // conventional names.
  const candidates: string[] = [];
  let head = await run(["git", "-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (!head.ok) {
    await run(["git", "-C", repoPath, "remote", "set-head", "origin", "--auto"]);
    head = await run(["git", "-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  }
  if (head.ok && head.stdout) candidates.push(head.stdout.trim());
  // Same fallback order as ~/.claude/hooks/create-worktree.sh, so mode-2
  // worktrees and `claude --worktree` resolve a base the same way.
  candidates.push("origin/main", "origin/master", "origin/develop");

  for (const ref of candidates) {
    const verified = await run([
      "git", "-C", repoPath, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`,
    ]);
    if (verified.ok) return { ref, fromRemote: true, note: ref };
  }

  return { ref: local, fromRemote: false, note: `⚠️ local ${local} (no remote default branch found)` };
}

export async function gitWorktreeAdd(
  repoPath: string,
  worktreePath: string,
  branch: string | null,
  newBranch?: string,
): Promise<ShResult> {
  const args = ["git", "-C", repoPath, "worktree", "add"];
  if (newBranch) {
    // Create a new branch from the given start point: git worktree add -b <new> <path> <start>
    args.push("-b", newBranch, worktreePath, branch ?? "main");
  } else {
    args.push(worktreePath);
    if (branch) args.push(branch);
  }
  return run(args);
}

export async function gitWorktreeRemove(
  repoPath: string,
  worktreePath: string
): Promise<ShResult> {
  return run(["git", "-C", repoPath, "worktree", "remove", "--force", worktreePath]);
}

// Only legal caller: failure path of the /work handler that created this worktree.
export async function gitWorktreeRemoveOnRollback(
  repoPath: string,
  worktreePath: string
): Promise<void> {
  await run(["git", "-C", repoPath, "worktree", "remove", "--force", worktreePath]);
}
