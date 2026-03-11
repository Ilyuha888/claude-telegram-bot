# ADR-006 Git Approval Flow

- Status: Accepted
- Date: 2026-03-10

## Context

The platform treats the vault repository and Git history as the source of truth for long-term knowledge changes. The assistant must be able to prepare reviewable mutations, but it must not write into the user's live Obsidian clone or silently auto-push unreviewed changes.

The unresolved questions were tightly coupled:

- where pre-approval file mutations should live
- how to recover from partial success such as `commit ok -> push failed -> PR not created`
- whether the runtime should reuse the user's clone or maintain its own isolated working copy
- how assistant-generated review branches should be named and cleaned up

## Decision

1. The runtime uses a service-owned vault clone per environment. It never writes into the user's live Obsidian clone and never shares `.git` state with it.
2. `git.prepare_review` creates a local staging branch `assistant/staging/<review_request_id>` plus an isolated worktree rooted at a recorded `base_commit`.
3. Pre-approval mutations are materialized only inside that worktree, but every prepared review also persists a normalized `change_manifest` and review metadata in Postgres.
4. Approval is replay-based. On approval, the runtime reapplies the same `change_manifest` on top of the latest `origin/<base_branch>` in a fresh worktree. If replay conflicts or changes the reviewed diff, the request becomes `conflicted` and must be regenerated.
5. If replay is clean, the runtime commits, pushes the final review branch, and creates the PR. Final branch format is `assistant/review/<workspace_slug>/<review_request_id>-<theme_slug>`.
6. `workspace_slug` and `theme_slug` must be lowercase Git-safe ASCII. Non-Latin names are transliterated; empty or unstable slugs fall back to `<kind>-<hash8>`. A user ticket may be embedded in `theme_slug`, but a ticket is not required.
7. The review request lifecycle is `drafting -> awaiting_approval -> approved_pending_replay -> commit_created -> branch_pushed -> pr_created` with side states `failed_recoverable`, `conflicted`, `superseded`, and `abandoned`.
8. Recovery is step-local and idempotent:
   - if `commit_sha` exists and push fails, retry only push
   - if the remote branch exists and PR creation fails, retry only PR creation
   - if the staging worktree disappears, rebuild it from `change_manifest` plus `base_commit`
9. Local staging branches and worktrees are deleted immediately after terminal states. Remote review branches are deleted after PR merge or close. Superseded or abandoned review branches are swept after `14d`.

## Consequences

- Review preparation is isolated from the live Obsidian workspace, which avoids watcher conflicts and accidental writes into the user clone.
- The filesystem is no longer the only source of truth for an in-flight review request, which makes retries and cleanup deterministic.
- Approval remains truthful to the reviewed diff because replay on the latest base can block stale or silently rebased changes.
- The runtime pays the operational cost of managing a service-owned clone and temporary worktrees, but that cost is smaller than the recovery and correctness risk of staging directly in the user clone.
