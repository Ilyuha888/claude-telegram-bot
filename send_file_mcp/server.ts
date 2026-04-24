#!/usr/bin/env bun
/**
 * Send File MCP Server — delivers files to the user via Telegram.
 *
 * On each call the server validates the path against ALLOWED_PATHS (injected
 * by src/config.ts) plus a forbidden-segment/filename deny list, checks the
 * size against the Telegram method limit (10MB for photos, 50MB otherwise),
 * then writes a /tmp/send-file-*.json request the bot polls for. The bot
 * picks a send method by extension and delivers, audit-logging the attempt.
 *
 * Fire-and-forget: the agent continues generating after the call. Refused
 * paths return isError:true — no request file is queued and no Telegram API
 * call happens.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { realpathSync } from "fs";
import { resolve as resolvePath, sep } from "path";

const PHOTO_MAX_SIZE = 10 * 1024 * 1024;
const DOCUMENT_MAX_SIZE = 50 * 1024 * 1024;

const PHOTO_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

const FORBIDDEN_SEGMENTS = [
  `${sep}.git${sep}`,
  `${sep}.claude${sep}`,
  `${sep}.ssh${sep}`,
  `${sep}.aws${sep}`,
  `${sep}.gnupg${sep}`,
];

const FORBIDDEN_FILENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "credentials",
  "credentials.json",
  ".netrc",
]);

function parseAllowedPaths(): string[] {
  const raw = process.env.ALLOWED_PATHS || "";
  return raw.split(",").map((p) => p.trim()).filter(Boolean);
}

function resolveRealPath(p: string): string {
  const abs = resolvePath(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function isUnderAllowedRoot(resolved: string, allowed: string[]): boolean {
  for (const root of allowed) {
    const rootResolved = resolveRealPath(root);
    const rootWithSep = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep;
    if (resolved === rootResolved || resolved.startsWith(rootWithSep)) {
      return true;
    }
  }
  return false;
}

function isForbidden(resolved: string): string | null {
  const filename = resolved.split(sep).pop() || "";
  if (FORBIDDEN_FILENAMES.has(filename)) {
    return `filename "${filename}" is on the deny list`;
  }
  const withLeadingSep = resolved.startsWith(sep) ? resolved : sep + resolved;
  for (const seg of FORBIDDEN_SEGMENTS) {
    if (withLeadingSep.includes(seg)) {
      return `path traverses forbidden segment "${seg.replaceAll(sep, "")}"`;
    }
  }
  return null;
}

type Validated = { ok: true; resolved: string } | { ok: false; error: string };

function validatePath(filePath: string): Validated {
  if (!filePath) return { ok: false, error: "file_path is required" };
  if (!filePath.startsWith("/")) {
    return { ok: false, error: "file_path must be absolute" };
  }

  const resolved = resolveRealPath(filePath);
  const forbidden = isForbidden(resolved);
  if (forbidden) {
    return { ok: false, error: `Refused: ${forbidden}` };
  }

  const allowed = parseAllowedPaths();
  // Mirror src/config.ts TEMP_PATHS — /tmp is always read-allowed for bot
  // scratch and inbound attachments, so send_file from /tmp is permitted.
  const effectiveAllowed = [...allowed, "/tmp", "/private/tmp", "/var/folders"];
  if (!isUnderAllowedRoot(resolved, effectiveAllowed)) {
    return {
      ok: false,
      error: `Refused: path ${resolved} is outside ALLOWED_PATHS`,
    };
  }

  return { ok: true, resolved };
}

function sizeLimitFor(filePath: string): { limit: number; kind: "photo" | "document" } {
  const lastDot = filePath.lastIndexOf(".");
  const ext = lastDot === -1 ? "" : filePath.slice(lastDot).toLowerCase();
  if (PHOTO_EXTENSIONS.has(ext)) {
    return { limit: PHOTO_MAX_SIZE, kind: "photo" };
  }
  return { limit: DOCUMENT_MAX_SIZE, kind: "document" };
}

function errorResponse(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

const server = new Server(
  { name: "send-file", version: "1.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "send_file",
      description:
        "Send a file to the user via Telegram. Supports images (png, jpg, gif, webp), videos (mp4, mov, avi, webm, mkv), audio (mp3, wav, ogg, flac, m4a), and any other file type. By default, images are sent as photos (Telegram-compressed, 10MB limit). Set send_as_document=true to send any file — including images — as a document (original quality, no compression, 50MB limit). The path must be absolute and within ALLOWED_PATHS (or /tmp). Dotfile dirs (.git, .claude, .ssh) and secret filenames are refused. Fire-and-forget: you can continue generating after calling this tool.",
      inputSchema: {
        type: "object" as const,
        properties: {
          file_path: {
            type: "string",
            description:
              "Absolute path to the file to send. Must be inside ALLOWED_PATHS or /tmp.",
          },
          caption: {
            type: "string",
            description: "Optional caption displayed with the file in Telegram.",
          },
          send_as_document: {
            type: "boolean",
            description:
              "If true, send the file as a document regardless of extension. Preserves original quality for images (no Telegram compression). Applies the 50MB document size limit instead of the 10MB photo limit.",
          },
        },
        required: ["file_path"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "send_file") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const args = request.params.arguments as { file_path?: string; caption?: string; send_as_document?: boolean };
  const filePath = args.file_path ?? "";
  const caption = args.caption ?? "";
  const sendAsDocument = args.send_as_document === true;

  const validation = validatePath(filePath);
  if (!validation.ok) {
    return errorResponse(`Error: ${validation.error}`);
  }

  const resolvedPath = validation.resolved;

  let size: number;
  try {
    const file = Bun.file(resolvedPath);
    size = file.size;
  } catch {
    return errorResponse(`Error: Cannot access file: ${resolvedPath}`);
  }
  if (size === 0) {
    return errorResponse(`Error: File not found or empty: ${resolvedPath}`);
  }

  const { limit, kind } = sendAsDocument
    ? { limit: DOCUMENT_MAX_SIZE, kind: "document" as const }
    : sizeLimitFor(resolvedPath);
  if (size > limit) {
    const sizeMB = (size / (1024 * 1024)).toFixed(1);
    const limitMB = (limit / (1024 * 1024)).toFixed(0);
    return errorResponse(
      `Error: File too large (${sizeMB}MB). Telegram ${kind} limit is ${limitMB}MB.`
    );
  }

  const chatId = process.env.TELEGRAM_CHAT_ID || "";
  if (!chatId) {
    return errorResponse("Error: TELEGRAM_CHAT_ID not set. Cannot determine recipient.");
  }

  const requestUuid = crypto.randomUUID().slice(0, 8);
  const fileName = resolvedPath.split(sep).pop() || "file";

  const requestData = {
    request_id: requestUuid,
    file_path: resolvedPath,
    caption,
    status: "pending",
    chat_id: chatId,
    size_bytes: size,
    send_kind: kind,
    created_at: new Date().toISOString(),
  };

  const requestFile = `/tmp/send-file-${requestUuid}.json`;
  await Bun.write(requestFile, JSON.stringify(requestData, null, 2));

  return {
    content: [
      {
        type: "text" as const,
        text: `File queued for delivery: ${fileName} (${(size / (1024 * 1024)).toFixed(2)}MB, ${kind})`,
      },
    ],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Send File MCP server running on stdio");
}

main().catch(console.error);
