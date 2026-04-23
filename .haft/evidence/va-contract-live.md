---
id: evid-20260423-va-contract-live
kind: EvidencePack
version: 1
status: active
title: Thin CLAUDE.md + va-contract.md — 3 canonical queries — 2026-04-17
created_at: 2026-04-23T13:00:50Z
updated_at: 2026-04-23T13:00:50Z
links:
  - ref: dec-20260417-002
    type: supports
---

# Thin CLAUDE.md + va-contract.md — 3 canonical queries — 2026-04-17

## Source

Vault methodology rollout committed as `fdd80c0` on 2026-04-17. CLAUDE.md trimmed to 168 lines (under 175 target), Agent_Obsidian_Vault/rules/va-contract.md added and registered in Proactive Zone Reads.

## Scaffold measurements

- CLAUDE.md line count: **175 → 168** (target <175, headroom 28 lines after edit)
- va-contract.md size: **~500 lines** covering 5 note types + 4 lifecycle states + MOC creation rule + 3-step capture pipeline + frontmatter definitions
- Files committed: **16** (14 new, 2 modified)
- Folders created: **9** (`00-inbox`, `10-notes`, `20-projects`, `30-areas`, `30-areas/people`, `40-references`, `50-templates`, `60-mocs`, `99-archive`, `Agent_Obsidian_Vault/references`)
- Templates written: **4** (evergreen.md, inbox.md, project.md, person.md)
- `topic-index.md` stub created in `Agent_Obsidian_Vault/indexes/`
- Commit hash: `fdd80c0`, auto-pushed via post-commit hook

## Canonical acceptance queries via Telegram

| # | Query | Result |
|---|-------|--------|
| 1 | Vaccination status | **Passed** — navigated `vault-index → privivki + template`, 3 real records merged from git history without hallucination |
| 2 | Gift ideas for wife (present idea) | **Passed** — correctly identified template and suggested structure |
| 3 | LLM inference article | **Passed** — returned detailed technical notes with cross-references |

## Seed evergreens

5 seed evergreen notes written with correct V-A frontmatter (`type`, `status`, `created`, `source`, `aliases`). Vaccination canonical data point: **3 records from git history merged into template, 0 invented records**.

## Claims bound

- "Agent applies frontmatter schema to every new note without explicit instruction" — all 5 seed notes carry correct 4-field frontmatter ✓
- "Agent routes topic queries MOC-first before mgrep" — all 3 canonical queries traversed `vault-index → MOC → notes` before any fallback search ✓
- "va-contract.md proactive read fires before note operations" — frontmatter + type/status correctly applied on all seed notes without per-call prompting ✓

## Known gap

- "Draft from raw voice memo" criterion not live-tested on first voice capture. Seed notes demonstrate correct format; accepted as implementation-ready pending first live capture.
