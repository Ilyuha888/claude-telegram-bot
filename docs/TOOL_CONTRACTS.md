# Tool Contracts

This document is the canonical V1 contract for runtime tools. It specifies payload shape, policy hooks, audit requirements, and expected error surfaces so implementation can proceed without inventing wire-level details during the scaffold.

All tools share these baseline rules:

- inputs and outputs are Pydantic-oriented object schemas
- unknown fields are rejected
- timestamps are ISO 8601 UTC strings
- repository paths are vault-relative POSIX-style strings
- all tool results include `ok: bool`
- `error_code` is present only on failed results

## Common Enums

### Side-effect class

- `none`
- `filesystem_write`
- `git_read`
- `review_prepare`
- `scheduler_write`

### Policy names

- `path_allowlist`
- `filetype_allowlist`
- `review_flow`
- `job_scope`
- `job_activation`
- `schedule_bounds`
- `provider_capability_gate`

### Error codes

- `validation_error`
- `not_found`
- `policy_denied`
- `conflict`
- `duplicate_request`
- `provider_error`
- `storage_error`

## Read-Only Tools

### `vault.read_note`

- Purpose: read a Markdown note and enough metadata to ground the current turn.
- Side-effect class: `none`
- Required policies: `path_allowlist`
- Input schema:

```yaml
VaultReadNoteRequest:
  path: string
  include_rendered_links: bool = false
  include_frontmatter: bool = true
```

- Output schema:

```yaml
VaultReadNoteResult:
  ok: bool
  note:
    path: string
    title: string
    content_markdown: string
    frontmatter: object | null
    wikilinks:
      - string
    outbound_paths:
      - string
    last_modified_at: string | null
  error_code: string | null
```

- Audit fields:
  - `workspace_id`
  - `tool_name`
  - `requested_path`
  - `resolved_path`
- Main errors:
  - `validation_error`
  - `not_found`
  - `policy_denied`

### `vault.search`

- Purpose: search the vault for notes matching text query and optional path scope.
- Side-effect class: `none`
- Required policies: `path_allowlist`
- Input schema:

```yaml
VaultSearchRequest:
  query: string
  scope_prefixes:
    - string
  limit: int = 10
  include_snippets: bool = true
```

- Output schema:

```yaml
VaultSearchResult:
  ok: bool
  results:
    - path: string
      title: string
      score: float
      snippet: string | null
  truncated: bool
  error_code: string | null
```

- Audit fields:
  - `workspace_id`
  - `tool_name`
  - `query`
  - `scope_prefixes`
  - `result_count`
- Main errors:
  - `validation_error`
  - `policy_denied`
  - `storage_error`

### `vault.list_directory`

- Purpose: inspect a vault subtree without reading every note body.
- Side-effect class: `none`
- Required policies: `path_allowlist`
- Input schema:

```yaml
VaultListDirectoryRequest:
  path: string
  recursive: bool = false
  limit: int = 200
```

- Output schema:

```yaml
VaultListDirectoryResult:
  ok: bool
  entries:
    - path: string
      kind: file | directory
      size_bytes: int | null
      last_modified_at: string | null
  truncated: bool
  error_code: string | null
```

- Audit fields:
  - `workspace_id`
  - `tool_name`
  - `requested_path`
  - `recursive`
  - `entry_count`
- Main errors:
  - `validation_error`
  - `not_found`
  - `policy_denied`

### `git.diff_status`

- Purpose: inspect the prepared diff for an existing review request or staging worktree.
- Side-effect class: `git_read`
- Required policies: `review_flow`
- Input schema:

```yaml
GitDiffStatusRequest:
  review_request_id: string
  include_patch_stats: bool = true
  include_paths: bool = true
```

- Output schema:

```yaml
GitDiffStatusResult:
  ok: bool
  review_request_id: string
  base_commit: string
  staging_branch: string
  changed_paths:
    - path: string
      change_type: added | modified | deleted | renamed
  stats:
    files_changed: int
    insertions: int
    deletions: int
  error_code: string | null
```

- Audit fields:
  - `workspace_id`
  - `tool_name`
  - `review_request_id`
  - `files_changed`
- Main errors:
  - `validation_error`
  - `not_found`
  - `storage_error`

