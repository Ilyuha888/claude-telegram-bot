/**
 * Local type declarations for Telegram Bot API 10.1/10.2 "Rich Messages"
 * (`sendRichMessage` / `sendRichMessageDraft`).
 *
 * Not yet present in @grammyjs/types (checked 3.23.0, resolved via grammy's
 * `raw` proxy). Shapes below are the confirmed wire schema extracted from
 * core.telegram.org/bots/api (anchors #sendrichmessage /
 * #sendrichmessagedraft / #inputrichmessage) — see the plan file
 * `imperative-floating-wand.md`, "Confirmed wire schema" section. Do not
 * add fields that aren't in that confirmed schema without re-verifying
 * against the docs.
 *
 * Design note: @grammyjs/types' `ApiMethods<F>` (methods.d.ts) is a *type
 * alias* over an object-literal type, not an `interface` — so it cannot be
 * extended via `declare module` + interface merging (merging only works on
 * interfaces/namespaces). Instead this file declares standalone interfaces
 * for the two new methods, and `rich.ts` calls them through a small typed
 * wrapper that casts `api.raw` once at the call site (see `richRawApi()` in
 * `rich.ts`). Swap this out for real `@grammyjs/types` coverage (and drop
 * the cast) once upstream catches up.
 */

import type {
  InlineKeyboardMarkup,
  Message,
  ReplyParameters,
} from "grammy/types";

/**
 * Referenced media for an InputRichMessage, addressed from `markdown`/`html`
 * via `tg://photo|video|audio?id=...`. Unused by this codebase (text-only
 * bot replies) but included for schema completeness.
 */
export interface InputRichMessageMedia {
  /** 1-64 chars, [A-Za-z0-9_-] only, as referenced by the tg:// link. */
  id: string;
  /** InputMediaAnimation | InputMediaAudio | InputMediaPhoto | InputMediaVideo
   *  | InputMediaVoiceNote. Left loose: unused by this codebase. */
  media: unknown;
}

/**
 * The structured content object carried by both `sendRichMessage` and
 * `sendRichMessageDraft`. Exactly one of `blocks` / `html` / `markdown` must
 * be set — this codebase always uses `markdown` (Rich Markdown: a
 * GFM-compatible superset with arbitrary inline HTML allowed).
 */
export interface InputRichMessage {
  /** Structured-block form. Not used by this codebase. */
  blocks?: unknown[];
  /** Rich HTML. Mutually exclusive with markdown/blocks. Not used by this codebase. */
  html?: string;
  /** Rich Markdown — the field this codebase populates. */
  markdown?: string;
  /** Referenced media. Not used by this codebase (text-only replies). */
  media?: InputRichMessageMedia[];
  is_rtl?: boolean;
  /** Disable auto-linking of URLs/emails/@mentions/#hashtags/phone/card numbers. */
  skip_entity_detection?: boolean;
}

export interface SendRichMessageParams {
  chat_id: number | string;
  rich_message: InputRichMessage;
  reply_markup?: InlineKeyboardMarkup;
  reply_parameters?: ReplyParameters;
  disable_notification?: boolean;
  protect_content?: boolean;
  message_thread_id?: number;
  business_connection_id?: string;
}

export interface SendRichMessageDraftParams {
  /** Integer only (not Integer|String) — drafts are private-chat only. */
  chat_id: number;
  /** Required, nonzero. Reuse the same id across updates within one logical
   *  segment so Telegram animates the transition between draft versions;
   *  use a fresh id when starting a new segment. */
  draft_id: number;
  rich_message: InputRichMessage;
  message_thread_id?: number;
}

/**
 * A Rich Message as it arrives on an *incoming* update — the read side of
 * `sendRichMessage`, and a different object from `InputRichMessage` above
 * (that one is what you send; this one is what Telegram gives back).
 *
 * **Shape verified against a real payload**, unlike the first version of this
 * declaration. An observed forward of one of this bot's own long answers was:
 *
 *     rich_message: { blocks: [ { type: "paragraph", text: "…" },
 *                               { type: "pre",       text: "…" }, … ] }   // 11 blocks
 *
 * Three things that cost three restarts to learn, all of them contradicting a
 * summarised reading of core.telegram.org/bots/api:
 *
 *  - There is **no flat `text`** field. The earlier declaration asserted
 *    `text: string` as "the plain text representation"; it does not arrive, and
 *    `incomingRichText` reading it returned undefined for every real message.
 *  - `blocks` is the ONLY key present — no `entities` alongside it.
 *  - Block `type` values are lowercase short names (`paragraph`, `pre`), not the
 *    `RichBlockParagraph` identifiers the docs list as type names.
 *
 * So the flat fields below are optional and marked unobserved: they are a
 * forward-compatibility hedge, not a description of what Telegram sends. Content
 * is reconstructed by walking `blocks` — see `incomingRichText` in rich.ts.
 */
export interface RichMessage {
  /** Array of blocks. The only field actually observed on the wire. */
  blocks?: unknown[];
  /** NOT observed — hedge only. Do not rely on this being present. */
  text?: string;
  /** NOT observed — hedge only. */
  markdown?: string;
  /** NOT observed — hedge only. */
  html?: string;
  /** NOT observed alongside `blocks`. Loose: unused by this codebase. */
  entities?: unknown[];
}

/**
 * `Message` plus the field that carries Rich Message content.
 *
 * Declared as a separate interface rather than merged into `@grammyjs/types`'
 * `Message` for the same reason `ApiMethods` can't be extended (see the note at
 * the top of this file) — consumers narrow to it with a cast at the call site,
 * exactly like `richRawApi()` does for the send side.
 *
 * The field matters because **`text` is NOT populated for a Rich Message**. A
 * bot reading only `message.text` sees an incoming Rich Message as contentless:
 * `bot.on("message:text")` never matches it, and a reply to one degrades to a
 * "[non-text message]" placeholder. Both were live bugs.
 */
export interface MessageWithRichMessage extends Message {
  /** Present iff the message is a rich formatted message. */
  rich_message?: RichMessage;
}

/**
 * The two Rich Message methods, typed as documented. `sendRichMessage`
 * returns the sent Message (so its message_id can be tracked, e.g. for
 * later deletion on error/`/stop`); `sendRichMessageDraft` returns `true`
 * on success — there is no message reference to track during streaming.
 */
export interface RichMessageRawApi {
  sendRichMessage(args: SendRichMessageParams): Promise<Message>;
  sendRichMessageDraft(args: SendRichMessageDraftParams): Promise<true>;
}
