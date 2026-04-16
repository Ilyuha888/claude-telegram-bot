# AGENTS.md

Instructions for local coding agents working with this repository and the knowledge vault. This file governs repository work, not the production runtime.

## Mission

This repository contains engineering governance artifacts for a personal assistant platform powered by Claude Code on a Hetzner VM, with:

- Telegram as the primary UX channel (official channel plugin)
- an Obsidian-backed knowledge vault (separate Git repo)
- a Git approval flow for knowledge changes
- haft decision tracking in `.haft/`

The agent should help with:

- understanding the repository structure and live system architecture
- working within the architectural invariants and active haft decisions
- indexing and improving the vault
- proposing improvements without violating safety boundaries

The agent must not:

- add unsafe autonomy
- add shell execution to the runtime LLM path
- expand the writable surface without explicit approval

## Global Working Agreements

1. Read `README.md` and `ARCHITECTURE.md` first.
2. Do not change architecture invariants without first recording a `haft_decision` artifact (or receiving explicit user instruction).
3. Prefer simple deterministic services over framework-heavy abstractions.
4. Do not add new production dependencies without a short justification.
5. Keep the runtime repository and the knowledge repository conceptually separate.
6. Present risky changes as proposals before implementation.
7. For larger tasks, outline the planned file changes before editing.

## Decision Records with Haft

This project uses [haft](https://github.com/m0n0x41d/haft) to track engineering decisions as structured artifacts in `.haft/`. Use it whenever a choice has lasting architectural consequences or is not obvious from the code.

### When to use it

- You are about to violate or modify an architecture invariant
- You are choosing between two non-trivial implementation approaches
- You need to record why an alternative was rejected
- A future agent would otherwise have to re-derive the reasoning

Do **not** create a haft artifact for routine implementation details or obvious choices.

**Default entry point: `/h-reason`** — auto-depth, picks the right mode for the problem. See the `/h-reason` skill for full workflow guidance.

### Lifecycle management rule

**Never manually edit `.haft/` files to close or transition artifacts.** Use MCP tools:

- Problem resolved by a decision → `haft_refresh(action="supersede", artifact_ref="prob-...", new_artifact_ref="dec-...")`
- Decision no longer relevant → `haft_refresh(action="deprecate", artifact_ref="dec-...")`
- Validity window needs extending → `haft_refresh(action="waive", artifact_ref="...", new_valid_until="...")`

### Relationship to `docs/adr/`

`docs/adr/` holds legacy ADRs written before haft was introduced. New decisions go into `.haft/` via the MCP tools. Do not create new files under `docs/adr/` manually.

### Before starting significant work

Run `/h-status` to surface active decisions and stale artifacts. Do not re-litigate closed decisions without first checking whether they still apply.

## Architecture Invariants

These rules are mandatory:

- the runtime is Claude Code on a Hetzner VM, not a custom-built orchestrator
- the runtime LLM does not get arbitrary shell access — shell commands go through the allowlist
- filesystem writes go only through policy-controlled tools or user-confirmed approval
- the knowledge vault is a separate Git repository; Claude Code does not own it
- the source of truth for long-term knowledge is the vault plus Git history, not conversation transcripts
- the platform is scoped to a single user; multi-user support is explicitly out of scope until a haft decision supersedes `dec-20260320-001`

## Repository Expectations

This repository holds governance artifacts, not runtime code. When working here:

- prefer editing existing docs over creating new files
- new engineering decisions go into `.haft/` via MCP tools, not `docs/adr/`
- if proposing VM or vault changes, describe the change and its blast radius before acting
- do not create Python source files — there is no custom runtime code in this repository

## Safety Rules for Coding Agents

Do not do the following without direct user approval:

- add `subprocess` or shell execution to the runtime path
- run destructive migrations
- change Git push or merge policy
- expand writable allowlists
- store secrets in the repository
- disable review-before-commit safeguards

If you think one of these is necessary, explain the trade-off first and record a haft decision artifact via `/h-reason`.

## How to Scan the Obsidian Vault

When the task is to describe vault structure:

1. identify top-level roots such as `User_Obsidian_Vault/` and `Agent_Obsidian_Vault/`
2. build a directory map for each root
3. collect note-type statistics
4. find index notes, hub notes, MOC pages, and note-folder pairs
5. detect common link patterns
6. detect colocated attachment conventions, especially sibling `files/` directories
7. identify folders for inbox items, projects, people, tasks, and archives
8. infer naming conventions
9. separate user-owned notes from assistant-owned artifacts

### Required Output Format

Use these sections:

- `Vault purpose`
- `Top-level structure`
- `Note taxonomies`
- `Linking conventions`
- `Asset conventions`
- `Probable workflows`
- `Open questions / ambiguities`
- `Recommended machine-readable zones`

## Prompt Template for Local Vault Indexing

Use this prompt when you need a local coding agent to analyze the vault:

```md
You are analyzing an Obsidian vault for a personal assistant system.
Your job is to infer the vault organization logic, not to rewrite the vault.

Goals:
1. Identify top-level vault roots and their likely purpose.
2. Detect note categories (ideas, projects, people, tasks, references, journal, archives, etc.).
3. Detect naming conventions and recurring templates.
4. Detect whether there are MOCs, hub notes, dashboards, indexes, daily/weekly notes, or note-folder pairs.
5. Detect how attachments and images are stored and linked, especially whether they are colocated in sibling `files/` directories.
6. Infer which areas belong to `User_Obsidian_Vault` versus `Agent_Obsidian_Vault`, and which should remain user-only.
7. Produce a concise report in markdown.
8. Propose a machine-friendly indexing strategy for this vault.

Constraints:
- Do not modify any files.
- Do not assume semantics when evidence is weak; mark uncertainty explicitly.
- Prefer filesystem patterns, filenames, frontmatter, outbound links, repeated structures, and Obsidian config when present.
- Distinguish facts from hypotheses.

Deliverable sections:
- Vault purpose
- Top-level structure
- Note taxonomies
- Link conventions
- Asset conventions
- Candidate assistant zones
- Candidate protected zones
- Indexing recommendations
- Uncertainties
```

## Recommended Machine Zones in the Knowledge Repository

If these zones do not exist yet, an agent may propose them under `Agent_Obsidian_Vault/`:

- `Agent_Obsidian_Vault/profile/`
- `Agent_Obsidian_Vault/rules/`
- `Agent_Obsidian_Vault/tasks/`
- `Agent_Obsidian_Vault/indexes/`
- `Agent_Obsidian_Vault/drafts/`
- `Agent_Obsidian_Vault/reviews/`

Do not create them inside `User_Obsidian_Vault/` without explicit permission if the repository already has an established structure.

## When to Update This File

Update `AGENTS.md` when:

- the user repeatedly corrects the same architectural mistake
- a new invariant becomes stable
- tool, review, or safety policy changes
- the knowledge-vault structure becomes clearer

Keep this file short. Store only durable rules here.
