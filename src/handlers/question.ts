/**
 * Question handler for AskUserQuestion built-in tool interception.
 *
 * Bridges Claude Code's AskUserQuestion tool to Telegram inline keyboards.
 * When canUseTool sees toolName === "AskUserQuestion", it routes here instead
 * of the normal Allow/Deny permission flow. User taps an option → we return
 * deny-with-message containing the selection, which Claude parses as the answer.
 *
 * MVP limitations: first question only, single-select only, no "Other" option.
 */

import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { escapeHtml } from "../formatting";

interface PendingQuestion {
  resolve: (result: PermissionResult) => void;
  timeout: ReturnType<typeof setTimeout>;
  question: string;
  options: string[];
}

const pendingQuestions = new Map<string, PendingQuestion>();
const QUESTION_TIMEOUT_MS = 900_000; // 15 minutes

export function awaitQuestionAnswer(
  requestId: string,
  question: string,
  options: string[]
): Promise<PermissionResult> {
  return new Promise<PermissionResult>((resolve) => {
    const timeout = setTimeout(() => {
      if (pendingQuestions.delete(requestId)) {
        console.warn(
          `Question request ${requestId} timed out after ${QUESTION_TIMEOUT_MS / 1000}s — auto-denying`
        );
        resolve({
          behavior: "deny",
          message: "User did not answer the question in time",
          interrupt: true,
        });
      }
    }, QUESTION_TIMEOUT_MS);

    pendingQuestions.set(requestId, { resolve, timeout, question, options });
  });
}

export function resolveQuestionRequest(
  requestId: string,
  optionIndex: number
): { ok: boolean; label?: string } {
  const pending = pendingQuestions.get(requestId);
  if (!pending) return { ok: false };
  if (optionIndex < 0 || optionIndex >= pending.options.length) return { ok: false };

  clearTimeout(pending.timeout);
  pendingQuestions.delete(requestId);

  const label = pending.options[optionIndex]!;
  pending.resolve({
    behavior: "deny",
    message: `User selected "${label}" in answer to: "${pending.question}". Treat this as the user's chosen answer and continue.`,
    interrupt: false,
  });

  return { ok: true, label };
}

export function createQuestionKeyboard(
  requestId: string,
  options: string[]
): InlineKeyboard {
  const kb = new InlineKeyboard();
  options.forEach((label, idx) => {
    const buttonLabel = label.length > 60 ? label.slice(0, 57) + "..." : label;
    kb.text(buttonLabel, `askq:${requestId}:${idx}`).row();
  });
  return kb;
}

function formatQuestionPrompt(
  question: string,
  header: string | undefined,
  options: Array<{ label: string; description?: string }>
): string {
  const parts: string[] = [];
  if (header) parts.push(`<i>${escapeHtml(header)}</i>`);
  parts.push(`❓ <b>${escapeHtml(question)}</b>`);
  if (options.some((o) => o.description)) {
    parts.push("");
    for (const opt of options) {
      if (opt.description) {
        parts.push(
          `• <b>${escapeHtml(opt.label)}</b> — ${escapeHtml(opt.description)}`
        );
      } else {
        parts.push(`• <b>${escapeHtml(opt.label)}</b>`);
      }
    }
  }
  return parts.join("\n");
}

/**
 * Handle an AskUserQuestion tool call: render inline keyboard, await tap,
 * return deny-with-message containing the selection.
 */
export async function handleAskUserQuestion(
  ctx: Context,
  input: Record<string, unknown>
): Promise<PermissionResult> {
  const questions = (input.questions as Array<Record<string, unknown>>) || [];
  if (questions.length === 0) {
    return {
      behavior: "deny",
      message: "No questions provided to AskUserQuestion",
      interrupt: true,
    };
  }

  if (questions.length > 1) {
    console.warn(
      `AskUserQuestion received ${questions.length} questions — only first will be asked (MVP limitation)`
    );
  }

  const q = questions[0]!;
  if (q.multiSelect) {
    console.warn(
      "AskUserQuestion multiSelect requested — treating as single-select (MVP limitation)"
    );
  }

  const questionText = String(q.question || "");
  const header = q.header ? String(q.header) : undefined;
  const rawOptions = (q.options as Array<Record<string, unknown>>) || [];
  const optionMeta = rawOptions.map((o) => ({
    label: String(o.label || ""),
    description: o.description ? String(o.description) : undefined,
  }));
  const labels = optionMeta.map((o) => o.label).filter((l) => l.length > 0);

  if (labels.length === 0) {
    return {
      behavior: "deny",
      message: "AskUserQuestion had no valid options",
      interrupt: true,
    };
  }

  const requestId = crypto.randomUUID();
  const promptText = formatQuestionPrompt(questionText, header, optionMeta);
  const keyboard = createQuestionKeyboard(requestId, labels);

  try {
    await ctx.reply(promptText, {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });
  } catch (err) {
    console.error("Failed to send question keyboard:", err);
    return {
      behavior: "deny",
      message: "Could not reach Telegram to ask question",
      interrupt: true,
    };
  }

  console.log(
    `Question request ${requestId} — awaiting Telegram answer (${labels.length} options)`
  );
  return awaitQuestionAnswer(requestId, questionText, labels);
}
