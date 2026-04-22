// Mode-2 handlers MUST NEVER import or call session.sendMessageStreaming().
import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { ALLOWED_USERS } from "../config";
import { isAuthorized } from "../security";

async function checkAuth(ctx: Context): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId || !isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized");
    return false;
  }
  return true;
}

export async function handleWork(ctx: Context): Promise<void> {
  if (!await checkAuth(ctx)) return;
  const args = ctx.match ? String(ctx.match).trim() : "";
  console.log(JSON.stringify({ event: "mode2.stub", cmd: "/work", chat_id: ctx.chat?.id, args }));
  await ctx.reply("🚧 /work not yet implemented (dec-20260422-003).\nUsage: /work <repo> [path] [worktree] [branch]");
}

export async function handleSessions(ctx: Context): Promise<void> {
  if (!await checkAuth(ctx)) return;
  console.log(JSON.stringify({ event: "mode2.stub", cmd: "/sessions", chat_id: ctx.chat?.id }));
  await ctx.reply("🚧 /sessions not yet implemented (dec-20260422-003).");
}

export async function handleAttach(ctx: Context): Promise<void> {
  if (!await checkAuth(ctx)) return;
  const args = ctx.match ? String(ctx.match).trim() : "";
  console.log(JSON.stringify({ event: "mode2.stub", cmd: "/attach", chat_id: ctx.chat?.id, args }));
  await ctx.reply("🚧 /attach not yet implemented (dec-20260422-003).");
}

export async function handleClose(ctx: Context): Promise<void> {
  if (!await checkAuth(ctx)) return;
  const args = ctx.match ? String(ctx.match).trim() : "";
  console.log(JSON.stringify({ event: "mode2.stub", cmd: "/close", chat_id: ctx.chat?.id, args }));
  await ctx.reply("🚧 /close not yet implemented (dec-20260422-003).");
}

export async function handleRepos(ctx: Context): Promise<void> {
  if (!await checkAuth(ctx)) return;
  console.log(JSON.stringify({ event: "mode2.stub", cmd: "/repos", chat_id: ctx.chat?.id }));
  await ctx.reply("🚧 /repos not yet implemented (dec-20260422-003).");
}

const menuKeyboard = new InlineKeyboard()
  .text("Sessions",  "menu:sessions").row()
  .text("Repos",     "menu:repos").row()
  .text("New work",  "menu:work").row()
  .text("Close",     "menu:close").row();

export async function handleMenu(ctx: Context): Promise<void> {
  if (!await checkAuth(ctx)) return;
  console.log(JSON.stringify({ event: "mode2.menu", cmd: "/menu", chat_id: ctx.chat?.id }));
  await ctx.reply("Ops menu", { reply_markup: menuKeyboard });
}
