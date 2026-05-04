import { REAPER_INTERVAL_MS, REAPER_IDLE_THRESHOLD_MS, REPOS_DIR } from "../config";
import { resolve, join } from "path";
import * as store from "./store";
import * as sh from "./sh";
import { auditLog } from "../utils";

async function reapIdleSessions(): Promise<void> {
  const sessions = await store.list();
  const now = Date.now();

  for (const s of sessions) {
    if (s.closed) continue;
    const idleMs = now - new Date(s.last_attached_at).getTime();
    if (idleMs < REAPER_IDLE_THRESHOLD_MS) continue;

    await sh.tmuxGracefulExit(s.tmux_name);
    if (s.worktree_path) {
      await sh.gitWorktreeRemove(resolve(join(REPOS_DIR, s.repo)), s.worktree_path).catch(() => {/* best-effort */});
    }
    await store.markClosed(s.slug, "idle_reaper");
    await auditLog(0, "reaper", "mode2.reaper.close", `slug=${s.slug} idle_ms=${idleMs}`);
    console.log(JSON.stringify({ event: "mode2.reaper.close", slug: s.slug, idle_ms: idleMs }));
  }
}

export async function resumeOnBoot(): Promise<void> {
  const sessions = await store.list();
  for (const s of sessions) {
    if (s.closed) continue;
    const alive = await sh.tmuxHasSession(s.tmux_name);
    if (alive) continue;

    // Attempt to respawn the RC server under a new tmux session
    const result = await sh.tmuxNewSession(s.tmux_name, s.path, s.rc_name);
    if (result.ok) {
      await auditLog(0, "boot", "mode2.resume.boot", `slug=${s.slug}`);
      console.log(JSON.stringify({ event: "mode2.resume.boot", slug: s.slug }));
    } else {
      await store.markClosed(s.slug, "boot_resume_failed");
      await auditLog(0, "boot", "mode2.resume.boot.failed", `slug=${s.slug} stderr=${result.stderr.slice(0, 200)}`);
      console.error(JSON.stringify({ event: "mode2.resume.boot.failed", slug: s.slug, stderr: result.stderr }));
    }
  }
}

export function startReaper(): void {
  setInterval(() => {
    reapIdleSessions().catch((err) => {
      console.error(JSON.stringify({ event: "mode2.reaper.error", error: String(err) }));
    });
  }, REAPER_INTERVAL_MS);
}
