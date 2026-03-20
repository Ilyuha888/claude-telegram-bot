# ADR-002 Python Backend

- Status: Accepted
- Date: 2026-03-10

## Context

The first version of the platform needs a backend that can integrate cleanly with Telegram transport, Postgres persistence, Git-backed services, and typed runtime contracts. The codebase is expected to remain small and explicit during the first implementation wave, with fast iteration on orchestration logic and schema boundaries.

The repository guidance already assumes:

- Python 3.12+
- explicit typing
- Pydantic at typed boundaries
- thin handlers and explicit domain services

## Decision

1. The backend implementation language for MVP is Python 3.12 or newer.
2. Typed boundaries use Python type hints and Pydantic-oriented schemas.
3. External integrations sit behind adapters so provider choices remain replaceable without changing core orchestration logic.
4. Any production dependency added to the runtime must be justified against the repository's simplicity and safety goals.

## Consequences

- The implementation language is fixed for the first scaffold and migration planning.
- Schema design, tool contracts, and persistence models can assume Python-native typing and validation patterns.
- Future non-Python components are still possible, but the runtime control plane remains Python-first unless a later ADR changes that.

## Superseding Decisions

- **Concurrency model** (`dec-20260320-002`): asyncio end-to-end. All handlers are `async def` coroutines. Dulwich (sync) is called via `asyncio.run_in_executor` only. `asyncio.run()` inside a coroutine is forbidden. DB driver must be async (psycopg3 async or asyncpg).
- **LLM provider** (`dec-20260320-003`): Gemini 2.5 Flash via the `openai` Python SDK at Google's OpenAI-compatible endpoint. Provider swappable by env var; `openai` SDK is the only LLM production dependency.
