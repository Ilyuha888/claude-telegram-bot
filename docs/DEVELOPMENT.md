# Development

This document is the normative bootstrap contract for the first runtime scaffold. The repository is currently docs-first, so some commands below describe the required scaffold shape rather than already-checked-in executables.

## Current Repository State

- the repository currently contains design and contract documents, not a runnable runtime scaffold
- the first implementation must satisfy the contracts in `ARCHITECTURE.md`, `TOOL_CONTRACTS.md`, `DATA_MODEL.md`, and `API_SURFACES.md`
- no developer should introduce runtime behavior that contradicts these documents without updating them or adding a new ADR

## Local Prerequisites

Required for the first scaffold:

- Python 3.12+
- Docker and Docker Compose plugin
- Postgres client tools or container access for schema inspection
- Git access to the private knowledge-vault repository
- Telegram bot token
- Z.ai API access

## Environment Contract

These names are the required environment contract for the first scaffold.

### Required variables

- `APP_ENV`
- `LOG_LEVEL`
- `POSTGRES_DSN`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `ZAI_API_KEY`
- `VAULT_REPO_URL`
- `VAULT_BASE_BRANCH`
- `VAULT_LOCAL_PATH`
- `VAULT_SSH_KEY_PATH`

### Optional variables

- `OPERATOR_DEBUG_AUDIT_ENABLED`
- `VAULT_SYNC_INTERVAL_SECONDS`
- `WORKER_POLL_INTERVAL_SECONDS`

### Secret handling rules

- real secret values must live outside the repository
- local development may use a non-committed env file such as `.env.local`
- deploy keys remain file-based, for example `/run/secrets/vault_deploy_key`
- no `.env`, token dumps, SSH keys, or provider credentials may be committed

Example path conventions:

- vault clone: `/srv/personal-assistant/vault/main`
- vault worktrees: `/srv/personal-assistant/vault/worktrees`
- secrets directory: `/srv/personal-assistant/secrets`

## Expected Scaffold Layout

The first implementation should keep the runtime split explicit. One acceptable layout is:

```text
src/
  app/
    api/
    telegram/
    orchestrator/
    tools/
    policy/
    scheduler/
    persistence/
    integrations/
    domain/
tests/
  unit/
  integration/
docker/
  compose/
migrations/
```

Required architectural properties:

- thin transport handlers
- explicit domain services
- Pydantic-oriented schemas at tool and transport boundaries
- persistence models separated from transport payloads
- no shell execution in the runtime path

## Local Stack Expectations

When the scaffold is added, it must support a local stack with these components:

- `api` for webhook receive and health endpoints
- `worker` for scheduled jobs and replay/retry flows
- `postgres` for durable runtime state

The scaffold should provide:

- one documented command to start infrastructure
- one documented command to run migrations
- one documented command to start the API process
- one documented command to start the worker process
- one documented command to run tests

Command names are not fixed yet, but once chosen they must be added here and to `README.md`.

## Minimum Smoke Test

The first runnable scaffold is acceptable only if a developer can perform this sequence locally:

1. start Postgres and the runtime services
2. pass readiness checks on `GET /health/live` and `GET /health/ready`
3. receive one Telegram webhook payload and persist one `turn`
4. execute one read-only tool call and record one `tool_calls` row
5. create one review request in staging without touching a live user vault clone
6. create one scheduled job and record one `jobs` row
7. trigger one `job_runs` row through the worker path

If any of these steps require ad hoc manual state edits, the scaffold is not ready.

## Safety Rules for Developers

Never do the following in the first implementation:

- add shell execution to the runtime path
- store secrets in the repository
- write into the user's live Obsidian clone
- bypass review-before-commit for `User_Obsidian_Vault/`

If one of these seems necessary, stop and document the trade-off in a new ADR first.

## Branch and Review Policy

Two Git contexts exist and must stay separate:

- runtime repository branches for application code and documentation changes
- knowledge-vault review branches for proposed note mutations

Rules:

- runtime-repo changes follow normal development branch and PR flow
- knowledge-vault changes are always staged in the service-owned vault clone
- pre-approval vault mutations live only in isolated staging worktrees
- commit, push, and PR creation for knowledge-vault changes happen only after approval

## Definition of Ready for Coding

A feature is ready to implement when:

- its runtime boundary is covered by `TOOL_CONTRACTS.md`, `DATA_MODEL.md`, or `API_SURFACES.md`
- it does not contradict any accepted ADR
- its persistence implications are clear enough to write migrations without guessing
- its test path fits the minimum smoke-test model above
