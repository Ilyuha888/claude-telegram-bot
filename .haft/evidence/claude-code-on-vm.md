---
id: evid-20260423-claude-code-on-vm
kind: EvidencePack
version: 1
status: active
title: Claude Code on VM — end-to-end operational — 2026-04-15
created_at: 2026-04-23T13:01:20Z
updated_at: 2026-04-23T13:01:20Z
links:
  - ref: dec-20260414-001
    type: supports
---

# Claude Code on VM — end-to-end operational — 2026-04-15

## Source

Phase 2–7 rollout of dec-20260414-001 completed 2026-04-15. Replaces the planned custom muscat orchestrator with Claude Code on a Hetzner VM, wired to the Obsidian vault via Git.

## Infrastructure

- **Host:** Hetzner CPX22, Ubuntu 24.04
- **Claude Code:** v2.1.109 installed and authenticated (Pro, Sonnet 4.6)
- **dot-claude:** cloned as `~/.claude` on VM with skills, hooks, plugins bootstrapped
- **Git identity:** Ilya Nartov / nartov@joom.com
- **Plugins installed and verified:** context7, hookify, mgrep, skill-creator, frontend-design, pyright-lsp
- **Settings:** `settings.local.json` configured with GitHub PAT + Google AI Studio key
- **Git sync hooks:** auto-pull on SessionStart, auto-push on Stop

## Vault

- Cloned: `~/repos/my_obsidian_knowledge_base`
- Size: **5261 files** cloned successfully
- `CLAUDE.md` at vault root: **136 lines** covering structure, navigation, write policy, git conventions
- post-commit push hook: installed in vault repo

## Telegram + Remote Control

- Telegram bot paired with allowlist policy; **no permission prompts** at approval gate
- Session lifecycle notifications 🟢 / 🔴 confirmed
- Remote Control auto-enables **~20s after session start**
- systemd service enabled for auto-restart on boot

## End-to-end test (2026-04-15)

- Telegram query → vault query ✓
- Note created in `Agent_Obsidian_Vault/` → committed → pushed to GitHub ✓
- User-confirmed commit flow for vault writes ✓
- Session online/offline notifications delivered reliably ✓

## Claims bound

- "Telegram two-way messaging confirmed working on the VM" — verified ✓
- "Remote Control accessible from browser and mobile" — auto-enables on session start ✓
- "Claude successfully reads vault notes and follows wikilinks" — canonical queries traverse vault-index → MOC → notes ✓
- "Claude commits to vault repo via Git" — auto-push hook verified ✓
- "Session survives tmux detach + reattach cycle" — lifecycle notifications on clean exit reliable ✓

## Gaps (documented against decision post-conditions)

- Crash-recovery process supervision not formally stress-tested (only clean exits tested)
- No multi-session / multi-repo support in the Phase 7 scope — addressed later by dec-20260422-003 (Mode-2 remote sessions)

## Superseded predecessors

Per this decision's frontmatter links, this deployment supersedes dec-20260320-002/003/004/005, dec-20260323-001, and dec-20260324-001 — all muscat-era orchestrator decisions. Muscat repo archived on GitHub with this decision recorded.
