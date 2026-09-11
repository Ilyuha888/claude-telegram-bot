/**
 * Document handler for Claude Telegram Bot.
 *
 * Supports PDFs, archives and text files. Each document becomes one part of the
 * next turn; several sent as one album coalesce through the collector rather
 * than through a buffer of their own.
 * PDF extraction uses pdftotext CLI (install via: brew install poppler)
 */

import type { Context } from "grammy";
import type { TurnPart } from "../turn/part";
import { convKeyFromCtx } from "../conversation";
import { ALLOWED_USER, TEMP_DIR } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import { auditLogRateLimit, buildMessageContext, startTypingIndicator } from "../utils";
import { isAudioFile, processAudioFile } from "./audio";
import {
  beginArrival,
  endArrival,
  hasPending,
  submitPart,
} from "../turn/collector";

// Supported text file extensions
const TEXT_EXTENSIONS = [
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".ts",
  ".py",
  ".sh",
  ".env",
  ".log",
  ".cfg",
  ".ini",
  ".toml",
];

// Supported archive extensions
const ARCHIVE_EXTENSIONS = [".zip", ".tar", ".tar.gz", ".tgz"];

// Max file size (10MB)
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// Max content from archive (50K chars total)
const MAX_ARCHIVE_CONTENT = 50000;

/**
 * Download a document and return the local path.
 */
async function downloadDocument(ctx: Context): Promise<string> {
  const doc = ctx.message?.document;
  if (!doc) {
    throw new Error("No document in message");
  }

  const file = await ctx.getFile();
  const fileName = doc.file_name || `doc_${Date.now()}`;

  // Sanitize filename
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const docPath = `${TEMP_DIR}/${safeName}`;

  // Download
  const response = await fetch(
    `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`
  );
  const buffer = await response.arrayBuffer();
  await Bun.write(docPath, buffer);

  return docPath;
}

/**
 * Extract text from a document.
 */
async function extractText(
  filePath: string,
  mimeType?: string
): Promise<string> {
  const fileName = filePath.split("/").pop() || "";
  const extension = "." + (fileName.split(".").pop() || "").toLowerCase();

  // PDF extraction using pdftotext CLI (install: brew install poppler)
  if (mimeType === "application/pdf" || extension === ".pdf") {
    try {
      const result = await Bun.$`pdftotext -layout ${filePath} -`.quiet();
      return result.text();
    } catch (error) {
      console.error("PDF parsing failed:", error);
      return "[PDF parsing failed - ensure pdftotext is installed: apt-get install poppler-utils]";
    }
  }

  // Text files
  if (TEXT_EXTENSIONS.includes(extension) || mimeType?.startsWith("text/")) {
    const text = await Bun.file(filePath).text();
    // Limit to 100K chars
    return text.slice(0, 100000);
  }

  throw new Error(`Unsupported file type: ${extension || mimeType}`);
}

/**
 * Check if a file extension is an archive.
 */
function isArchive(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Get archive extension from filename.
 */
function getArchiveExtension(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".tar.gz")) return ".tar.gz";
  if (lower.endsWith(".tgz")) return ".tgz";
  if (lower.endsWith(".tar")) return ".tar";
  if (lower.endsWith(".zip")) return ".zip";
  return "";
}

/**
 * Extract an archive to a temp directory.
 */
async function extractArchive(
  archivePath: string,
  fileName: string
): Promise<string> {
  const ext = getArchiveExtension(fileName);
  const extractDir = `${TEMP_DIR}/archive_${Date.now()}`;
  await Bun.$`mkdir -p ${extractDir}`;

  if (ext === ".zip") {
    await Bun.$`unzip -q -o ${archivePath} -d ${extractDir}`.quiet();
  } else if (ext === ".tar" || ext === ".tar.gz" || ext === ".tgz") {
    await Bun.$`tar -xf ${archivePath} -C ${extractDir}`.quiet();
  } else {
    throw new Error(`Unknown archive type: ${ext}`);
  }

  return extractDir;
}

/**
 * Build a file tree from a directory.
 */
async function buildFileTree(dir: string): Promise<string[]> {
  const entries = await Array.fromAsync(
    new Bun.Glob("**/*").scan({ cwd: dir, dot: false })
  );
  entries.sort();
  return entries.slice(0, 100); // Limit to 100 files
}

/**
 * Extract text content from archive files.
 */
