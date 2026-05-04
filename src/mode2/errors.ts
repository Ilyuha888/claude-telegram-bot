export class TmuxMissing extends Error {
  constructor() {
    super("tmux not found on PATH — install tmux on the VM");
    this.name = "TmuxMissing";
  }
}

export class SpawnFailed extends Error {
  constructor(
    public readonly slug: string,
    public readonly stderr: string
  ) {
    super(`RC spawn failed for ${slug}: ${stderr.slice(0, 200)}`);
    this.name = "SpawnFailed";
  }
}

export class WorktreeExists extends Error {
  constructor(public readonly worktree_path: string) {
    super(`Worktree already exists at ${worktree_path}`);
    this.name = "WorktreeExists";
  }
}

export class SessionNotFound extends Error {
  constructor(public readonly slug: string) {
    super(`Session not found: ${slug}`);
    this.name = "SessionNotFound";
  }
}

export class RepoNotFound extends Error {
  constructor(public readonly repo: string) {
    super(`Repo not found or not accessible: ${repo}`);
    this.name = "RepoNotFound";
  }
}
