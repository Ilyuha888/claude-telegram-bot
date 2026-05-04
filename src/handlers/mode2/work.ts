// Mode-2 handlers MUST NEVER import or call session.sendMessageStreaming().
import type { Context } from "grammy";
import { join, resolve } from "path";
import { access } from "fs/promises";
import { ALLOWED_USERS, REPOS_DIR } from "../../config";
import { isAuthorized, isPathAllowed } from "../../security";
import { auditLog } from "../../utils";
import { escapeHtml } from "../../formatting";
import { makeSlug, tmuxNameFor, rcNameFor } from "../../mode2/slug";
import * as sh from "../../mode2/sh";
import * as store from "../../mode2/store";
import type { WorkSession } from "../../mode2/types";
import { TmuxMissing, SpawnFailed, WorktreeExists } from "../../mode2/errors";

function checkAuth(ctx: Context): boolean {
  const userId = ctx.from?.id;
  return !!(userId && isAuthorized(userId, ALLOWED_USERS));
}

function parseArgs(raw: string): {
  repo: string;
  subpath: string | null;
  worktree: string | null;
  branch: string | null;
} {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  return {
    repo: parts[0] ?? "",
    subpath: parts[1] ?? null,
    worktree: parts[2] ?? null,
    branch: parts[3] ?? null,
  };
}

export async function handleWork(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username ?? "unknown";

  if (!userId || !checkAuth(ctx)) {
    await ctx.reply("Unauthorized");
    return;
  }

  const raw = ctx.match ? String(ctx.match).trim() : "";
  const { repo, subpath, worktree, branch } = parseArgs(raw);

  if (!repo) {
    await ctx.reply(
      "Usage: /work <repo> [subpath] [worktree] [branch]\n" +
      "Example: /work data-style\n" +
      "         /work data-style . feat-x main"
    );
    return;
  }

  const repoPath = resolve(join(REPOS_DIR, repo));
  if (!isPathAllowed(repoPath)) {
    await ctx.reply(`❌ Repo path not allowed: <code>${escapeHtml(repoPath)}</code>`, { parse_mode: "HTML" });
    return;
  }

  // Verify repo exists
  try {
    await access(repoPath);
  } catch {
    await ctx.reply(`❌ Repo not found: <code>${escapeHtml(repo)}</code>`, { parse_mode: "HTML" });
    return;
  }

  // Determine cwd (repo root or subpath)
  const cwd = subpath && subpath !== "." ? resolve(join(repoPath, subpath)) : repoPath;
  if (!isPathAllowed(cwd)) {
    await ctx.reply(`❌ Subpath not allowed: <code>${escapeHtml(cwd)}</code>`, { parse_mode: "HTML" });
    return;
  }

  // Determine worktree path
  let worktreePath: string | null = null;
  if (worktree) {
    worktreePath = resolve(join(repoPath, ".worktrees", worktree));
    if (!isPathAllowed(worktreePath)) {
      await ctx.reply(`❌ Worktree path not allowed: <code>${escapeHtml(worktreePath)}</code>`, { parse_mode: "HTML" });
      return;
    }
    // Check for collision with existing live session
    const sessions = await store.list();
    const collision = sessions.find(
      (s) => !s.closed && s.repo === repo && s.worktree_path === worktreePath
    );
    if (collision) {
      await ctx.reply(
        `⚠️ Worktree already active under session <code>${escapeHtml(collision.slug)}</code>.\n` +
        `Attach: /attach ${escapeHtml(collision.slug)}`,
        { parse_mode: "HTML" }
      );
      return;
    }
    // Check for existing path on disk
    try {
      await access(worktreePath);
      await ctx.reply(`❌ Worktree path already exists on disk: <code>${escapeHtml(worktreePath)}</code>`, { parse_mode: "HTML" });
      return;
    } catch {
      // Good — doesn't exist yet
    }
  }

  const slug = makeSlug(repo);
  const tmuxName = tmuxNameFor(slug);
  const rcName = rcNameFor(slug);
  let worktreeCreated = false;

  await ctx.reply(`⏳ Spawning session <code>${escapeHtml(slug)}</code>…`, { parse_mode: "HTML" });

  try {
    // Create worktree if requested
    if (worktreePath) {
      const wt = await sh.gitWorktreeAdd(repoPath, worktreePath, branch);
      if (!wt.ok) {
        throw new WorktreeExists(worktreePath);
      }
      worktreeCreated = true;
    }

    // Spawn RC server under tmux
    const spawnCwd = worktreePath ?? cwd;
    const spawnResult = await sh.tmuxNewSession(tmuxName, spawnCwd, rcName);
    if (!spawnResult.ok) {
      throw new SpawnFailed(slug, spawnResult.stderr);
    }

    // Wait up to 3s for tmux session to confirm
    let alive = false;
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 500));
      alive = await sh.tmuxHasSession(tmuxName);
      if (alive) break;
    }
    if (!alive) {
      throw new SpawnFailed(slug, `tmux session ${tmuxName} not found after 3s`);
    }

    // Persist session
    const now = new Date().toISOString();
    const session: WorkSession = {
      slug,
      repo,
      path: spawnCwd,
      worktree_path: worktreePath,
      branch: branch ?? null,
      tmux_name: tmuxName,
      rc_name: rcName,
      created_at: now,
      last_attached_at: now,
      closed: false,
    };
    await store.append(session);

    await auditLog(userId, username, "mode2.work.spawn", `slug=${slug} repo=${repo} worktree=${worktreePath ?? "none"}`);

    const lines = [
      `✅ Session spawned: <code>${escapeHtml(slug)}</code>`,
      `Repo: <code>${escapeHtml(repo)}</code>`,
      `CWD: <code>${escapeHtml(spawnCwd)}</code>`,
    ];
    if (worktreePath) lines.push(`Worktree: <code>${escapeHtml(worktreePath)}</code>`);
    lines.push(`\nConnect via Cloud Code Remote → session name: <code>${escapeHtml(rcName)}</code>`);

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });

  } catch (err) {
    // Rollback: if we created a worktree in this call, remove it before surfacing the error
    if (worktreeCreated && worktreePath) {
      await sh.gitWorktreeRemoveOnRollback(repoPath, worktreePath);
      await auditLog(userId, username, "mode2.work.rollback", `slug=${slug} worktree=${worktreePath}`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: "mode2.work.error", slug, error: msg }));
    await ctx.reply(
      `❌ Failed to spawn session: <code>${escapeHtml(msg)}</code>`,
      { parse_mode: "HTML" }
    );
  }
}