async function extractArchiveContent(
  extractDir: string
): Promise<{
  tree: string[];
  contents: Array<{ name: string; content: string }>;
}> {
  const tree = await buildFileTree(extractDir);
  const contents: Array<{ name: string; content: string }> = [];
  let totalSize = 0;

  for (const relativePath of tree) {
    const fullPath = `${extractDir}/${relativePath}`;
    const stat = await Bun.file(fullPath).exists();
    if (!stat) continue;

    // Check if it's a directory
    const fileInfo = Bun.file(fullPath);
    const size = fileInfo.size;
    if (size === 0) continue;

    const ext = "." + (relativePath.split(".").pop() || "").toLowerCase();
    if (!TEXT_EXTENSIONS.includes(ext)) continue;

    // Skip large files
    if (size > 100000) continue;

    try {
      const text = await fileInfo.text();
      const truncated = text.slice(0, 10000); // 10K per file max
      if (totalSize + truncated.length > MAX_ARCHIVE_CONTENT) break;
      contents.push({ name: relativePath, content: truncated });
      totalSize += truncated.length;
    } catch {
      // Skip binary or unreadable files
    }
  }

  return { tree, contents };
}

/**
 * A part with everything but its place in the arrival order — the preparers
 * build the content, `handleDocument` stamps the seq and the album id it
 * already holds.
 */
type PreparedPart = Omit<TurnPart, "seq" | "mediaGroupId">;

/**
 * Extract an archive and inline its tree and readable text into one part.
 *
 * The extraction directory is removed as soon as the prompt is built: its
 * contents are already inlined, and nothing downstream reads it. That used to
 * happen after the turn, which is no longer a bounded wait.
 */
async function prepareArchivePart(
  ctx: Context,
  archivePath: string,
  fileName: string,
  caption: string | undefined
): Promise<PreparedPart | null> {
  // The one status message this handler still posts. Extraction is the only
  // preparation step slow enough to look like a hang, and it has a real result
  // to report. It goes away at submit time, like every other handler's — the
  // answer itself may be a whole burst away.
  const statusMsg = await ctx.reply(`📦 Extracting <b>${fileName}</b>...`, {
    parse_mode: "HTML",
  });

  try {
    console.log(`Extracting archive: ${fileName}`);
    const extractDir = await extractArchive(archivePath, fileName);
    const { tree, contents } = await extractArchiveContent(extractDir);
    console.log(`Extracted: ${tree.length} files, ${contents.length} readable`);

    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      `📦 Extracted <b>${fileName}</b>: ${tree.length} files, ${contents.length} readable`,
      { parse_mode: "HTML" }
    );

    const treeStr = tree.length > 0 ? tree.join("\n") : "(empty)";
    const contentsStr =
      contents.length > 0
        ? contents.map((c) => `--- ${c.name} ---\n${c.content}`).join("\n\n")
        : "(no readable text files)";

    const context = buildMessageContext(ctx, { attachments: [archivePath] });
    const text = `Archive: ${fileName}\n\nFile tree (${tree.length} files):\n${treeStr}\n\nExtracted contents:\n${contentsStr}\n\n---\n\n${context}`;

    await Bun.$`rm -rf ${extractDir}`.quiet();

    return {
      kind: "archive",
      messageId: ctx.message?.message_id,
      text,
      media: [],
      audit: { kind: "ARCHIVE", summary: `[${fileName}] ${caption || ""}` },
      titleSeed: caption || `[Archivio: ${fileName}]`,
      bytes: text.length,
    };
  } catch (error) {
    console.error("Archive processing error:", error);
    await ctx.reply(
      `❌ Failed to process archive: ${String(error).slice(0, 100)}`
    );
    return null;
  } finally {
    try {
      await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
    } catch {
      // Ignore deletion errors
    }
  }
}

/**
 * A PDF, as a native document content block — no pdftotext dependency.
 */
async function preparePdfPart(
  ctx: Context,
  pdfPath: string,
  fileName: string,
  caption: string | undefined
): Promise<PreparedPart | null> {
  let base64Data: string;
  try {
    const data = await Bun.file(pdfPath).arrayBuffer();
    base64Data = Buffer.from(data).toString("base64");
  } catch (error) {
    console.error(`Failed to read PDF ${pdfPath}:`, error);
    await ctx.reply("❌ Failed to read the downloaded document.");
    return null;
  }

  const text = `Document: ${fileName}\n\n${buildMessageContext(ctx, {
    attachments: [pdfPath],
  })}`;

  return {
    kind: "pdf",
    messageId: ctx.message?.message_id,
    text,
    media: [
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: base64Data,
        },
      },
    ],
    audit: { kind: "DOCUMENT", summary: `[PDF: ${fileName}] ${caption || ""}` },
    titleSeed: caption || `[PDF: ${fileName}]`,
    bytes: base64Data.length + text.length,
  };
}

/**
 * A text-ish document, inlined.
 */
