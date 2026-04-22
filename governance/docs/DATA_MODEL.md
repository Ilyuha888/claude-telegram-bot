# Data Model

This document is the canonical MVP runtime persistence contract for Postgres-backed durable state. It defines entities, state transitions, uniqueness rules, and retention mappings so the first migration set can be designed without reopening core workflow decisions.

Global rules:

- all tables use `created_at` and `updated_at`
- all timestamps are stored in UTC
- row identifiers use UUID or ULID-like opaque strings; external callers must not derive meaning from them
- retention sweeps may purge raw payload columns, but must not break surviving metadata references
- durable workflow correctness must remain reconstructible from Postgres-backed state

## Retention Classes

Retention classes are shared with the audit model in `ARCHITECTURE.md`.

| Retention class | Keep raw payload until | Keep metadata until |
| --- | --- | --- |
| `success_raw` | 7d | 365d |
| `failed_job_raw` | 14d | 365d |
| `denied_write_raw` | 30d | 365d |
| `audit_metadata` | n/a | 365d |

## Entity Contracts

### `sessions`

Purpose:
- durable session boundary for one workspace-scoped conversation span

Primary key:
- `session_id`

Business keys / unique constraints:
- unique `workspace_id, session_epoch`

Relationships:
- one `session` has many `turns`
- one `session` has many `tool_calls`

Required columns:
- `session_id`
- `workspace_id`
- `user_id`
- `channel`
- `session_epoch`
- `schema_version`
- `session_state_json`
- `last_compacted_at`
- `closed_at` nullable

Indexes:
- `workspace_id, closed_at`
- `updated_at`

Retention class:
- `audit_metadata`

### `turns`

Purpose:
- one request/response exchange or job-driven synthetic turn

Primary key:
- `turn_id`

Business keys / unique constraints:
- unique `session_id, turn_sequence`

Relationships:
- belongs to `sessions`
- one `turn` has many `tool_calls`

Required columns:
- `turn_id`
- `session_id`
- `turn_sequence`
- `origin_kind` = `telegram_inbound | job_run | system`
- `inbound_message_ref` nullable
- `assistant_response_ref` nullable
- `raw_prompt_retention_class` nullable
- `raw_prompt_payload` nullable
- `raw_response_payload` nullable
- `completed_at` nullable

Indexes:
- `session_id, turn_sequence`
- `origin_kind, created_at`

Retention class:
- raw columns follow `success_raw`, `failed_job_raw`, or `denied_write_raw`
- metadata stays `audit_metadata`

### `tool_calls`

Purpose:
- auditable record of one tool invocation within a turn

Primary key:
- `tool_call_id`

Business keys / unique constraints:
- unique `turn_id, tool_sequence`

Relationships:
- belongs to `turns`
- may reference `review_requests`, `jobs`, or `vault_mutations`

Required columns:
- `tool_call_id`
- `turn_id`
- `tool_sequence`
- `tool_name`
- `side_effect_class`
- `request_json`
- `response_json` nullable
- `status` = `accepted | completed | failed | denied`
- `error_code` nullable

Indexes:
- `turn_id, tool_sequence`
- `tool_name, created_at`
- `status, created_at`

Retention class:
- metadata `audit_metadata`
- raw request and response payloads follow the parent turn retention class

### `jobs`

Purpose:
- durable definition of a reminder or recurring automation

Primary key:
- `job_id`

Business keys / unique constraints:
- unique `workspace_id, artifact_root, prompt_template, schedule_fingerprint` for active or pending jobs

Relationships:
- one `job` has many `job_runs`

Required columns:
- `job_id`
- `workspace_id`
- `kind` = `reminder | recurring_review | reindex | external_poll`
- `schedule_kind` = `datetime | interval | cron`
- `schedule_json`
- `schedule_fingerprint`
- `prompt_template`
- `created_by` = `user | agent`
- `activation_state` = `pending_approval | active | paused | expired`
- `allowed_write_prefixes_json`
- `artifact_root`
- `approval_mode` = `on_create | per_change_set`
- `max_runs` nullable
- `expires_at` nullable
- `allow_self_reschedule_within_bounds`
- `last_run_at` nullable
- `next_run_at` nullable

Indexes:
- `activation_state, next_run_at`
- `workspace_id, activation_state`
- `expires_at`

Retention class:
- `audit_metadata`

### `job_runs`

Purpose:
- one scheduled or manually triggered execution attempt for a job

Primary key:
- `job_run_id`

Business keys / unique constraints:
- unique `job_id, scheduled_at`
- unique `idempotency_key`

Relationships:
- belongs to `jobs`
- may create one `turn`
- may create zero or one `review_requests`

Required columns:
- `job_run_id`
- `job_id`
- `scheduled_at`
- `started_at` nullable
- `finished_at` nullable
- `idempotency_key`
- `status` = `queued | claimed | running | succeeded | failed_retryable | failed_terminal | cancelled`
- `attempt_count`
- `worker_lease_expires_at` nullable
- `result_json` nullable
- `error_code` nullable
- `review_request_id` nullable

