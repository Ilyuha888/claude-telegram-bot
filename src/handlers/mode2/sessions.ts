import type { Context } from "grammy";
import { ALLOWED_USERS } from "../../config";
import { isAuthorized } from "../../security";
import { escapeHtml } from "../../formatting";
import * as store from "../../mode2/store";

function checkAuth(ctx: Context): boolean {
  const userId = ctx.from?.id;
  return !!(userId && isAuthorized(userId, ALLOWED_USERS));
}

export async function handleSessions(ctx: Context): Promise<void> {
  if (!checkAuth(ctx)) {
    await ctx.reply("Unauthorized");
    return;
  }

  const sessions = await store.list();
  const live = sessions.filter((s) => !s.closed);

  if (live.length === 0) {
    await ctx.reply("No active sessions. Use /work to start one.");
    return;
  }

  const lines = live.map((s) => {
    const wt = s.worktree_path ? ` [${s.worktree_path.split("/").pop()}]` : "";
    const age = Math.floor((Date.now() - new Date(s.last_attached_at).getTime()) / 60_000);
    return (
      `• <code>${escapeHtml(s.slug)}</code> — ${escapeHtml(s.repo)}${wt}\n` +
      `  RC: <code>${escapeHtml(s.rc_name)}</code>  idle ${age}m\n` +
      `  /attach ${escapeHtml(s.slug)}  /close ${escapeHtml(s.slug)}`
    );
  });

  await ctx.reply(
    `<b>${live.length} active session${live.length === 1 ? "" : "s"}</b>\n\n${lines.join("\n\n")}`,
    { parse_mode: "HTML" }
  );
}
