---
id: evid-20260423-resume-on-boot
kind: EvidencePack
version: 1
status: active
title: Mode-2 Resume-on-Boot — 2026-04-23
created_at: 2026-04-23T10:13:00Z
updated_at: 2026-04-23T10:13:00Z
links:
  - ref: dec-20260422-003
    type: supports
---

# Mode-2 Resume-on-Boot — 2026-04-23

## Test procedure
1. Seeded sessions.json with a live non-closed entry (`resume-test-1776939178`, repo: `my_obsidian_knowledge_base`)
2. Killed the tmux session manually to simulate RC server crash
3. Restarted bot service: `sudo systemctl restart claude-telegram-bot`
4. Observed journalctl

## journalctl output
```
Apr 23 10:13:04 ubuntu-4gb-nbg1-1-claude claude-telegram-bot[341566]: {"event":"mode2.resume.boot","slug":"resume-test-1776939178"}
```

## tmux after restart
```
work-resume-test-1776939178: 1 windows (created Thu Apr 23 10:13:04 2026)
```

## Result
- `resumeOnBoot()` detected the non-closed session with dead tmux ✓
- RC server respawned in new tmux session at same cwd within same second as bot start ✓
- 100% of non-closed sessions with dead tmux respawned (1/1) ✓
