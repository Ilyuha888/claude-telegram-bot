# Personal Assistant Platform

Self-hosted personal assistant platform with Telegram as the primary interface, an Obsidian-backed knowledge vault, a Git approval flow for knowledge changes, scheduled jobs, and extensible tool integrations.

## Product Vision

The goal is not to build a magical autonomous agent. The goal is to build a reliable personal assistant platform with clear control boundaries:

- Telegram is the primary UX channel.
- The Obsidian knowledge vault is the main long-term knowledge system.
- Git is the source of truth for knowledge changes.
- The LLM orchestrates approved tools but does not get arbitrary shell access.
- Scheduled work runs through a separate job execution path.
- External integrations can be added later behind typed adapters.

## V1 Scope

### In Scope

1. Telegram interaction:
   - text messages
   - links
   - images
2. Knowledge vault operations:
   - read Markdown notes
   - search the vault
   - create and move Markdown notes
   - create directories
   - attach images to notes
   - create internal assistant notes
3. Git-backed change management for the knowledge vault:
   - isolated working branch
   - change summary and diff overview
   - explicit user approval
   - commit and pull request to the private knowledge repository
4. Session handling:
   - normal chat flow
   - topic-based workspaces
   - switching between active contexts
5. Scheduling:
   - reminders
   - recurring jobs
   - user-created jobs with approved `Agent_Obsidian_Vault/` artifact scopes
   - agent-created follow-up jobs that start pending approval and stay within agent-owned write scopes
6. Optional web search via Z.ai built-in web search in chat.

### Out of Scope for V1

- permanently running autonomous coding agents
- full voice UX
- multi-user support
- arbitrary script execution from the runtime LLM
- LinkedIn and Google Calendar integrations beyond documented post-MVP seams
- visibility into local vault edits before they are pushed to Git
- external secret manager integration

## Confirmed Decisions

- Runtime architecture: custom orchestrator with a deterministic tool runtime.
- Backend language: Python 3.12+.
- Runtime metadata store: Postgres.
- Knowledge model: separate knowledge-vault Git repository.
- Safety model: no arbitrary shell access for the runtime LLM.
- Workspace model: Telegram topics map to long-lived workspaces.
- LLM provider at project start: Z.ai behind an `LLMClient` interface.
- Telegram Bot API integration uses `python-telegram-bot` v22+ as a client/types layer, not as the runtime control plane.
- Git repository operations use `Dulwich`; PR creation stays behind a separate forge HTTP adapter.
- MVP web search, when enabled, uses Z.ai built-in web search in chat; this may still incur Z.ai tool charges and is not a deterministic runtime tool output.
- LinkedIn and Google Calendar remain post-MVP integration seams, not V1 implementation targets.
- Scheduled jobs may auto-persist only to approved `Agent_Obsidian_Vault/` artifact paths; `User_Obsidian_Vault/` changes remain review-gated.
- Background execution is Postgres-first; Redis is optional and never the sole holder of queue or retry state.
- Vault freshness uses Git remote as the only runtime sync boundary; unsynced local Obsidian edits are out of scope for MVP visibility.
- Deployment beyond local development targets a single VPS with host-managed secrets outside the repository; MVP does not require an external secret manager.

## High-Level Architecture

The runtime is application-first rather than agent-framework-first:

1. A Telegram gateway receives inbound updates.
2. A session manager resolves the active workspace and session.
3. An orchestrator builds context, invokes the LLM, and executes typed tool calls.
4. Tools operate behind policy checks and produce auditable side effects.
5. Persistence is split between:
   - Postgres for runtime metadata, sessions, jobs, and audit records
   - the knowledge-vault Git repository for long-term user notes, colocated attachments, and assistant-managed artifacts

Core subsystems:

- Telegram gateway
- session manager
- agent orchestrator
- tool runtime
- policy layer
- Postgres-backed persistence layer
- scheduler and worker

Detailed technical design lives in [ARCHITECTURE.md](ARCHITECTURE.md). Agent-specific operating rules live in [AGENTS.md](AGENTS.md).

## Knowledge Repository Layout

Current structure for the knowledge repository:

- `User_Obsidian_Vault/` for user-owned notes
  - hub notes and folders coexist at the top level
  - a note may have a same-named directory for deeper material, for example `Я аналитик.md` with `Я аналитик/`, or `Я студент.md` with `Я студент/`
  - attachments usually live next to the related notes in sibling `files/` directories
- `Agent_Obsidian_Vault/` for assistant-managed artifacts
  - machine-readable zones may live under direct subdirectories such as `profile/`, `rules/`, `tasks/`, `indexes/`, `drafts/`, and `reviews/`

These are working patterns rather than rigid taxonomy contracts. The user vault is intentionally heterogeneous.

## MVP Definition of Done

The MVP is done when the assistant can:

1. receive text, links, and images from Telegram
2. create or update Obsidian notes
3. attach an image to a note
4. find related notes and answer using vault context
5. show a review summary before a commit
6. create a branch, commit, and pull request after approval
7. create reminders or recurring jobs
8. operate across multiple topic-based workspaces without mixing context

## Open Decisions and TBDs

The canonical open-decision list lives in [ARCHITECTURE.md](ARCHITECTURE.md#tbd--open-decisions).

## Roadmap

### Phase 0

- runtime repository scaffold
- Docker Compose setup
- Telegram receive and send flow
- Z.ai adapter
- minimal tool loop

### Phase 1

- Obsidian read, write, and search
- Git approval flow
- sessions and summaries
- reminders and recurring jobs
- image attachment flow

### Phase 2

- Telegram topics as workspaces
- per-workspace profiles
- workspace summaries
- bootstrap commands for new workspaces

### Phase 3

- vault indexing
- note linking suggestions
- duplicate detection
- inbox-to-structured-note workflows

### Phase 4

- external integrations behind adapters
- broader automation capabilities after the open decisions are resolved