### `jobs.list`

- Purpose: list scheduled jobs visible in the active workspace.
- Side-effect class: `none`
- Required policies: none
- Input schema:

```yaml
JobsListRequest:
  workspace_id: string | null
  activation_states:
    - pending_approval | active | paused | expired
  limit: int = 50
```

- Output schema:

```yaml
JobsListResult:
  ok: bool
  jobs:
    - job_id: string
      kind: reminder | recurring_review | reindex | external_poll
      activation_state: pending_approval | active | paused | expired
      next_run_at: string | null
      artifact_root: string
  error_code: string | null
```

- Audit fields:
  - `workspace_id`
  - `tool_name`
  - `activation_states`
  - `result_count`
- Main errors:
  - `validation_error`
  - `storage_error`

## Controlled-Write Tools

Write-root selector:

- `target_root: user | agent = user`
- `target_root = agent` requests resolution under `Agent_Obsidian_Vault/`
- `target_root = user` keeps resolution inside approved user-owned write roots

### `vault.create_note`

- Purpose: create a new Markdown note inside an approved vault root.
- Side-effect class: `filesystem_write`
- Required policies: `path_allowlist`, `filetype_allowlist`, `review_flow`
- Input schema:

```yaml
VaultCreateNoteRequest:
  path: string
  target_root: user | agent = user
  title: string | null
  content_markdown: string
  frontmatter: object | null
  create_parent_directories: bool = false
```

- Output schema:

```yaml
VaultCreateNoteResult:
  ok: bool
  mutation:
    operation: create_note
    requested_path: string
    effective_path: string
    content_sha256: string
    review_required: bool
  error_code: string | null
```

- Audit fields:
  - `workspace_id`
  - `tool_name`
  - `requested_path`
  - `effective_path`
  - `target_root`
  - `content_sha256`
  - `policy_decision`
- Main errors:
  - `validation_error`
  - `policy_denied`
  - `conflict`
  - `storage_error`

### `vault.update_note`

- Purpose: update an existing Markdown note under review-gated write rules.
- Side-effect class: `filesystem_write`
- Required policies: `path_allowlist`, `filetype_allowlist`, `review_flow`
- Input schema:

```yaml
VaultUpdateNoteRequest:
  path: string
  target_root: user | agent = user
  content_markdown: string
  frontmatter: object | null
  expected_content_sha256: string | null
```

- Output schema:

```yaml
VaultUpdateNoteResult:
  ok: bool
  mutation:
    operation: update_note
    requested_path: string
    effective_path: string
    new_content_sha256: string
    review_required: bool
  error_code: string | null
```

- Audit fields:
  - `workspace_id`
  - `tool_name`
  - `requested_path`
  - `effective_path`
  - `target_root`
  - `expected_content_sha256`
  - `new_content_sha256`
  - `policy_decision`
- Main errors:
  - `validation_error`
  - `not_found`
  - `policy_denied`
  - `conflict`
  - `storage_error`

### `vault.move_note`

- Purpose: move or rename a note within approved roots without widening write scope.
- Side-effect class: `filesystem_write`
- Required policies: `path_allowlist`, `filetype_allowlist`, `review_flow`
- Input schema:

```yaml
VaultMoveNoteRequest:
  source_path: string
  destination_path: string
  target_root: user | agent = user
  move_sibling_files_dir: bool = true
```

- Output schema:

```yaml
VaultMoveNoteResult:
  ok: bool
  mutation:
    operation: move_note
    source_path: string
    destination_path: string
    moved_related_paths:
      - string
    review_required: bool
  error_code: string | null
```

- Audit fields:
  - `workspace_id`
  - `tool_name`
  - `source_path`
  - `destination_path`
  - `target_root`
  - `moved_related_paths`
  - `policy_decision`
- Main errors:
  - `validation_error`
  - `not_found`
  - `policy_denied`
  - `conflict`

### `vault.delete_note`

- Purpose: delete a Markdown note under review-gated rules and optionally delete its sibling `files/` directory.
- Side-effect class: `filesystem_write`
- Required policies: `path_allowlist`, `filetype_allowlist`, `review_flow`
- Input schema:

