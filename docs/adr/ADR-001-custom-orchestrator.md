# ADR-001 Custom Orchestrator

- Status: Accepted
- Date: 2026-03-10

## Context

The platform needs a runtime that can combine Telegram interaction, vault access, Git-backed review flows, and scheduled jobs under strict safety controls. Research-agent frameworks optimize for autonomy and flexible tool loops, but they blur control-plane ownership and make it harder to enforce deterministic policies around filesystem writes, approvals, and auditability.

The runtime therefore needs one place that owns:

- session and workspace resolution
- prompt construction
- tool registration and validation
- policy checks
- audit logging
- scheduled execution semantics

## Decision

1. The runtime is a custom application orchestrator, not a research-agent framework.
2. The orchestrator owns turn execution end to end: context assembly, model invocation, tool loop, policy enforcement, and response rendering.
3. External libraries may provide typed adapters or transport helpers, but they must not become the runtime control plane.
4. Any future capability that weakens deterministic policy enforcement or review-before-commit guarantees requires a new ADR.

## Consequences

- Core runtime behavior stays explicit and reviewable instead of being spread across framework internals.
- Safety boundaries such as no-shell runtime access and policy-controlled writes remain enforceable in one place.
- The project gives up some framework speed-of-adoption in exchange for clearer invariants and easier long-term evolution.
