# ADR-004 Topic as Workspace

- Status: Accepted
- Date: 2026-03-10

## Context

Telegram is the primary user interface, and the product needs long-lived contexts that do not collapse when chat history is compacted. A plain chat-thread model is too weak because the system needs stable namespaces for summaries, policies, scheduled work, and vault defaults.

Telegram topics already provide a user-facing separation model that matches the desired notion of ongoing work areas such as analytics, career, or personal planning.

## Decision

1. A Telegram topic maps to a long-lived workspace namespace in the runtime.
2. Workspace identity is stable across multiple sessions and compaction cycles.
3. Sessions are temporary conversational spans inside a workspace, not replacements for workspace identity.
4. Default non-topic chats use the `default` workspace model until a stronger explicit mapping is introduced.

## Consequences

- Session compaction can reset raw conversational history without losing workspace-specific memory.
- Scheduled jobs, review flows, and vault defaults can bind to a stable workspace identifier.
- Any future multi-channel support must preserve the distinction between stable workspace identity and transient session state.
