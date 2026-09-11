/**
 * Single source of truth for the bot's Telegram commands.
 *
 * Three consumers, previously three hand-maintained copies:
 *   1. the Telegram autocomplete menu   (src/index.ts, setMyCommands)
 *   2. the /start help text             (src/handlers/commands.ts)
 *   3. the assistant's own system prompt (src/session.ts)
 *
 * (3) is the reason this file exists. Asked "how do I spawn a worktree session
 * here?", the assistant used to research the CLI and confidently explain
 * `claude --worktree` and the EnterWorktree tool — neither of which is this
 * bot's /work command. It had no idea its own command surface existed, so it
 * answered about the nearest thing it could see. Same failure as guessing its
 * model: missing context, plausible fabrication.
 */

import { GROUP_CHAT_ID } from "./config";

export interface CommandSpec {
  /** Command without the leading slash. */
  name: string;
  /** Argument signature, e.g. "<repo> [subpath] [worktree] [branch]". */
  args?: string;
  /** One-liner for the Telegram autocomplete menu (keep short). */
  short: string;
  /** Fuller description for /start and for the assistant. */
  help: string;
  /** Only for the assistant — behaviour worth knowing but not worth chat space. */
  detail?: string;
  /** Show in the Telegram autocomplete list. */
  menu?: boolean;
}

export const COMMANDS: CommandSpec[] = [
  {
    name: "new", short: "Start fresh session", menu: true,
    help: "Clear the current session. The next message starts a new one.",
    detail: "Also re-reads runtime config, so a /model change takes effect here.",
  },
  // Only listed when a forum supergroup is configured. Advertising it
  // otherwise would put a command in the menu and in /start whose only
  // possible answer is "not configured".
  ...(GROUP_CHAT_ID !== null
    ? [{
        name: "topic", args: "[name]", short: "Open a parallel session", menu: true,
        help: "Open a new forum topic with its own independent Claude session.",
        detail:
          "Each topic is a separate conversation with its own context, history and /status — they run in parallel and don't interrupt each other. " +
          "With no name, the topic is named after the current time. The session starts empty: send your first message inside the topic.",
      } satisfies CommandSpec]
    : []),
  {
    name: "compact", short: "Summarize and start fresh", menu: true,
    help: "Summarize this session into a handoff brief, then start fresh with it carried over.",
    detail: "Runs one summarization turn, so it needs context room — use it before the wall, not after. /status shows how full you are.",
  },
  {
    name: "status", short: "Model · context · session", menu: true,
    help: "Show the running model, context usage with a breakdown, and session state.",
    detail: "Model and CLI version come from the SDK init event, context from getContextUsage() — both are measured, not assumed.",
  },
  {
    name: "model", args: "[model-id]", short: "Show or change the model", menu: true,
    help: "With no argument, show the configured and running model. With one, set it.",
    detail: "Example: /model claude-opus-5[1m]. The [1m] suffix selects the 1M-token context variant. Applies to the next /new — the current session keeps its model. No restart needed.",
  },
  {
    name: "stop", short: "Stop current query", menu: true,
    help: "Abort the query in flight.",
    detail: "Prefixing any message with ! interrupts the current query and sends that message instead.",
  },
  {
    name: "retry", short: "Retry last message", menu: true,
    help: "Re-send the previous message.",
  },
  {
    name: "resume", short: "Resume a saved session", menu: true,
    help: "Pick a previous session from an inline list and continue it.",
    detail: "Only offers sessions from this working directory whose last turn succeeded; sessions that ended in an error are hidden because resuming them reproduces the failure.",
  },
  {
    name: "restart", short: "Restart the bot", menu: true,
    help: "Restart the bot process.",
  },
  {
    name: "menu", short: "Repos · Sessions · Work", menu: true,
    help: "Inline control panel for work sessions, repos and notifications.",
    detail: "Work → pick a repo spawns a session the same way /work does, with a worktree.",
  },
  {
    name: "work", args: "<repo> [subpath] [worktree] [branch]", short: "Spawn a work session",
    help: "Spawn a Claude Code session on a repo and return a claude.ai/code link to drive it from.",
    detail:
      "Positional arguments. <repo> is a directory name under the repos dir (see /repos), not a path. " +
      "[subpath] is a directory inside it, or . for the root. [worktree] names a git worktree created at <repo>/.worktrees/<name>; omit it to work in the repo root. " +
      "[branch] is the base to branch from; omit it and the base is the freshest remote default (origin/HEAD, fetched first). " +
      "Example: /work data-style . feat-x — worktree feat-x off fresh origin/main. " +
      "New worktrees are bootstrapped: node_modules symlinked, .env and .claude/settings.local.json copied, the path pre-trusted. " +
      "The conversation happens in Claude Code, not Telegram — this only launches it.",
  },
  {
    name: "sessions", short: "List work sessions",
    help: "List active work sessions with their slugs and idle time.",
  },
  {
    name: "attach", args: "<slug>", short: "Reconnect to a session",
    help: "Re-print the connection link and session name for an existing work session.",
    detail: "Does not attach anything locally — it hands back the details so you can reconnect, and keeps the session from being reaped as idle.",
  },
  // One command, two objects — see handleCloseCommand. The topic half only
  // exists when a forum supergroup is configured, so the signature, the
  // description and the menu entry all narrow back to the work-session form
  // when it isn't: the alternative is advertising an argument-less /close
  // whose only possible answer is "not configured".
  GROUP_CHAT_ID !== null
    ? {
        name: "close", args: "[slug]", short: "Close this topic (or a work session)", menu: true,
        help: "With no argument, close the forum topic you're in. With a slug, shut down that work session.",
        detail:
          "Closing a topic keeps its conversation: reopen the topic from its menu and post within 24h to resume it. " +
          "A query still running in that topic is interrupted first — no need to /stop beforehand. " +
          "Refused in the General topic and in direct chats — there is no topic there; /new clears the conversation instead. " +
          "Closing a work session removes its worktree, deleting that checkout, so commit or push first.",
      }
    : {
        name: "close", args: "<slug>", short: "Close a work session",
        help: "Shut down a work session and remove its worktree.",
        detail: "Removing the worktree deletes its checkout, so commit or push anything you want to keep first.",
      },
  {
    name: "repos", short: "List available repos",
    help: "List the repos that /work and /menu can spawn sessions on.",
  },
];

