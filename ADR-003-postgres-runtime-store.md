# ADR-003 Postgres Runtime Store

- Status: Accepted
- Date: 2026-03-10

## Context

The runtime needs durable storage for sessions, jobs, retries, idempotency, review requests, and audit records. These records cannot depend on ephemeral memory or optional accelerators because they define correctness, replay behavior, and operational recovery.

The architecture also allows optional Redis usage, but only as an accelerator for wake-up hints, rate-limit counters, or short-lived caches.

## Decision

1. Postgres is the required runtime metadata store for MVP.
2. Postgres is the durable source of truth for sessions, turns, job queue state, retry state, idempotency records, review requests, and audit events.
3. Redis is optional and must never be the sole holder of queue state, retry state, or deduplication state.
4. Runtime flows that rely on replay, recovery, or approval must be reconstructible from Postgres plus the vault Git repository.

## Consequences

- The first implementation can design migrations, polling, retention, and replay around one mandatory durable store.
- Optional Redis usage stays operationally helpful but non-critical.
- Any future move away from Postgres for durable workflow state would materially change correctness and requires a new ADR.
