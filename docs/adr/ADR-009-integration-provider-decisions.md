# ADR-009 Integration Provider Decisions

- Status: Accepted
- Date: 2026-03-10

## Context

The remaining MVP provider questions were tightly coupled to architecture boundaries:

- the Telegram gateway needs typed Bot API objects without handing control-plane ownership to a bot framework
- Git repository operations must stay inside the runtime safety model and must not depend on shelling out to `git`
- the product wants optional web search in MVP, but it does not want a second search vendor or a separate search account
- LinkedIn and Google Calendar are useful future integrations, but they are not required for the first shipped runtime

## Decision

1. The Telegram gateway uses `python-telegram-bot` v22+ as a client/types layer for Telegram Bot API transport and typed update objects.
2. The runtime does not adopt `python-telegram-bot` dispatcher, routing, or job-queue abstractions as the control plane. Webhook routing, orchestration, retries, and scheduling stay in the application.
3. Git repository operations use `Dulwich` inside the service-owned vault clone and review worktrees.
4. PR creation stays behind a separate forge-specific HTTP adapter. The Git library choice does not imply a forge API choice.
5. MVP web search uses Z.ai built-in web search in chat as an explicitly enabled model capability.
6. MVP does not expose a provider-agnostic `web.search` runtime tool. Search is a model-native capability, not a deterministic tool output.
7. This is a deliberate trade-off: the platform gives up some tool-level auditability and provider portability in exchange for avoiding a second search vendor in MVP.
8. Z.ai web search may still incur Z.ai tool charges. Using the same provider does not make search free.
9. LinkedIn and Google Calendar are removed from MVP implementation scope and remain documented post-MVP seams only.

## Rejected Alternatives

### `aiogram` as the primary Telegram boundary

`aiogram` is viable, but it is more dispatcher-centric than needed for this architecture. The runtime already has its own orchestrator, policy layer, and scheduler. `python-telegram-bot` is accepted because it gives typed Telegram objects and transport without forcing the application to inherit another control plane.

### `GitPython` for repository operations

`GitPython` depends on the `git` executable and is a poor fit for a runtime that explicitly avoids shelling out from the application path. `Dulwich` keeps repository operations in-process and aligns better with the no-shell runtime invariant.

### `Brave Search API` or another dedicated external search provider for MVP

An external search provider would preserve a cleaner tool boundary, but it would introduce a second search vendor and separate credentials immediately. MVP does not need that extra vendor split.

### `Z.ai Web Search API` as a separate runtime tool in MVP

Using Z.ai's standalone search API would keep a cleaner adapter boundary than `search in chat`, but it would still be a distinct runtime search integration. MVP accepts the weaker boundary instead.

## Consequences

- Telegram and Git library choices are now implementation-ready for MVP.
- Search in MVP is provider-specific and weaker than a dedicated search tool. It must not be used as the sole basis for critical mutations or approvals.
- If later requirements demand raw search hits, provider portability, or stricter tool-level auditing, the architecture should add back a `WebSearchProvider` adapter in a follow-up ADR.
- LinkedIn and Google Calendar can be designed later without blocking the MVP runtime.
