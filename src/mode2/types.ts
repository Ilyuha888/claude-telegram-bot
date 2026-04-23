export type ShResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
};

export type WorkSession = {
  slug: string;
  repo: string;
  path: string;
  worktree_path: string | null;
  branch: string | null;
  tmux_name: string;
  rc_name: string;
  created_at: string;
  last_attached_at: string;
  closed: boolean;
  close_reason?: "user" | "idle_reaper" | "boot_resume_failed";
};

export type SessionsFile = {
  sessions: WorkSession[];
};
