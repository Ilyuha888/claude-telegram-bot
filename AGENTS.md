# AGENTS.md

Instructions for local coding agents working with this repository and the knowledge vault. This file governs repository work, not the production runtime.

## Mission

This repository contains a personal assistant platform with:

- Telegram UX
- an Obsidian-backed knowledge vault
- a Git approval flow for knowledge changes

The agent should help with:

- understanding the repository structure
- implementing code within the architectural constraints
- indexing the vault
- proposing improvements without violating safety boundaries

The agent must not:

- add unsafe autonomy
- add shell execution to the runtime LLM path
- expand the writable surface without explicit approval

## Global Working Agreements

1. Read `README.md` and `ARCHITECTURE.md` first.
2. Do not change architecture invariants without an ADR or explicit user instruction.
3. Prefer simple deterministic services over framework-heavy abstractions.
4. Do not add new production dependencies without a short justification.
5. Keep the runtime repository and the knowledge repository conceptually separate.
6. Present risky changes as proposals before implementation.
7. For larger tasks, outline the planned file changes before editing.

## Architecture Invariants

These rules are mandatory:

- the runtime is a custom orchestrator, not a research-agent framework
- the runtime LLM does not get arbitrary shell access
- filesystem writes go only through policy-controlled tools or services
- the knowledge vault is a separate Git repository
- a Telegram topic is a workspace namespace, not just a chat thread
- the source of truth for long-term knowledge is the vault plus Git history, not a transcript database

## Repository Expectations

When writing code:

- target Python 3.12+
- use explicit typing
- prefer Pydantic schemas for typed boundaries
- keep handlers thin and domain services explicit
- place external integrations behind adapter interfaces
- keep tool contracts typed and auditable

## Safety Rules for Coding Agents

Do not do the following without direct user approval:

- add `subprocess` or shell execution to the runtime path
- run destructive migrations
- change Git push or merge policy
- expand writable allowlists
- store secrets in the repository
- disable review-before-commit safeguards

If you think one of these is necessary, explain the trade-off first and propose an ADR.

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
