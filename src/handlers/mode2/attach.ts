import type { Context } from "grammy";
import { ALLOWED_USERS } from "../../config";
import { isAuthorized } from "../../security";
import { auditLog } from "../../utils";
import { escapeHtml } from "../../formatting";
import * as store from "../../mode2/store";
import * as sh from "../../mode2/sh";

function checkAuth(ctx: Context): boolean {
  const userId = ctx.from?.id;
  return !!(userId && isAuthorized(userId, ALLOWED_USERS));
}

export async function handleAttach(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username ?? "unknown";

  if (!userId || !checkAuth(ctx)) {
    await ctx.reply("Unauthorized");
    return;
  }

  const slug = ctx.match ? String(ctx.match).trim() : "";
  if (!slug) {
    await ctx.reply("Usage: /attach <slug>\nSee /sessions for active sessions.");
    return;
  }

  const session = await store.get(slug);
  if (!session) {
    await ctx.reply(`❌ Session not found: <code>${escapeHtml(slug)}</code>`, { parse_mode: "HTML" });
    return;
  }
  if (session.closed) {
    await ctx.reply(`❌ Session <code>${escapeHtml(slug)}</code> is closed.`, { parse_mode: "HTML" });
    return;
  }

  const alive = await sh.tmuxHasSession(session.tmux_name);
  if (!alive) {
    await ctx.reply(
      `⚠️ tmux session <code>${escapeHtml(session.tmux_name)}</code> is not running.\n` +
      `The RC server may have crashed. Try closing and re-opening with /work.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  await store.touch(slug);
  await auditLog(userId, username, "mode2.attach", `slug=${slug}`);

  await ctx.reply(
    `<b>Session: <code>${escapeHtml(slug)}</code></b>\n` +
    `Repo: <code>${escapeHtml(session.repo)}</code>\n` +
    `CWD: <code>${escapeHtml(session.path)}</code>\n` +
    (session.worktree_path ? `Worktree: <code>${escapeHtml(session.worktree_path)}</code>\n` : "") +
    `\nConnect via Cloud Code Remote → session name: <code>${escapeHtml(session.rc_name)}</code>`,
    { parse_mode: "HTML" }
  );
}