Indexes:
- `status, scheduled_at`
- `job_id, scheduled_at`
- `worker_lease_expires_at`

Retention class:
- raw payloads `success_raw` or `failed_job_raw`
- metadata `audit_metadata`

### `vault_mutations`

Purpose:
- normalized record of review-gated or policy-controlled vault write intents

Primary key:
- `vault_mutation_id`

Business keys / unique constraints:
- unique `review_request_id, mutation_sequence`

Relationships:
- belongs to `review_requests`
- may originate from `tool_calls` or `job_runs`

Required columns:
- `vault_mutation_id`
- `review_request_id`
- `mutation_sequence`
- `operation` = `create_note | update_note | move_note | delete_note | create_directory | move_directory | delete_directory | attach_image`
- `requested_path` nullable
- `canonical_path` nullable
- `effective_path` nullable
- `source_path` nullable
- `destination_path` nullable
- `content_sha256` nullable
- `policy_decision` = `allow | deny | remap | review_required`
- `fallback_reason` nullable

Indexes:
- `review_request_id, mutation_sequence`
- `effective_path`
- `policy_decision, created_at`

Retention class:
- `audit_metadata`

### `review_requests`

Purpose:
- review and replay boundary for a proposed vault change set

Primary key:
- `review_request_id`

Business keys / unique constraints:
- unique `staging_branch`
- unique `branch_name` when not null

Relationships:
- has many `vault_mutations`
- has many `approval_decisions`
- may belong to one `job_run`

Required columns:
- `review_request_id`
- `workspace_id`
- `base_branch`
- `base_commit`
- `staging_branch`
- `staging_worktree_path`
- `change_manifest_json`
- `branch_name`
- `commit_sha` nullable
- `pr_ref` nullable
- `status` = `drafting | awaiting_approval | approved_pending_replay | commit_created | branch_pushed | pr_created | failed_recoverable | conflicted | superseded | abandoned`
- `last_error` nullable
- `superseded_by` nullable
- `latest_approval_decision_id` nullable
- `review_summary_path` nullable
- `approved_at` nullable
- `terminal_at` nullable

Indexes:
- `status, created_at`
- `workspace_id, status`
- `superseded_by`
- `latest_approval_decision_id`
- `terminal_at`

Retention class:
- metadata `audit_metadata`
- raw review summaries follow `success_raw` or `denied_write_raw` based on outcome

### `approval_decisions`

Purpose:
- immutable record of an explicit user approval or rejection for a review request

Primary key:
- `approval_decision_id`

Business keys / unique constraints:
- unique `command_idempotency_key`

Relationships:
- belongs to `review_requests`
- may reference one `turn`

Required columns:
- `approval_decision_id`
- `review_request_id`
- `decision` = `approve | reject`
- `decided_by_user_id`
- `command_idempotency_key`
- `source_turn_id` nullable
- `source_message_ref` nullable
- `source_callback_ref` nullable
- `reason` nullable
- `decision_status` = `accepted | ignored_duplicate | ignored_stale`

Indexes:
- `review_request_id, created_at`
- `decided_by_user_id, created_at`
- `command_idempotency_key`
- `decision, created_at`

Retention class:
- `audit_metadata`

Rules:

- approval decision rows are append-only and immutable after insert
- duplicate delivery of the same Telegram command or callback must resolve to the existing `approval_decision_id` via `command_idempotency_key`
- accepted `approve` transitions an `awaiting_approval` review request to `approved_pending_replay`
- accepted `reject` transitions an `awaiting_approval` review request to `abandoned`
- `review_requests.latest_approval_decision_id` points to the latest accepted or ignored decision row recorded for that review
- `review_requests.approved_at` is a denormalized convenience field populated only from the accepted `approve` decision timestamp

### `audit_events`

Purpose:
- immutable structured event log for runtime actions and policy decisions

Primary key:
- `audit_event_id`

Business keys / unique constraints:
- none beyond primary key

Relationships:
- may reference `turn_id`, `tool_call_id`, `job_id`, `job_run_id`, `review_request_id`, `approval_decision_id`, or `idempotency_record_id`

Required columns:
- `audit_event_id`
- `event_type`
- `log_visibility` = `system_redacted | operator_raw`
- `retention_class` = `success_raw | failed_job_raw | denied_write_raw | audit_metadata`
- `event_json`
- `turn_id` nullable
- `tool_call_id` nullable
- `job_id` nullable
- `job_run_id` nullable
- `review_request_id` nullable
- `approval_decision_id` nullable

Indexes:
- `event_type, created_at`
- `review_request_id, created_at`
- `job_run_id, created_at`
- `retention_class, created_at`

Retention class:
- column-driven; purge raw payloads by `retention_class`

### `idempotency_records`

Purpose:
- duplicate suppression and replay anchor for inbound messages, outbound deliveries, and job triggers

Primary key:
- `idempotency_record_id`

Business keys / unique constraints:
- unique `scope, idempotency_key`