/** Telegram's setMyCommands payload. */
export function menuCommands(): { command: string; description: string }[] {
  return COMMANDS.filter((c) => c.menu).map((c) => ({
    command: c.name,
    description: c.short,
  }));
}

/** Command list for the /start message. */
export function renderHelp(): string {
  return COMMANDS.map((c) => {
    const sig = `/${c.name}${c.args ? " " + c.args : ""}`;
    return `<code>${sig}</code> — ${c.help}`;
  }).join("\n");
}

/**
 * Command reference for the system prompt.
 *
 * Framed explicitly as things the *user* types, because the model will
 * otherwise try to invoke them as tools or shell them out.
 */
export function renderCommandsForPrompt(): string {
  const lines = COMMANDS.map((c) => {
    const sig = `/${c.name}${c.args ? " " + c.args : ""}`;
    const detail = c.detail ? ` ${c.detail}` : "";
    return `- ${sig} — ${c.help}${detail}`;
  });

  return `
TELEGRAM COMMANDS AVAILABLE TO THE USER:
These are commands the user types into this Telegram chat. They are handled by the bot process, NOT by you — you cannot invoke them, run them via Bash, or trigger them on the user's behalf. Your job is to explain them accurately and tell the user which one to send.

When the user asks how to do something that one of these covers — spawning a session on a repo, changing the model, checking context usage, compacting — answer with the exact command and its arguments from this list. Do not describe Claude Code CLI flags or your own tools instead; those are different things and will not work here.

${lines.join("\n")}
`;
}
