// Mode-2 inline menu controller.
// All m2: callback navigation is handled here — no new messages, edits in place.
import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { resolve, join } from "path";
import { access } from "fs/promises";
import { ALLOWED_USERS, REPOS_DIR } from "../../config";
import { isAuthorized, isPathAllowed } from "../../security";
import { auditLog } from "../../utils";
import { escapeHtml } from "../../formatting";
import { listRepos } from "../../mode2/repos";
import { makeSlug, tmuxNameFor, rcNameFor } from "../../mode2/slug";
import * as sh from "../../mode2/sh";
import * as store from "../../mode2/store";
import type { WorkSession } from "../../mode2/types";
import { TmuxMissing, SpawnFailed, WorktreeExists } from "../../mode2/errors";
import * as notifStore from "../../mode2/notifications-store";
import { renderNotificationsTab } from "./notifications";

function checkAuth(ctx: Context): boolean {
  const userId = ctx.from?.id;
  return !!(userId && isAuthorized(userId, ALLOWED_USERS));
}

// ── Keyboards ────────────────────────────────────────────────────────────────

function mainMenuKeyboard(unread = 0): InlineKeyboard {
  const notifLabel = unread > 0 ? `📬 Notifications  (${unread})` : "📬 Notifications";
  return new InlineKeyboard()
    .text("🗂  Work",      "m2:work").row()
    .text("📋  Sessions",  "m2:sessions").row()
    .text(notifLabel,      "m2:notifications");
}

function repoKeyboard(repos: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const repo of repos) {
    kb.text(repo, `m2:work:${repo}`).row();
  }
  kb.text("‹ Back", "m2:menu");
  return kb;
}

function sessionListKeyboard(slugs: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const slug of slugs) {
    kb.text(slug, `m2:session:${slug}`).row();
  }
  kb.text("‹ Back", "m2:menu");
  return kb;
}

function sessionDetailKeyboard(slug: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔗 Attach", `m2:attach:${slug}`)
    .text("✖ Close",  `m2:close:${slug}`).row()
    .text("‹ Back",   "m2:sessions");
}

// ── Entry point (slash command) ───────────────────────────────────────────────

export async function handleMenu(ctx: Context): Promise<void> {
  if (!checkAuth(ctx)) { await ctx.reply("Unauthorized"); return; }
  const unread = await notifStore.unreadCount();
  await ctx.reply("Personal assistant  ·  menu", { reply_markup: mainMenuKeyboard(unread) });
}

// ── Callback router ───────────────────────────────────────────────────────────

