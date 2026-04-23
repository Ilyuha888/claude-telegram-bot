---
id: evid-20260423-phase-b-non-root
kind: EvidencePack
version: 1
status: active
title: Phase B non-root migration — 2026-04-17 deploy + 2026-04-23 re-verification
created_at: 2026-04-23T13:01:00Z
updated_at: 2026-04-23T13:01:00Z
links:
  - ref: dec-20260416-001
    type: supports
---

# Phase B non-root migration — 2026-04-17 deploy + 2026-04-23 re-verification

## Source

Layered rollout Phase B completed 2026-04-17 (dec-20260416-001). Non-root user `assistant` (uid=1000) provisioned on Hetzner VM; both services migrated off root.

## Measurements (2026-04-17 deploy)

- `assistant` uid: **1000** (verified via `ps aux` for both services)
- `claude-telegram-bot` process user: **assistant**
- `claude-assistant` (Claude Code runtime) process user: **assistant**
- `settings.local.json` permissions: **-rw------- assistant** (chmod 600, OS-level protection)
- UFW: **active**, all inbound denied except SSH (port 22)
- Old root claude process: **killed** post-migration
- Telegram round-trip latency (first test): **~1 min** (cold start)
- Root processes in claude/bun stack: **0**

## Re-verification (2026-04-23)

- Service still running under `user=assistant`
- Config symlink architecture in place for shared `.claude/` dir
- No root processes in claude/bun stack — re-confirmed via `ps aux`
- `systemctl is-active claude-telegram-bot.service`: **active**

## Claims bound

- "`.claudeignore` blocks credential reads" — `.claudeignore` present and excludes `~/.ssh`, `.env`, credential files; further strengthened by OS-level non-root separation ✓
- "Non-root user does not break Telegram flow" — Telegram round-trip confirmed end-to-end post-Phase B ✓
- "UFW blocks unauthorized inbound" — only port 22 open (nmap verification from external host) ✓

## Phase A layers (deployed earlier, re-verified)

- `.claudeignore` excludes sensitive paths
- `--disallowedTools` configured
- UFW denies inbound except SSH
- Remote Control session active (KB-Assistant)

## Admissibility invariants held

- SSH root access preserved (emergency recovery path)
- No outbound block on api.anthropic.com / api.telegram.org / github.com
- Phase A was stable before Phase B (phases sequenced per decision)
