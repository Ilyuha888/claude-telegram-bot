# ADR-008 Session State Schema

- Status: Superseded
- Date: 2026-03-10
- Superseded by: dec-20260323-001

## Context

The architecture document referenced multiple implicit shapes for `session_state`. That ambiguity was blocking prompt builders, persistence models, and compaction logic because different parts of the system could interpret `pending_tasks`, `open_loops`, and `decisions` differently.

The runtime already relies on workspace-scoped memory and compaction, so the session contract must be stable, typed, and explicit about what remains active versus what moves to history.

## Decision

1. `SessionState` is a versioned typed schema with mandatory `schema_version=1`.
2. The normative top-level shape is:
   - `schema_version`
   - `workspace_profile`
   - `rolling_summary`
   - `active_facts`
   - `pending_tasks`
   - `open_loops`
   - `decisions`
   - `open_artifacts`
   - `last_compacted_at`
3. `pending_tasks` is a list of structured objects with `id`, `title`, `status`, `owner`, `source_turn_id`, `blocking_on`, `related_artifacts`, and optional `due_at`. Allowed statuses are `pending`, `in_progress`, and `blocked`.
4. `open_loops` is a list of structured objects with `id`, `kind`, `summary`, `waiting_on`, `source_turn_id`, `opened_at`, `related_task_ids`, and optional `next_action`. Allowed kinds are `user_answer`, `approval`, `conflict`, and `external_event`.
5. `decisions` stores only active finalized decisions with `id`, `topic`, `summary`, `decided_by`, `source_turn_id`, `decided_at`, and optional `rationale`.
6. Terminal tasks, resolved loops, and superseded or historical decisions must leave `session_state` and remain only in summaries, audit history, or dedicated durable records.
7. Free-form string lists for `pending_tasks`, `open_loops`, and `decisions` are not valid.
8. Compaction must preserve the typed schema and must explicitly drop terminal tasks and superseded decisions.

## Consequences

- Prompt builders, persistence models, and session compaction can share one normative contract instead of ad hoc interpretations.
- The active session surface stays small because only unresolved work and still-applicable decisions remain in `session_state`.
- Historical detail is still available, but it moves to summaries and durable history rather than bloating prompt state.
- Future incompatible changes require a schema-version bump instead of silent drift.
