/**
 * Makes a fresh git worktree actually usable as a Claude session workspace.
 *
 * `git worktree add` checks out tracked files only, so a new worktree has no
 * node_modules, no .env, and no .claude/settings.local.json — all gitignored.
 * A session spawned there can read the code but can't install, run or test it,
 * which is why per-session worktrees were dropped from /menu in 76eefe1.
 *
 * This closes that gap instead of removing the feature:
 *   - heavy ignored directories are symlinked back to the parent checkout
 *   - small ignored config files are copied (with their permissions)
 *   - the new absolute path is pre-registered as trusted, because Claude Code
 *     keys workspace trust by exact path and a headless `remote-control`
 *     server has no way to show a trust dialog
 *
 * Everything here is best-effort: a session with no node_modules is still
 * worth having, so failures warn rather than abort the spawn.
 */

import { access, copyFile, mkdir, readFile, rename, stat, symlink, writeFile } from "fs/promises";
import { constants } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { WORKTREE_COPY_PATHS, WORKTREE_LINK_PATHS } from "../config";

export interface BootstrapResult {
  linked: string[];
  copied: string[];
  trusted: boolean;
  warnings: string[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Register `path` as a trusted workspace in ~/.claude.json.
 *
 * Read-modify-write on a file the CLI also owns, so: skip when already
 * trusted, keep a one-time backup, write via tmp+rename, and only ever add a
 * nested key. Returns false rather than throwing — trust is a convenience
 * here, not a precondition for the spawn.
 */
async function trustWorkspace(path: string): Promise<boolean> {
  const configPath = join(homedir(), ".claude.json");
  try {
    const raw = await readFile(configPath, "utf-8");
    const cfg = JSON.parse(raw) as {
      projects?: Record<string, Record<string, unknown>>;
    };

    if (cfg.projects?.[path]?.hasTrustDialogAccepted === true) return true;

    // One-time safety net before this code ever mutates the CLI's own state.
    const backup = `${configPath}.bak-worktree-bootstrap`;
    if (!(await exists(backup))) {
      await writeFile(backup, raw, { mode: 0o600 });
    }

    cfg.projects ??= {};
    cfg.projects[path] = {
      ...(cfg.projects[path] ?? {}),
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    };

    const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    await rename(tmp, configPath);
    return true;
  } catch (e) {
    console.warn(`[worktree-bootstrap] could not pre-trust ${path}: ${e}`);
    return false;
  }
}

/**
 * Populate a freshly created worktree from its parent checkout.
 *
 * @param repoPath      the main checkout, source of the ignored files
 * @param worktreePath  the new worktree, assumed to already exist
 */
export async function bootstrapWorktree(
  repoPath: string,
  worktreePath: string,
): Promise<BootstrapResult> {
  const result: BootstrapResult = { linked: [], copied: [], trusted: false, warnings: [] };

  for (const rel of WORKTREE_LINK_PATHS) {
    const src = resolve(join(repoPath, rel));
    const dest = resolve(join(worktreePath, rel));
    // Guard against a configured path escaping the worktree via ../
    if (!dest.startsWith(resolve(worktreePath))) continue;
    try {
      if (!(await exists(src))) continue;
      if (await exists(dest)) continue; // tracked in git, or already linked
      await mkdir(dirname(dest), { recursive: true });
      await symlink(src, dest, "dir");
      result.linked.push(rel);
    } catch (e) {
      result.warnings.push(`link ${rel}: ${e}`);
    }
  }

  for (const rel of WORKTREE_COPY_PATHS) {
    const src = resolve(join(repoPath, rel));
    const dest = resolve(join(worktreePath, rel));
    if (!dest.startsWith(resolve(worktreePath))) continue;
    try {
      if (!(await exists(src))) continue;
      if (await exists(dest)) continue; // never clobber a tracked file
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(src, dest);
      // These carry secrets (.env, settings.local.json) — preserve the source
      // mode rather than inheriting a default umask.
      const { mode } = await stat(src);
      await import("fs/promises").then((fs) => fs.chmod(dest, mode));
      result.copied.push(rel);
    } catch (e) {
      result.warnings.push(`copy ${rel}: ${e}`);
    }
  }

  result.trusted = await trustWorkspace(resolve(worktreePath));

  console.log(
    JSON.stringify({
      event: "mode2.worktree.bootstrap",
      worktree: worktreePath,
      linked: result.linked,
      copied: result.copied,
      trusted: result.trusted,
      warnings: result.warnings,
    }),
  );

  return result;
}

/** One-line summary for the Telegram spawn message; empty when nothing happened. */
export function summarizeBootstrap(r: BootstrapResult): string {
  const bits: string[] = [];
  if (r.linked.length) bits.push(`linked ${r.linked.join(", ")}`);
  if (r.copied.length) bits.push(`copied ${r.copied.join(", ")}`);
  if (r.trusted) bits.push("trusted");
  if (!bits.length) return "";
  const warn = r.warnings.length ? ` · ${r.warnings.length} warning(s)` : "";
  return `${bits.join(" · ")}${warn}`;
}
