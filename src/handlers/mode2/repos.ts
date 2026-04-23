import type { Context } from "grammy";
import { ALLOWED_USERS, REPOS_DIR } from "../../config";
import { isAuthorized } from "../../security";
import { escapeHtml } from "../../formatting";
import { listRepos } from "../../mode2/repos";

function checkAuth(ctx: Context): boolean {
  const userId = ctx.from?.id;
  return !!(userId && isAuthorized(userId, ALLOWED_USERS));
}

export async function handleRepos(ctx: Context): Promise<void> {
  if (!checkAuth(ctx)) {
    await ctx.reply("Unauthorized");
    return;
  }

  const repos = await listRepos();
  if (repos.length === 0) {
    await ctx.reply(`No repos found in <code>${escapeHtml(REPOS_DIR)}</code>`, { parse_mode: "HTML" });
    return;
  }

  const lines = repos.map((r) => `• <code>${escapeHtml(r)}</code>`);
  await ctx.reply(
    `<b>${repos.length} repo${repos.length === 1 ? "" : "s"}</b> in <code>${escapeHtml(REPOS_DIR)}</code>\n\n` +
    lines.join("\n"),
    { parse_mode: "HTML" }
  );
}