export async function handleMode2Callback(ctx: Context, action: string): Promise<void> {
  if (!checkAuth(ctx)) {
    await ctx.answerCallbackQuery({ text: "Unauthorized" });
    return;
  }

  await ctx.answerCallbackQuery();

  if (action === "menu") {
    const unread = await notifStore.unreadCount();
    await edit(ctx, "Personal assistant  ·  menu", mainMenuKeyboard(unread));
    return;
  }

  if (action === "notifications") {
    await renderNotificationsTab(ctx);
    return;
  }

  if (action === "work") {
    const repos = await listRepos();
    if (repos.length === 0) {
      await edit(ctx, `No repos found in <code>${escapeHtml(REPOS_DIR)}</code>`, new InlineKeyboard().text("‹ Back", "m2:menu"), true);
      return;
    }
    await edit(ctx, "Choose a repo:", repoKeyboard(repos));
    return;
  }

  if (action.startsWith("work:")) {
    const repo = action.slice("work:".length);
    await spawnSession(ctx, repo);
    return;
  }

  if (action === "sessions") {
    const sessions = await store.list();
    const live = sessions.filter((s) => !s.closed);
    if (live.length === 0) {
      await edit(ctx, "No active sessions. Tap Work to start one.", new InlineKeyboard().text("‹ Back", "m2:menu"));
      return;
    }
    const lines = live.map((s) => {
      const age = Math.floor((Date.now() - new Date(s.last_attached_at).getTime()) / 60_000);
      const wt = s.worktree_path ? ` [${s.worktree_path.split("/").pop()}]` : "";
      return `• <code>${escapeHtml(s.slug)}</code> — ${escapeHtml(s.repo)}${wt}, idle ${age}m`;
    });
    await edit(
      ctx,
      `<b>${live.length} active session${live.length === 1 ? "" : "s"}</b>\n\n${lines.join("\n")}`,
      sessionListKeyboard(live.map((s) => s.slug)),
      true,
    );
    return;
  }

  if (action.startsWith("session:")) {
    const slug = action.slice("session:".length);
    const s = await store.get(slug);
    if (!s || s.closed) {
      await edit(ctx, `Session <code>${escapeHtml(slug)}</code> not found or already closed.`, new InlineKeyboard().text("‹ Back", "m2:sessions"), true);
      return;
    }
    const age = Math.floor((Date.now() - new Date(s.last_attached_at).getTime()) / 60_000);
    const wt = s.worktree_path ? `\nWorktree: <code>${escapeHtml(s.worktree_path)}</code>` : "";
    const text =
      `<b>${escapeHtml(slug)}</b>\n` +
      `Repo: <code>${escapeHtml(s.repo)}</code>\n` +
      `CWD: <code>${escapeHtml(s.path)}</code>${wt}\n` +
      `RC: <code>${escapeHtml(s.rc_name)}</code>\n` +
      `Idle: ${age}m`;
    await edit(ctx, text, sessionDetailKeyboard(slug), true);
    return;
  }

  if (action.startsWith("attach:")) {
    const slug = action.slice("attach:".length);
    const s = await store.get(slug);
    if (!s || s.closed) {
      await edit(ctx, `Session <code>${escapeHtml(slug)}</code> not found.`, new InlineKeyboard().text("‹ Back", "m2:sessions"), true);
      return;
    }
    const alive = await sh.tmuxHasSession(s.tmux_name);
    if (!alive) {
      await edit(
        ctx,
        `⚠️ tmux session for <code>${escapeHtml(slug)}</code> is not running. RC server may have crashed.\nTry closing and re-opening via Work.`,
        new InlineKeyboard().text("‹ Back", `m2:session:${slug}`),
        true,
      );
      return;
    }
    await store.touch(slug);
    const userId = ctx.from?.id ?? 0;
    const username = ctx.from?.username ?? "unknown";
    await auditLog(userId, username, "mode2.attach", `slug=${slug}`);
    await edit(
      ctx,
      `<b>Attached: <code>${escapeHtml(slug)}</code></b>\n` +
      `Repo: <code>${escapeHtml(s.repo)}</code>\n` +
      `RC session name: <code>${escapeHtml(s.rc_name)}</code>`,
      new InlineKeyboard().text("✖ Close", `m2:close:${slug}`).row().text("‹ Back", `m2:session:${slug}`),
      true,
    );
    return;
  }

  if (action.startsWith("close:")) {
    const slug = action.slice("close:".length);
    const s = await store.get(slug);
    if (!s || s.closed) {
      await edit(ctx, `Session <code>${escapeHtml(slug)}</code> not found or already closed.`, new InlineKeyboard().text("‹ Back", "m2:sessions"), true);
      return;
    }
    await sh.tmuxGracefulExit(s.tmux_name);
    let wtNote = "";
    if (s.worktree_path) {
      const r = await sh.gitWorktreeRemove(resolve(join(REPOS_DIR, s.repo)), s.worktree_path);
      wtNote = r.ok
        ? `\nWorktree removed: <code>${escapeHtml(s.worktree_path)}</code>`
        : `\n⚠️ Worktree removal failed: <code>${escapeHtml(r.stderr.slice(0, 100))}</code>`;
    }
    await store.markClosed(slug, "user");
    const userId = ctx.from?.id ?? 0;
    const username = ctx.from?.username ?? "unknown";
    await auditLog(userId, username, "mode2.close", `slug=${slug}`);
    await edit(
      ctx,
      `✅ Session <code>${escapeHtml(slug)}</code> closed.${wtNote}`,
      new InlineKeyboard().text("‹ Sessions", "m2:sessions").text("‹ Menu", "m2:menu"),
      true,
    );
    return;
  }

  await ctx.reply("Unknown action.");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function edit(ctx: Context, text: string, keyboard: InlineKeyboard, html = false): Promise<void> {
  try {
    await ctx.editMessageText(text, {
      reply_markup: keyboard,
      ...(html ? { parse_mode: "HTML" } : {}),
    });
  } catch {
    // Message too old or unchanged — send a new one
    await ctx.reply(text, {
      reply_markup: keyboard,
      ...(html ? { parse_mode: "HTML" } : {}),
    });
  }
}

async function spawnSession(ctx: Context, repo: string): Promise<void> {
  const userId = ctx.from?.id ?? 0;
  const username = ctx.from?.username ?? "unknown";
  const repoPath = resolve(join(REPOS_DIR, repo));

  if (!isPathAllowed(repoPath)) {
    await edit(ctx, `❌ Repo path not allowed: <code>${escapeHtml(repoPath)}</code>`, new InlineKeyboard().text("‹ Back", "m2:work"), true);
    return;
  }
  try { await access(repoPath); } catch {
    await edit(ctx, `❌ Repo not found: <code>${escapeHtml(repo)}</code>`, new InlineKeyboard().text("‹ Back", "m2:work"), true);
    return;
  }

  const slug = makeSlug(repo);
  const tmuxName = tmuxNameFor(slug);
  const rcName = rcNameFor(slug);
  // Each session gets its own worktree + branch named after the slug
  const worktreePath = resolve(join(repoPath, ".worktrees", slug));
  const branchName = `session/${slug}`;

  if (!isPathAllowed(worktreePath)) {
    await edit(ctx, `❌ Worktree path not allowed.`, new InlineKeyboard().text("‹ Back", "m2:work"), true);
    return;
  }

  await edit(ctx, `⏳ Spawning session in <code>${escapeHtml(repo)}</code>…`, new InlineKeyboard(), true);

  let worktreeCreated = false;
  try {
    // Create a fresh branch from main in an isolated worktree
    const wt = await sh.gitWorktreeAdd(repoPath, worktreePath, "main", branchName);
    if (!wt.ok) throw new WorktreeExists(worktreePath);
    worktreeCreated = true;

    const spawnResult = await sh.tmuxNewSession(tmuxName, worktreePath, rcName);
    if (!spawnResult.ok) throw new SpawnFailed(slug, spawnResult.stderr);

    let alive = false;
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 500));
      alive = await sh.tmuxHasSession(tmuxName);
      if (alive) break;
    }
    if (!alive) throw new SpawnFailed(slug, `tmux session ${tmuxName} not found after 3s`);

    const now = new Date().toISOString();
    const workSession: WorkSession = {
      slug, repo, path: worktreePath,
      worktree_path: worktreePath, branch: branchName,
      tmux_name: tmuxName, rc_name: rcName,
      created_at: now, last_attached_at: now,
      closed: false,
    };
    await store.append(workSession);
    await auditLog(userId, username, "mode2.work.spawn", `slug=${slug} repo=${repo} branch=${branchName}`);

    await edit(
      ctx,
      `✅ <b>${escapeHtml(slug)}</b>\n` +
      `Repo: <code>${escapeHtml(repo)}</code>\n` +
      `Branch: <code>${escapeHtml(branchName)}</code>\n` +
      `RC: <code>${escapeHtml(rcName)}</code>`,
      new InlineKeyboard()
        .text("🔗 Attach", `m2:attach:${slug}`).row()
        .text("‹ Work", "m2:work").text("‹ Menu", "m2:menu"),
      true,
    );
  } catch (err) {
    if (worktreeCreated) {
      await sh.gitWorktreeRemoveOnRollback(repoPath, worktreePath);
      await auditLog(userId, username, "mode2.work.rollback", `slug=${slug} worktree=${worktreePath}`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: "mode2.work.error", slug, error: msg }));
    await edit(ctx, `❌ Spawn failed: <code>${escapeHtml(msg)}</code>`, new InlineKeyboard().text("‹ Back", "m2:work"), true);
  }
}