```yaml
VaultDeleteNoteRequest:
  note_path: string
  target_root: user | agent = user
  delete_sibling_files_dir: bool = false
  expected_content_sha256: string | null
```

- Output schema:

```yaml
VaultDeleteNoteResult:
  ok: bool
  mutation:
    operation: delete_note
    note_path: string
    deleted_related_paths:
      - string
    review_required: bool
  error_code: string | null
```

- Audit fields:
  - `workspace_id`
  - `tool_name`
  - `note_path`
  - `target_root`
  - `delete_sibling_files_dir`
  - `expected_content_sha256`
  - `policy_decision`
- Main errors:
  - `validation_error`
  - `not_found`
  - `policy_denied`
  - `conflict`

### `vault.create_directory`

- Purpose: create a directory that will hold notes or colocated assets.
- Side-effect class: `filesystem_write`
- Required policies: `path_allowlist`, `review_flow`
- Input schema:

```yaml
VaultCreateDirectoryRequest:
  path: string
  target_root: user | agent = user
  create_parents: bool = true
```

- Output schema:

```yaml
VaultCreateDirectoryResult:
  ok: bool
  mutation:
    operation: create_directory
    requested_path: string
    effective_path: string
    review_required: bool
  error_code: string | null
```

- Audit fields:
  - `workspace_id`
  - `tool_name`
  - `requested_path`
  - `effective_path`
  - `target_root`
  - `policy_decision`
- Main errors:
  - `validation_error`
  - `policy_denied`
  - `conflict`

### `vault.move_directory`

- Purpose: move or rename a directory within approved roots without widening write scope.
- Side-effect class: `filesystem_write`
- Required policies: `path_allowlist`, `review_flow`
- Input schema:

```yaml
VaultMoveDirectoryRequest:
  source_path: string
  destination_path: string
  target_root: user | agent = user
```

- Output schema:

```yaml
VaultMoveDirectoryResult:
  ok: bool
  mutation:
    operation: move_directory
    source_path: string
    destination_path: string
    review_required: bool
  error_code: string | null
```

- Audit fields:
  - `workspace_id`
  - `tool_name`
  - `source_path`
  - `destination_path`
  - `target_root`
  - `policy_decision`
- Main errors:
  - `validation_error`
  - `not_found`
  - `policy_denied`
  - `conflict`

### `vault.delete_directory`

- Purpose: delete a directory inside an approved root under review-gated rules.
- Side-effect class: `filesystem_write`
- Required policies: `path_allowlist`, `review_flow`
- Input schema:

```yaml
VaultDeleteDirectoryRequest:
  path: string
  target_root: user | agent = user
  recursive: bool = false
  require_empty: bool = true
```

- Output schema:

```yaml
VaultDeleteDirectoryResult:
  ok: bool
  mutation:
    operation: delete_directory
    requested_path: string
    effective_path: string
    review_required: bool
  error_code: string | null
```

- Audit fields:
  - `workspace_id`
  - `tool_name`
  - `requested_path`
  - `effective_path`
  - `target_root`
  - `recursive`
  - `require_empty`
  - `policy_decision`
- Main errors:
  - `validation_error`
  - `not_found`
  - `policy_denied`
  - `conflict`

### `vault.attach_image`

- Purpose: persist an inbound image into a note-local `files/` directory and optionally patch note content to reference it.
- Side-effect class: `filesystem_write`
- Required policies: `path_allowlist`, `filetype_allowlist`, `review_flow`
- Input schema:

```yaml
VaultAttachImageRequest:
  note_path: string
  target_root: user | agent = user
  source_upload_id: string
  original_filename: string | null
  mime_type: string
  checksum_sha256: string
  embed_in_note: bool = true
  embed_alt_text: string | null
```

- Output schema:

```yaml
VaultAttachImageResult:
  ok: bool
  mutation:
    operation: attach_image
    note_path: string
    requested_asset_path: string
    effective_asset_path: string
    attachment_link_markdown: string | null
    policy_decision: allow | deny | remap
    fallback_reason: null | outside_write_root | obsidian_attachment_escape
    review_required: bool
  error_code: string | null
```

- Audit fields:
  - `workspace_id`
  - `tool_name`
  - `note_path`
  - `target_root`
  - `source_upload_id`
  - `requested_asset_path`
  - `effective_asset_path`
  - `policy_decision`
  - `fallback_reason`