async function prepareTextPart(
  ctx: Context,
  docPath: string,
  fileName: string,
  caption: string | undefined,
  mimeType: string | undefined
): Promise<PreparedPart | null> {
  let content: string;
  try {
    content = await extractText(docPath, mimeType);
  } catch (error) {
    console.error("Failed to extract document:", error);
    await ctx.reply(
      `❌ Failed to process document: ${String(error).slice(0, 100)}`
    );
    return null;
  }

  const text = `Document: ${fileName}\n\nContent:\n${content}\n\n---\n\n${buildMessageContext(
    ctx,
    { attachments: [docPath] }
  )}`;

  return {
    kind: "doctext",
    messageId: ctx.message?.message_id,
    text,
    media: [],
    audit: { kind: "DOCUMENT", summary: `[${fileName}] ${caption || ""}` },
    titleSeed: caption || `[Documento: ${fileName}]`,
    bytes: text.length,
  };
}

/**
 * Handle incoming document messages.
 *
 * Several documents sent as one album are no longer buffered here: each is an
 * ordinary part carrying the album's `media_group_id`, which the collector reads
 * as a floor on the debounce window. The visible change is that every document's
 * own caption now reaches Claude bound to that document — the old buffer kept
 * one caption for the whole group.
 */
export async function handleDocument(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const doc = ctx.message?.document;
  const mediaGroupId = ctx.message?.media_group_id;
  const caption = ctx.message?.caption;

  if (!userId || !chatId || !doc) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USER)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // 2. Check file size
  if (doc.file_size && doc.file_size > MAX_FILE_SIZE) {
    await ctx.reply("❌ File too large. Maximum size is 10MB.");
    return;
  }

  // 3. Check file type
  const fileName = doc.file_name || "";
  const extension = "." + (fileName.split(".").pop() || "").toLowerCase();
  const isPdf = doc.mime_type === "application/pdf" || extension === ".pdf";
  const isText =
    TEXT_EXTENSIONS.includes(extension) || doc.mime_type?.startsWith("text/");
  const isArchiveFile = isArchive(fileName);
  const isAudio =
    !isPdf && !isText && !isArchiveFile && isAudioFile(fileName, doc.mime_type);

  if (!isPdf && !isText && !isArchiveFile && !isAudio) {
    await ctx.reply(
      `❌ Unsupported file type: ${extension || doc.mime_type}\n\n` +
        `Supported: PDF, archives (${ARCHIVE_EXTENSIONS.join(
          ", "
        )}), ${TEXT_EXTENSIONS.join(", ")}`
    );
    return;
  }

  const convKey = convKeyFromCtx(ctx);

  // 4. Claim an arrival slot. Everything above is synchronous, so this still
  // happens before the handler's first await — what R1 requires.
  const seq = beginArrival(convKey);
  const typing = startTypingIndicator(ctx);

  try {
    // 5. Rate limit. Skipped mid-burst, which is also what keeps an album of
    // documents from being charged once per file — the rule the old media-group
    // buffer applied by checking only its first item.
    if (!hasPending(convKey)) {
      const [allowed, retryAfter] = rateLimiter.check(userId);
      if (!allowed) {
        await auditLogRateLimit(userId, username, retryAfter!);
        await ctx.reply(
          `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
        );
        return;
      }
    }

    console.log(
      `Received ${isAudio ? "audio document" : isArchiveFile ? "archive" : "document"}: ${fileName} from @${username}`
    );

    // 6. Download
    let docPath: string;
    try {
      docPath = await downloadDocument(ctx);
    } catch (error) {
      console.error("Failed to download document:", error);
      await ctx.reply(
        isAudio
          ? "❌ Failed to download audio file."
          : "❌ Failed to download document."
      );
      return;
    }

    // 7. Audio sent as a document: transcription owns the rest. The path is
    // advertised to the agent, so the file has to outlive transcription —
    // processAudioFile hands it to the turn to clean up. The arrival stays this
    // handler's (see the contract on processAudioFile).
    if (isAudio) {
      await processAudioFile(ctx, docPath, chatId, seq, [docPath]);
      return;
    }

    // 8. One document, one part.
    const prepared = isArchiveFile
      ? await prepareArchivePart(ctx, docPath, fileName, caption)
      : isPdf
        ? await preparePdfPart(ctx, docPath, fileName, caption)
        : await prepareTextPart(ctx, docPath, fileName, caption, doc.mime_type);

    if (prepared) {
      submitPart(ctx, convKey, { ...prepared, seq, mediaGroupId });
    }
  } catch (error) {
    console.error("Document processing error:", error);
    await ctx.reply("❌ Failed to process document.");
  } finally {
    typing.stop();
    endArrival(convKey);
  }
}
