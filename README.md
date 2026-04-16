# yet-another-personal-assistant

Self-hosted personal assistant running Claude Code on a Hetzner VM, with Telegram as the primary interface and an Obsidian vault as the long-term knowledge store.

> **Note:** This repository was originally the "muscat" custom Python orchestrator. That design was abandoned on 2026-04-14 in favor of Claude Code on VM (`dec-20260414-001`). The live system description is in `ARCHITECTURE.md`. Legacy design artifacts are in `docs/` and `.haft/` (marked superseded).

## Current State

**Operational since 2026-04-14.** The assistant runs as a persistent Claude Code session on a Hetzner VM, accessible via:

- **Primary:** Telegram bot `@ianartov_personal_assistant_bot` (official channel plugin)
- **Secondary:** Remote Control via `claude.ai/code` (session name: KB-Assistant)
- **Admin:** SSH `root@46.225.212.69`

**What it can do today:**
- Answer questions, do research, reason about problems via Telegram
- Read, search, create, and edit notes in the Obsidian knowledge vault
- Commit vault changes with a confirm flow (write → ask → commit → push)
- Run scheduled vault maintenance via Claude Code's built-in tools
- Access MCP tools: haft, context7, mgrep, hookify, and others

## Architecture

See `ARCHITECTURE.md` for the full system description. In brief:

```
Telegram ──► Claude Code (VM) ──► Obsidian vault (Git repo)
Browser  ──► (Remote Control)
SSH      ──► (admin/emergency)
```

Claude Code runs in tmux under systemd on a Hetzner CPX22 VM. The Obsidian vault is a separate Git repo; changes go through a commit-confirm flow and auto-push.

## Decision Tracking

Engineering decisions with lasting consequences are tracked as structured artifacts in `.haft/` using [haft](https://github.com/m0n0x41d/haft).

- **Active decisions:** `dec-20260414-001` (runtime choice), `dec-20260320-001` (single-user scope)
- **Active problems:** see `ARCHITECTURE.md` — Known Limitations section
- **Workflow rules:** see `AGENTS.md` — Decision Records with Haft

Never manually edit `.haft/` files — use MCP tools (`haft_refresh`, `haft_problem`, `haft_decision`).

## Repository Contents

This repository holds engineering governance artifacts, not runtime code:

```
.haft/           — Engineering decisions (haft artifacts, SQLite DB)
docs/adr/        — Legacy ADRs from the muscat era (historical, not authoritative)
docs/            — Legacy muscat design docs (historical, not authoritative)
ARCHITECTURE.md  — Live system architecture
AGENTS.md        — Instructions for coding agents and invariant rules
README.md        — This file
```

The runtime lives on the VM. The vault lives in a separate Git repo (`my_obsidian_knowledge_base`).

## Known Limitations

See the active problem cards in `.haft/`:

- `prob-20260416-001` — No multi-session/multi-repo support from Telegram
- `prob-20260416-002` — Vault CLAUDE.md needs revision after real-world use
- `prob-20260416-003` — Bot message formatting and Telegram UX quality of life
- `prob-20260416-004` — Telegram bridge architecture: official plugin vs community bot
- `prob-20260416-005` — VM security hardening (root user, no network controls)
- `prob-20260406-001` — No knowledge lifecycle model

## Working with This Repo

Before starting significant work, run `/h-status` to surface active decisions and open problems. Read `AGENTS.md` for invariant rules and coding agent instructions.
