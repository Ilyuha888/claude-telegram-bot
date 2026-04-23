---
id: evid-20260423-reaper
kind: EvidencePack
version: 1
status: active
title: Mode-2 Idle Reaper — 2026-04-23
created_at: 2026-04-23T10:22:00Z
updated_at: 2026-04-23T10:22:00Z
links:
  - ref: dec-20260422-003
    type: supports
---

# Mode-2 Idle Reaper — 2026-04-23

## Test procedure
1. Seeded sessions.json with entry `reaper-test-1776939729` (repo: `my_obsidian_knowledge_base`)
   - `last_attached_at` set to 10 minutes in the past
   - Live tmux session running
2. Set env overrides: `REAPER_INTERVAL_MS=30000`, `REAPER_IDLE_THRESHOLD_MS=120000`
3. Restarted bot, waited ~35s for first reaper cycle

## journalctl output
```
Apr 23 10:22:46 ubuntu-4gb-nbg1-1-claude claude-telegram-bot[341889]: {"event":"mode2.reaper.close","slug":"reaper-test-1776939729","idle_ms":634956}
```

## sessions.json after
```json
{"slug": "reaper-test-1776939729", "closed": true, "close_reason": "idle_reaper"}
```

## tmux after
No `work-reaper-test-*` sessions present. ✓

## Note on worktree behavior
Test session had no worktree (`worktree_path: null`). The reaper code path calls
`sh.gitWorktreeRemove(repoPath, worktree_path)` when `worktree_path` is non-null —
same path as user close. Deletion behavior is consistent across close triggers.

## Result
- Idle session closed by reaper at correct threshold ✓
- `close_reason: idle_reaper` in sessions.json ✓
- tmux session killed ✓
- Reaper overrides removed; bot restored to defaults (7-day threshold, 1h interval) ✓
