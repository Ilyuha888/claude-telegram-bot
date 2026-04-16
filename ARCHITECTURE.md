# Architecture

> **This document describes the live system as of 2026-04-16.** The previous version described the "muscat" custom Python orchestrator that was abandoned. Legacy design artifacts are preserved in `docs/adr/` and `docs/*.md` but are not authoritative.

## Purpose

Self-hosted personal assistant: Telegram as the primary interface, an Obsidian-backed knowledge vault as the long-term knowledge store, Git as the approval and audit layer for vault changes.

## System Overview

```
┌─────────────────────────────────────────────────────────┐
│                  Hetzner CPX22 VM                        │
│          Ubuntu 24.04 · root@46.225.212.69               │
│                                                          │
│  ┌────────────────────────────────────┐                  │
│  │  claude-telegram-bot.service       │                  │
│  │  linuz90/claude-telegram-bot       │                  │
│  │  (TypeScript/Bun, Agent SDK)       │                  │
│  │  • message queuing                 │◄── Telegram      │
│  │  • MarkdownV2 formatting           │    Bot API       │
│  │  • voice via Whisper               │                  │
│  │  • /new /resume multi-session      │                  │
│  └───────────────┬────────────────────┘                  │
│                  │ spawns Claude Code subprocess          │
│  ┌───────────────▼────────────────────┐                  │
│  │  claude-assistant.service          │                  │
│  │  Claude Code v2.1.110 (tmux)       │                  │
│  │  MCP: haft · context7 · hookify ·  │                  │
│  │       mgrep · skill-creator ·      │                  │
│  │       frontend-design              │                  │
│  └────────────┬────────────┬──────────┘                  │
│               │            │                             │
│    ┌──────────▼───┐  ┌─────▼──────────┐                 │
│    │ Obsidian      │  │ Remote Control  │                 │
│    │ Vault (Git)   │  │ (KB-Assistant)  │                 │
│    │ post-commit   │  └────────────────┘                 │
│    │ → git push    │                                     │
│    └──────────────┘                                     │
└─────────────────────────────────────────────────────────┘
         ▲                        ▲                ▲
  Telegram Bot API          Remote Control        SSH
  @ianartov_personal_       claude.ai/code        admin /
  assistant_bot             (KB-Assistant)        emergency
  (linuz90 bot)             secondary access
```

## Access Channels

| Channel | Purpose | Notes |
|---|---|---|
| Telegram bot | Primary daily use | linuz90/claude-telegram-bot (Agent SDK, TypeScript/Bun) |
| Remote Control | Session monitoring, fallback | claude.ai/code, session name: KB-Assistant |
| SSH | Admin, emergency | `ssh root@46.225.212.69` |

## Session Lifecycle

1. **Boot → systemd** — `claude-assistant.service` and `claude-telegram-bot.service` start automatically (independent services)
2. **start-assistant.sh** — pulls latest vault commits, launches Claude Code in tmux session `assistant`
3. **claude-telegram-bot** — starts independently, spawns Claude Code subprocesses per Telegram session
4. **Claude Code starts** — loads `~/.claude/settings.local.json`, all MCP servers, skills, and hooks
5. **Session persists** — tmux keeps the admin session alive across SSH disconnects

## Permission Model

Claude Code runs with `--permission-mode default` and an allowlist policy configured in `/root/.claude/settings.local.json`. This means:
- File reads and vault operations proceed without prompts
- Shell commands and destructive operations require approval
- Telegram permission prompts do not appear — handled by the allowlist

The commit-confirm flow is enforced at the vault level: Claude writes → asks user to confirm → commits only after yes.

## Knowledge Vault

The vault is a **separate Git repository** at `~/repos/my_obsidian_knowledge_base` on the VM. It is not part of this repository.

- Two-root structure: `User_Obsidian_Vault/` (user-owned) and `Agent_Obsidian_Vault/` (agent-writable)
- Claude Code reads and writes via its native filesystem tools (Read, Write, Edit, Bash for git)
- A `post-commit` hook automatically pushes vault commits to the remote
- `start-assistant.sh` pulls latest vault state on every session start
- The vault has its own `CLAUDE.md` at `~/repos/my_obsidian_knowledge_base/CLAUDE.md`

**Invariant:** The vault is the source of truth for long-term knowledge. Claude Code does not maintain a separate transcript database.

## Extension Points

| Mechanism | Purpose | Location |
|---|---|---|
| MCP servers | External tool integrations | `~/.claude/settings.local.json` |
| Skills | Reusable prompt workflows | `~/.claude/skills/` |
| Hooks | Lifecycle events (pre/post tool) | `~/.claude/settings.local.json` (hooks array) |
| `.claudeignore` | Exclude paths from context | Not yet configured — see `prob-20260416-005` |

**Active MCP servers:** haft (decision tracking), context7 (library docs), hookify (hook rules), mgrep (semantic search), skill-creator, frontend-design, pyright-lsp

**Telegram bridge:** linuz90/claude-telegram-bot at `/root/claude-telegram-bot` — managed by `claude-telegram-bot.service`. Voice via OpenAI Whisper. See `dec-20260416-003`.

## Active Decisions

| Decision | Summary | Valid Until |
|---|---|---|
| `dec-20260414-001` | Claude Code on VM as the personal assistant runtime | 2027-04-14 |
| `dec-20260416-003` | linuz90/claude-telegram-bot as Telegram bridge | 2026-10-16 |
| `dec-20260320-001` | Single-user scope — explicit platform constraint | 2027-03-20 |

See `.haft/` for the full decision history including superseded and deprecated artifacts.

## Known Limitations and Open Problems

| Problem | ID | Depth |
|---|---|---|
| Vault CLAUDE.md needs revision after real-world use | `prob-20260416-002` | tactical |
| VM security hardening: root user, no network controls | `prob-20260416-005` | tactical |
| No knowledge lifecycle model | `prob-20260406-001` | standard |

Problems superseded by `dec-20260416-003`: prob-20260416-001 (multi-session), prob-20260416-003 (formatting/UX), prob-20260416-004 (bridge architecture).

## Architecture Invariants

These rules hold regardless of implementation:

- The runtime is Claude Code on a VM, not a custom-built orchestrator
- The runtime LLM does not get arbitrary shell access — all shell commands go through the allowlist
- Filesystem writes go only through policy-controlled tools or confirmed user approval
- The knowledge vault is a separate Git repository — Claude Code does not own it
- The platform is scoped to a single user; multi-user support is explicitly out of scope until a haft decision supersedes `dec-20260320-001`
- The source of truth for long-term knowledge is the vault plus Git history, not conversation transcripts

## Infrastructure

- **Provider:** Hetzner Cloud, Nuremberg
- **Spec:** CPX22 — 2 vCPU / 4 GB RAM / 80 GB SSD
- **OS:** Ubuntu 24.04
- **Cost:** ~$10.09/mo
- **Runtime:** Claude Code v2.1.110, Node.js 22, Bun 1.3.12
- **Process:** systemd `claude-assistant` service (tmux session `assistant`) + `claude-telegram-bot` service
- **Auth:** Claude Pro/Max subscription via `claude login` (CLI auth)

## Legacy

`docs/adr/` contains ADR-001 through ADR-009 from the muscat era. `docs/*.md` (ARCHITECTURE, DATA_MODEL, TOOL_CONTRACTS, API_SURFACES, DEVELOPMENT) describe the abandoned custom Python orchestrator. These are preserved as historical audit trail but describe a system that was never built. Do not use them as current reference.
