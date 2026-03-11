# ADR-005 No Shell Runtime

- Status: Accepted
- Date: 2026-03-10

## Context

The runtime will be allowed to read and write user knowledge through controlled tools, stage Git-backed reviews, and execute scheduled jobs. Giving the runtime LLM arbitrary shell access would bypass the policy layer, expand the writable surface, and undermine auditability.

The repository safety rules also explicitly prohibit adding shell execution to the runtime path without direct approval.

## Decision

1. The runtime LLM must not receive arbitrary shell execution capabilities.
2. Filesystem writes go only through typed, policy-controlled tools or services.
3. Git operations in the runtime path must remain in-process and adapter-based rather than shelling out to `git`.
4. Any future proposal to introduce shell execution into the runtime path requires an ADR and an explicit safety trade-off analysis.

## Consequences

- Tool contracts and policy checks remain the only approved path for runtime side effects.
- Runtime Git and filesystem behavior stay auditable and easier to sandbox.
- Some operational shortcuts are intentionally disallowed in exchange for a narrower and safer execution model.
