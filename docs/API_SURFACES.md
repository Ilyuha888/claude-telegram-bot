# API Surfaces

This document defines the MVP transport and service boundaries. It exists to remove ambiguity around the `api` service named in `ARCHITECTURE.md` without inventing extra public endpoints that the product does not need.

Global rules:

- Telegram is the primary user-facing transport
- inbound user actions reach the runtime through one Telegram webhook entrypoint
- review approval, review rejection, and job management are Telegram-command flows in MVP unless explicitly stated otherwise below
- all HTTP responses are JSON except Telegram file downloads, which are handled through Telegram provider adapters rather than public API routes

## HTTP Endpoints

### `GET /health/live`

- Caller: load balancer, container runtime, or operator
- Purpose: liveness check for process availability
- Request shape: no body
- Response shape:

```json
{
  "ok": true,
  "service": "api",
  "check": "live"
}
```

- Idempotency expectation: not applicable
- Auth expectation: none on trusted infrastructure path
- Failure model:
  - `503` if the process cannot serve requests

### `GET /health/ready`

- Caller: load balancer, container runtime, or operator
- Purpose: readiness check for serving webhook traffic
- Request shape: no body
- Response shape:

```json
{
  "ok": true,
  "service": "api",
  "check": "ready",
  "dependencies": {
    "postgres": "ok",
    "vault_clone": "ok"
  }
}
```

- Idempotency expectation: not applicable
- Auth expectation: none on trusted infrastructure path
- Failure model:
  - `503` if required dependencies such as Postgres or the service-owned vault clone are unavailable

### `POST /telegram/webhook`

- Caller: Telegram Bot API
- Purpose: receive inbound updates, callback queries, topic messages, and media metadata
- Request shape:

```json
{
  "update_id": 123456789,
  "...": "Telegram update payload"
}
```

- Response shape:

```json
{
  "ok": true,
  "accepted": true,
  "update_id": 123456789,
  "idempotency_key": "tg-in:<bot_id>:<update_id>"
}
```

- Idempotency expectation:
  - deduplicate by inbound Telegram idempotency rules before executing tools
  - duplicates must replay the previously stored result instead of creating a second turn
- Auth expectation:
  - validate Telegram webhook secret or equivalent shared secret header when configured
  - reject requests from non-Telegram callers on public deployments
- Failure model:
  - `400` on malformed update payload
  - `401` on failed webhook authentication
  - `202` when accepted for async processing
  - `200` when synchronously accepted and fully recorded
  - never expose internal stack traces in body

## Telegram Command and Callback Entry Points

These are user-visible flows, but they are not separate HTTP endpoints. They arrive through `POST /telegram/webhook` as normal Telegram updates.

### Review approval or rejection

- Caller: Telegram user through slash command, text reply, or inline callback button
- Entry path: `POST /telegram/webhook`
- Request shape inside normalized runtime command:

```yaml
ReviewDecisionCommand:
  review_request_id: string
  decision: approve | reject
  actor_user_id: string
  source_message_ref: string | null
  source_callback_ref: string | null
  command_idempotency_key: string
  reason: string | null
```

- Response shape:
  - Telegram message acknowledging the decision
  - optional review status summary rendered back to the same route
- Idempotency expectation:
  - duplicate callback or command delivery must resolve to the same durable approval-decision record and must not transition review state twice
- Auth expectation:
  - only the logical owner of the workspace may approve or reject the review
- Failure model:
  - rejected with user-visible explanation if review is already terminal, conflicted, or unknown

### Job management

- Caller: Telegram user through command or guided conversational flow
- Entry path: `POST /telegram/webhook`
- Supported actions in MVP:
  - create job
  - list jobs
  - cancel job
- Response shape:
  - Telegram-rendered confirmation or validation error
- Idempotency expectation:
  - retries of the same Telegram update must not create duplicate jobs
- Auth expectation:
  - only the workspace owner may manage jobs in that workspace
- Failure model:
  - validation failures return a user-visible correction prompt
  - policy failures return an explicit denial rather than partial creation

## Outbound Telegram Delivery Boundary

This is not a public HTTP endpoint of the runtime. It is an adapter boundary between the orchestrator and Telegram Bot API transport.

Request shape:

```yaml
TelegramOutboundRequest:
  route:
    chat_id: string
    topic_id: string | null
  message_purpose: assistant_reply | review_summary | reminder | job_result | error_notice
  content:
    text: string | null
    parse_mode: MarkdownV2 | HTML | null
    media_group: list | null
  idempotency_key: string
```

Response shape:

```yaml
TelegramOutboundResult:
  ok: bool
  delivery_ref: string | null
  sent_at: string | null
  error_code: string | null
```

Idempotency expectation:

- deduplicate by `tg-out:<route>:<origin_turn_or_job_run>:<message_purpose>`
- retries must replay the prior delivery result rather than emit a second Telegram message

Auth expectation:

- Bot API token is provided through deployment secrets

Failure model:

- provider failures are retried with outbound idempotency intact
- terminal provider denials are surfaced as audit events and operator-visible failures

## Internal Service Boundaries

These are not public network APIs, but the first scaffold should preserve them as explicit adapter seams:

- `TelegramGateway` receives and normalizes inbound updates
- `LLMClient` invokes the configured LLM provider via the `openai` SDK and optionally enables model-native web search (Gemini grounding)
- `VaultService` reads the synced vault working copy and writes only through policy-controlled mutation flows
- `GitService` prepares reviews, replays approved manifests, and creates final branches and PRs through adapters
- `SchedulerService` claims due jobs, enforces activation rules, and records `job_runs`

## Non-Goals for MVP API Surface

The MVP does not expose these as standalone HTTP APIs:

- generic admin CRUD for sessions, turns, or vault contents
- direct HTTP endpoint for review approval outside Telegram
- direct HTTP endpoint for ad hoc vault search outside Telegram
- provider-agnostic `web.search` API

If any of these surfaces become necessary, add them through a follow-up ADR or an update to this document.
