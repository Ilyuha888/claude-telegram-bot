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

// ── Scheduler types ─────────────────────────────────────────────────────────

export type Schedule = {
  id: string;
  cron: string;
  tz: string;
  prompt_key: string;
  last_fired: string | null;
  one_shot?: boolean;
  payload?: {
    notification_id?: string;   // [Remind later] re-surfaces an existing notification
    reminder_message?: string;  // Scribe-created reminder — direct Telegram alert
    note_path?: string;         // absolute path to the vault note
  };
};

export type SchedulesFile = {
  schedules: Schedule[];
};

export type NotificationStatus = "unread" | "read" | "deleted";

export type Notification = {
  id: string;
  fired_at: string;
  prompt_key: string;
  title: string;
  content: string;
  telegram_message_id?: number;
  telegram_chat_id?: number;
  status: NotificationStatus;
};

export type NotificationsFile = {
  notifications: Notification[];
};