Relationships:
- may reference a `turn_id`, outbound delivery ref, or `job_run_id`

Required columns:
- `idempotency_record_id`
- `scope` = `telegram_inbound | telegram_outbound | job_trigger`
- `idempotency_key`
- `source_ref`
- `window_expires_at`
- `retained_until`
- `terminal_status` = `accepted | completed | failed | denied`
- `result_ref` nullable
- `result_json` nullable

Indexes:
- `scope, idempotency_key`
- `window_expires_at`
- `retained_until`

Retention class:
- `audit_metadata`

## Deduplication Keys

- Telegram inbound: `tg-in:<bot_id>:<update_id>`
- Telegram inbound fallback: `tg-in:<bot_id>:<chat_id>:<topic_id>:<message_id>[:<file_unique_id>]`
- Telegram outbound: `tg-out:<route>:<origin_turn_or_job_run>:<message_purpose>`
- Job trigger: `job-run:<job_id>:<scheduled_at>`

Rules:

- duplicate inbound requests must return the previous accepted or terminal result instead of rerunning tools
- duplicate outbound delivery attempts must replay the stored result instead of sending a second Telegram message
- duplicate job triggers must reuse the existing `job_run_id` instead of inserting a second `job_runs` row

## State Transitions

### `review_requests.status`

Allowed lifecycle:

```text
drafting
  -> awaiting_approval
  -> approved_pending_replay
  -> commit_created
  -> branch_pushed
  -> pr_created
```

Allowed side states:

- `failed_recoverable` from `approved_pending_replay`, `commit_created`, or `branch_pushed`
- `conflicted` from `approved_pending_replay`
- `superseded` from `drafting` or `awaiting_approval`
- `abandoned` from `drafting` or `awaiting_approval`

Rules:

- `pr_created`, `conflicted`, `superseded`, and `abandoned` are terminal
- `failed_recoverable` is not terminal; retry resumes from the last durable checkpoint
- `commit_sha` must be non-null in `commit_created`, `branch_pushed`, and `pr_created`
- `pr_ref` must be non-null only in `pr_created`
- accepted approval transitions `awaiting_approval -> approved_pending_replay`
- accepted rejection transitions `awaiting_approval -> abandoned`

### `approval_decisions.decision_status`

Allowed lifecycle:

```text
accepted
ignored_duplicate
ignored_stale
```

Rules:

- approval decision rows do not transition after insert; `decision_status` is final at write time
- `ignored_duplicate` is used when the same decision command or callback is replayed after a prior durable decision row already exists
- `ignored_stale` is used when a command targets a review request that is already terminal or no longer in `awaiting_approval`

### `jobs.activation_state`

Allowed lifecycle:

```text
pending_approval -> active -> paused
pending_approval -> expired
active -> expired
paused -> active
paused -> expired
```

Rules:

- `expired` is terminal
- agent-created jobs default to `pending_approval`
- a job may move to `expired` because of `max_runs`, `expires_at`, or explicit administrative action

### `job_runs.status`

Allowed lifecycle:

```text
queued -> claimed -> running -> succeeded
queued -> claimed -> running -> failed_retryable
queued -> claimed -> running -> failed_terminal
queued -> cancelled
claimed -> cancelled
running -> cancelled
failed_retryable -> queued
```

Rules:

- `succeeded`, `failed_terminal`, and `cancelled` are terminal
- `failed_retryable` becomes `queued` only when a bounded retry policy schedules another attempt for the same `job_run_id`
- `attempt_count` increments on every claim, not on every row creation

### `idempotency_records.terminal_status`

Allowed lifecycle:

```text
accepted -> completed
accepted -> failed
accepted -> denied
```

Rules:

- terminal rows are immutable except for retention maintenance fields
- replay must return the stored `result_ref` and `result_json`

## Cleanup and Sweep Rules

- expired raw prompt, response, and audit payloads are purged by retention class without deleting parent metadata rows
- `review_requests` in `superseded` or `abandoned` state remain queryable for 14d before staging branch cleanup metadata may be dropped
- `approval_decisions` remain queryable for the same lifetime as their parent `review_requests`
- local staging worktree paths may be deleted immediately after a terminal review state, but the `review_requests` row and `change_manifest_json` must remain
- `idempotency_records` remain queryable until `retained_until`, even if their active deduplication window already expired
- `jobs` and `job_runs` are not hard-deleted in MVP; they may be archived later behind a separate ADR

## Migration Invariants

These invariants must not be broken by migrations:

- durable queue, retry, and idempotency behavior remains reconstructible from Postgres-backed state
- `review_requests.change_manifest_json` remains sufficient to rebuild staging after filesystem loss
- every explicit review approval or rejection remains reconstructible from `approval_decisions` without relying on transient Telegram payloads
- review approval replay always compares against the latest fetched base branch
- `idempotency_records` continue to enforce exactly one durable result per `scope, idempotency_key`
- state enums stay backward-compatible unless accompanied by an explicit schema/version migration plan
