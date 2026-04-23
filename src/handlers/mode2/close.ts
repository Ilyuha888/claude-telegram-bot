import type { Context } from "grammy";
import { ALLOWED_USERS } from "../../config";
import { isAuthorized } from "../../security";
import { auditLog } from "../../utils";
import { escapeHtml } from "../../formatting";
import * as store from "../../mode2/store";
import * as sh from "../../mode2/sh";
import { REPOS_DIR } from "../../config";
import { resolve, join } from "path";

function checkAuth(ctx: Context): boolean {
  const userId = ctx.from?.id;
  return !!(userId && isAuthorized(userId, ALLOWED_USERS));
}

export async function handleClose(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username ?? "unknown";

  if (!userId || !checkAuth(ctx)) {
    await ctx.reply("Unauthorized");
    return;
  }

  const slug = ctx.match ? String(ctx.match).trim() : "";
  if (!slug) {
    await ctx.reply("Usage: /close <slug>\nSee /sessions for active sessions.");
    return;
  }

  const session = await store.get(slug);
  if (!session) {
    await ctx.reply(`❌ Session not found: <code>${escapeHtml(slug)}</code>`, { parse_mode: "HTML" });
    return;
  }
  if (session.closed) {
    await ctx.reply(`ℹ️ Session <code>${escapeHtml(slug)}</code> is already closed.`, { parse_mode: "HTML" });
    return;
  }

  // Gracefully exit the RC server (sends Ctrl-C so claude.ai/code cleans up),
  // then force-kills if it doesn't exit within 1.5s
  await sh.tmuxGracefulExit(session.tmux_name);

  // Remove worktree if one was created for this session
  let wtNote = "";
  if (session.worktree_path) {
    const r = await sh.gitWorktreeRemove(resolve(join(REPOS_DIR, session.repo)), session.worktree_path);
    wtNote = r.ok
      ? `\nWorktree removed: <code>${escapeHtml(session.worktree_path)}</code>`
      : `\n⚠️ Worktree removal failed: <code>${escapeHtml(r.stderr.slice(0, 100))}</code>`;
  }

  await store.markClosed(slug, "user");
  await auditLog(userId, username, "mode2.close", `slug=${slug}`);

  await ctx.reply(
    `✅ Session <code>${escapeHtml(slug)}</code> closed.${wtNote}`,
    { parse_mode: "HTML" }
  );
}
