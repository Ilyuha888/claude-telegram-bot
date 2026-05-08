/**
 * Optional user MCP servers for the Claude Telegram Bot.
 *
 * The two built-in MCPs (`ask-user`, `send-file`) are registered automatically
 * by `src/config.ts` — you do NOT need to list them here. This file is only
 * for personal/optional MCP servers you want to wire up.
 *
 * Copy this file to `mcp-config.ts` and uncomment what you want.
 *
 * Format matches Claude's MCP config schema.
 * See: https://docs.anthropic.com/en/docs/build-with-claude/mcp
 */

import { homedir } from "os";

const HOME = homedir();

export const MCP_SERVERS: Record<
  string,
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> }
> = {
  // Example: haft — personal decision/onboarding tool.
  // The binary must be on PATH. Install per its own README before uncommenting.
  // "haft": {
  //   command: "haft",
  //   args: ["serve"],
  // },

  // Example: Typefully - draft and schedule social posts
  // Docs: https://support.typefully.com/en/articles/13128440-typefully-mcp-server
  // "typefully": {
  //   type: "http",
  //   url: `https://mcp.typefully.com/mcp?TYPEFULLY_API_KEY=${process.env.TYPEFULLY_API_KEY || ""}`
  // },

  // Example: Things 3 task manager (macOS)
  // Requires: https://github.com/hald/things-mcp
  // "things": {
  //   command: "uv",
  //   args: ["--directory", `${HOME}/Dev/things-mcp`, "run", "things_server.py"]
  // },
};
