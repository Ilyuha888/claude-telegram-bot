---
id: evid-20260423-telegram-walkthrough
kind: EvidencePack
version: 1
status: active
title: Mode-2 Telegram Walkthrough — 2026-04-23
created_at: 2026-04-23T10:00:00Z
updated_at: 2026-04-23T10:00:00Z
links:
  - ref: dec-20260422-003
    type: supports
---

# Mode-2 Telegram Walkthrough — 2026-04-23

## Test conditions
- Bot running as `assistant` via systemd (`claude-telegram-bot.service`)
- REPOS_DIR: `/home/assistant/repos`
- Both repos present: `claude-telegram-bot`, `my_obsidian_knowledge_base`

## Commands exercised

### /repos (via /menu → sessions list)
Bot listed both repos correctly. ✓

### /work (via /menu → Work → claude-telegram-bot)
- New worktree created at `.worktrees/claude-telegram-bot-dbb5e467`
- Branch `session/claude-telegram-bot-dbb5e467` created from `main`
- tmux session `work-claude-telegram-bot-dbb5e467` spawned
- RC session visible at claude.ai/code
- sessions.json entry written with correct metadata

Second session spawned simultaneously:
- slug: `claude-telegram-bot-3ac41d88`, branch `session/claude-telegram-bot-3ac41d88`
- Both sessions live concurrently ✓

### /sessions (via /menu → Sessions)
Both active sessions listed with slug, repo, idle time. Inline buttons per session. ✓

### /attach (via Sessions → slug → Attach)
- RC session name returned for desktop connection ✓
- last_attached_at updated in sessions.json ✓

### /close (via Sessions → slug → Close)
- Ctrl-C sent to tmux session (graceful RC server exit)
- tmux session gone after close ✓
- sessions.json entry marked `closed=true, close_reason=user` ✓
- Worktree removed via `git worktree remove --force` ✓
- `git worktree list` after close: only main checkout remains ✓

## Admissibility check
journalctl during Mode-2 walkthrough: zero `STARTING`/`sendMessageStreaming` calls. ✓
All Mode-2 actions handled at TypeScript layer with no LLM involvement.

## git worktree list after both closes
```
/home/assistant/repos/claude-telegram-bot  7be0117 [main]
```
Both worktrees cleanly removed. ✓
