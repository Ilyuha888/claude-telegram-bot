/**
 * Runtime configuration for the bot's Claude model.
 *
 * Lives in BOT_DATA_DIR rather than src/config.ts on purpose: config.ts runs
 * top-level awaits and can process.exit(1), and every mode-2 module imports
 * from it. This file is inert data with no import-time side effects, so it can
 * be re-read on a hot path safely.
 *
 * Read once per new session (see ClaudeSession.sendMessageStreaming), so
 * /model followed by /new applies without restarting the service.
 */

import { readFile, writeFile, rename } from "fs/promises";
import { BOT_DATA_DIR } from "./config";

export const RUNTIME_CONFIG_FILE = `${BOT_DATA_DIR}/runtime-config.json`;

export interface RuntimeConfig {
  /** Model id passed to the SDK as options.model, and to mode-2 as ANTHROPIC_MODEL. */
  model: string;
}

/** Used when the file is absent, unreadable, or missing keys. */
export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  model: "claude-opus-5[1m]",
};

// Serialize reads/writes so a concurrent /model can't interleave with a load.
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn);
  queue = result.catch(() => {});
  return result;
}

/**
 * A model id must be a non-empty single token. The optional [1m] suffix selects
 * the 1M-context variant — the CLI strips it and attaches the long-context beta.
 * Deliberately permissive about the id itself: the CLI's model table lags behind
 * what the API accepts, so an allowlist here would reject valid new models.
 */
export function isValidModelId(model: string): boolean {
  return /^[a-z0-9][a-z0-9.-]*(\[1m\])?$/i.test(model) && model.length <= 64;
}

async function readRaw(): Promise<Partial<RuntimeConfig>> {
  try {
    const raw = await readFile(RUNTIME_CONFIG_FILE, "utf-8");
    return JSON.parse(raw) as Partial<RuntimeConfig>;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    const corrupted = `${RUNTIME_CONFIG_FILE}.corrupted-${Date.now()}`;
    try {
      await rename(RUNTIME_CONFIG_FILE, corrupted);
    } catch {
      /* best effort */
    }
    console.error(
      `[runtime-config] runtime-config.json unreadable, backed up to ${corrupted} — using defaults`,
    );
    return {};
  }
}

/**
 * Load the effective config. Never throws and never returns an invalid model —
 * a bad hand-edit degrades to the default rather than bricking the bot.
 */
export function loadRuntimeConfig(): Promise<RuntimeConfig> {
  return enqueue(async () => {
    const raw = await readRaw();
    const model =
      typeof raw.model === "string" && isValidModelId(raw.model)
        ? raw.model
        : DEFAULT_RUNTIME_CONFIG.model;
    if (raw.model !== undefined && model !== raw.model) {
      console.warn(
        `[runtime-config] ignoring invalid model ${JSON.stringify(raw.model)} — using ${model}`,
      );
    }
    return { model };
  });
}

/** Persist a new model. Atomic tmp-write + rename so a crash can't truncate it. */
export function setModel(model: string): Promise<RuntimeConfig> {
  return enqueue(async () => {
    const raw = await readRaw();
    const next: RuntimeConfig = { ...DEFAULT_RUNTIME_CONFIG, ...raw, model };
    const tmp = `${RUNTIME_CONFIG_FILE}.tmp-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf-8");
    await rename(tmp, RUNTIME_CONFIG_FILE);
    return next;
  });
}
