import type { ShResult } from "./types";
import { TmuxMissing } from "./errors";

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

export async function tmuxNewSession(
  name: string,
  cwd: string,
  rcName: string
): Promise<ShResult> {
  const cmd = `'${getClaude()}' remote-control --name '${rcName}' --spawn same-dir --capacity 1`;
  return run([getTmux(), "new-session", "-d", "-s", name, "-c", cwd, cmd]);
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
