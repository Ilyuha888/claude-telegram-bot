# ADR-007 Scheduled Write Policy

- Status: Accepted
- Date: 2026-03-10

## Context

The platform includes recurring and follow-up jobs in V1, but the repository also treats the knowledge vault and Git history as the source of truth for long-term knowledge changes. File mutations already require policy-controlled tools, path validation, audit logging, and an approval flow.

The unresolved question was how far scheduled automation should be allowed to go once jobs can run without an interactive Telegram turn:

- fully blocking scheduled writes makes recurring reviews and machine-managed artifacts clumsy
- allowing silent mutation of user-owned notes breaks the review-first control boundary
- agent-created follow-up jobs need tighter defaults than user-created jobs because they are proposed by the assistant rather than explicitly authored by the user

## Decision

1. Scheduled jobs may directly persist only to pre-approved prefixes under `Agent_Obsidian_Vault/`.
2. Scheduled runs must not directly mutate `User_Obsidian_Vault/`. If a run wants to promote content into user-owned notes, it must emit a review package under `Agent_Obsidian_Vault/reviews/<job_id>/<run_ts>.md` and wait for explicit approval.
3. Normal stored job outputs live under `Agent_Obsidian_Vault/tasks/<job_slug>/runs/YYYY/MM/DD/<run_ts>--<job_id>.md`.
4. For `user-created` jobs, explicit approval happens at job creation or update time and covers schedule, write scope, and artifact type for direct agent-vault writes. Per-run approval is not required when a run stays inside that approved scope.
5. `agent-created` follow-up jobs default to `pending_approval`. They become active only after explicit user approval and remain restricted to agent-owned paths.
6. Approved `agent-created` follow-up jobs use stricter defaults: `min_interval=6h`, `max_runs=30`, `expires_at<=30d`, `allow_child_jobs=false`, and self-rescheduling only for the same job without widening scope, cadence, or lifetime.
7. Every automatic job write must record `job_id`, `job_run_id`, `approval_mode`, written paths, and the final `policy_decision` in audit data.

## Consequences

- Recurring automation can store durable machine-managed artifacts without forcing a manual approval step on every run.
- User-owned notes remain behind explicit review and approval, even when a scheduled run generated the proposed content.
- User-created and agent-created jobs do not share the same default approval policy.
- Scheduled writes rely on the accepted staging and replay model documented in `ADR-006` and `ARCHITECTURE.md`; this ADR only narrows which write scopes may bypass per-run approval.
