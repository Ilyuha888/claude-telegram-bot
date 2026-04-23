---
id: evid-20260423-single-user-invariant
kind: EvidencePack
version: 1
status: active
title: Single-user invariant — AGENTS.md + quint/haft record — 2026-04-15
created_at: 2026-04-23T13:01:30Z
updated_at: 2026-04-23T13:01:30Z
links:
  - ref: dec-20260320-001
    type: supports
---

# Single-user invariant — AGENTS.md + quint/haft record — 2026-04-15

## Source

Meta-decision that recorded the platform's single-user scope as an explicit architecture invariant (dec-20260320-001). Accepted 2026-04-15 after verification that the invariant lives in both the primary instruction file and the governance decision record.

## Artefacts

- **AGENTS.md** at repo root (promoted from governance during 2026-04-22 subtree merge; previously symlinked as CLAUDE.md in the muscat era). "Architecture Invariants" section carries the single-user bullet.
- **Haft/quint DecisionRecord** dec-20260320-001 — searchable via `haft_query action=search query="single-user"`.
- **`prob-20260320-006`** marked Addressed by this decision.

## Invariants in force

- Platform scoped to a **single user**
- Multi-user support is **out of scope until** a haft decision explicitly supersedes this record
- Claude Code session is inherently single-user by design — enforced by the runtime choice, not just documentation

## Claims bound

- "Single-user scope is documented as an explicit constraint, not an implicit assumption" — both AGENTS.md and dec-20260320-001 record the constraint ✓
- "Invariant is searchable via governance tooling" — `haft_query action=search query="single-user"` returns this decision ✓
- "Lifting the constraint requires a deliberate decision, not incremental drift" — refresh triggers on the decision (second Telegram user, session-isolation work, multi-tenant code paths) enforce explicit review ✓

## Two-source sync check

The weakest link identified at decision time was divergence between AGENTS.md and the quint record. Since 2026-04-15 acceptance:
- AGENTS.md has been promoted to root during subtree merge (2026-04-22, dec-20260422-004). Single-user invariant content preserved.
- No multi-tenant code paths introduced; no second user onboarded; no session-isolation work started.
- Refresh triggers have not fired.

Sync is currently coherent. No changes to the invariant needed.

## Note on runtime enforcement

This is a meta/governance decision — there is no runtime test harness. "Evidence" here is process-level: the artefacts exist, the tooling queries them, and the refresh triggers are wired. Measurable outcomes apply at the point a multi-user scenario emerges, not before.