- Main errors:
  - `validation_error`
  - `not_found`
  - `policy_denied`
  - `storage_error`

### `git.prepare_review`

- Purpose: create or update a review request by materializing pending mutations in an isolated staging worktree.
- Side-effect class: `review_prepare`
- Required policies: `review_flow`
- Input schema:

```yaml
GitPrepareReviewRequest:
  workspace_id: string
  base_branch: string = "main"
  theme_slug_hint: string | null
  change_set:
    - operation: create_note | update_note | move_note | delete_note | create_directory | move_directory | delete_directory | attach_image
      path: string | null
      source_path: string | null
      destination_path: string | null
      content_sha256: string | null
  supersedes_review_request_id: string | null
```

- Output schema:

```yaml
GitPrepareReviewResult:
  ok: bool
  review_request:
    id: string
    status: drafting | awaiting_approval | approved_pending_replay | commit_created | branch_pushed | pr_created | failed_recoverable | conflicted | superseded | abandoned
    base_branch: string
    base_commit: string
    staging_branch: string
    staging_worktree_path: string
    branch_name: string
    change_manifest:
      - op: string
        path: string | null
        source_path: string | null
        destination_path: string | null
        content_sha256: string | null
    review_summary_path: string | null
  error_code: string | null
```

- Audit fields:
  - `workspace_id`
  - `tool_name`
  - `review_request_id`
  - `base_branch`
  - `base_commit`
  - `change_count`
  - `supersedes_review_request_id`
- Main errors:
  - `validation_error`
  - `policy_denied`
  - `conflict`
  - `storage_error`
  - `provider_error`

### `jobs.create`

- Purpose: create a reminder or recurring job bound to a workspace and an approved write scope.
- Side-effect class: `scheduler_write`
- Required policies: `job_scope`, `job_activation`, `schedule_bounds`, `review_flow`
- Input schema:

```yaml
JobsCreateRequest:
  workspace_id: string
  kind: reminder | recurring_review | reindex | external_poll
  schedule:
    kind: datetime | interval | cron
    run_at: string | null
    interval_seconds: int | null
    cron_expr: string | null
    timezone: string | null
  prompt_template: string
  created_by: user | agent
  allowed_write_prefixes:
    - string
  artifact_root: string
  approval_mode: on_create | per_change_set
  max_runs: int | null
  expires_at: string | null
  allow_self_reschedule_within_bounds: bool
```

- Output schema:

```yaml
JobsCreateResult:
  ok: bool
  job:
    job_id: string
    activation_state: pending_approval | active | paused | expired
    next_run_at: string | null
    artifact_root: string
    allowed_write_prefixes:
      - string
  error_code: string | null
```

- Audit fields:
  - `workspace_id`
  - `tool_name`
  - `job_id`
  - `created_by`
  - `kind`
  - `activation_state`
  - `allowed_write_prefixes`
  - `approval_mode`
- Main errors:
  - `validation_error`
  - `policy_denied`
  - `duplicate_request`
  - `storage_error`

### `jobs.cancel`

- Purpose: stop future execution of a scheduled job without deleting historical runs.
- Side-effect class: `scheduler_write`
- Required policies: `job_activation`
- Input schema:

```yaml
JobsCancelRequest:
  job_id: string
  reason: string | null
```

- Output schema:

```yaml
JobsCancelResult:
  ok: bool
  job:
    job_id: string
    previous_activation_state: pending_approval | active | paused | expired
    new_activation_state: paused | expired
  error_code: string | null
```

- Audit fields:
  - `workspace_id`
  - `tool_name`
  - `job_id`
  - `reason`
  - `previous_activation_state`
  - `new_activation_state`
- Main errors:
  - `validation_error`
  - `not_found`
  - `policy_denied`
  - `conflict`

## Notes

- Review-gated tools may materialize staged mutations before approval, but they must not commit, push, or create a PR until the review request is approved.
- `provider_capability_gate` applies at the orchestrator level for model-native capabilities such as Gemini grounding; it is not a standalone V1 tool.
- Any incompatible schema change in this document must be paired with an update to `ARCHITECTURE.md` or a new ADR when it changes a stable boundary.
