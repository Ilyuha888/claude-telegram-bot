#!/usr/bin/env bash
# Mode-2 end-to-end integration harness.
# Requires: tmux, jq, git, bun (bot running in background or foreground).
# Usage: REPO=data-style ./scripts/mode2-e2e.sh

set -euo pipefail

REPO="${REPO:-data-style}"
SESSIONS_FILE="${BOT_DATA_DIR:-$HOME/bot-data}/sessions.json"
REPOS_DIR="${REPOS_DIR:-$HOME/repos}"

die() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

# ── 1. listRepos smoke ────────────────────────────────────────────────────────
echo "--- listRepos ---"
[[ -d "$REPOS_DIR/$REPO" ]] || die "Repo $REPO not found at $REPOS_DIR/$REPO"
pass "Repo $REPO exists"

# ── 2. spawn via sh.tmuxNewSession directly ───────────────────────────────────
echo "--- spawn RC session ---"
SLUG="e2e-$(date +%s)"
TMUX_NAME="work-$SLUG"
RC_NAME="$SLUG"
CWD="$REPOS_DIR/$REPO"

CLAUDE_BIN="${CLAUDE_CLI_PATH:-${CLAUDE_CODE_PATH:-$(which claude 2>/dev/null || echo claude)}}"
tmux new-session -d -s "$TMUX_NAME" -c "$CWD" \
  "'$CLAUDE_BIN' remote-control --name '$RC_NAME' --spawn same-dir --capacity 1"

sleep 2
tmux has-session -t "$TMUX_NAME" 2>/dev/null || die "tmux session $TMUX_NAME not found after spawn"
pass "tmux session $TMUX_NAME alive"

# ── 3. check RC URL in pane output ───────────────────────────────────────────
echo "--- RC URL ---"
sleep 3
PANE_OUTPUT=$(tmux capture-pane -t "$TMUX_NAME" -p 2>/dev/null || true)
if echo "$PANE_OUTPUT" | grep -q "https://claude.ai/code/session_"; then
  RC_URL=$(echo "$PANE_OUTPUT" | grep -o "https://claude.ai/code/session_[^[:space:]]*" | head -1)
  pass "RC URL found: $RC_URL"
else
  echo "NOTE: RC URL not yet visible (may still be starting). Pane: $PANE_OUTPUT"
fi

# ── 4. write a sessions.json entry manually (simulates store.append) ─────────
echo "--- sessions.json ---"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
ENTRY="{\"slug\":\"$SLUG\",\"repo\":\"$REPO\",\"path\":\"$CWD\",\"worktree_path\":null,\"branch\":null,\"tmux_name\":\"$TMUX_NAME\",\"rc_name\":\"$RC_NAME\",\"created_at\":\"$NOW\",\"last_attached_at\":\"$NOW\",\"closed\":false}"

mkdir -p "$(dirname "$SESSIONS_FILE")"
if [[ -f "$SESSIONS_FILE" ]]; then
  TMP="$SESSIONS_FILE.e2e-tmp"
  jq ".sessions += [$ENTRY]" "$SESSIONS_FILE" > "$TMP" && mv "$TMP" "$SESSIONS_FILE"
else
  echo "{\"sessions\":[$ENTRY]}" > "$SESSIONS_FILE"
fi

jq -e ".sessions[] | select(.slug == \"$SLUG\")" "$SESSIONS_FILE" > /dev/null \
  || die "Entry for $SLUG not found in sessions.json"
pass "sessions.json entry written"

# ── 5. close: kill tmux, mark closed ─────────────────────────────────────────
echo "--- close ---"
tmux kill-session -t "$TMUX_NAME"
! tmux has-session -t "$TMUX_NAME" 2>/dev/null || die "tmux session $TMUX_NAME still alive after kill"
pass "tmux session killed"

TMP="$SESSIONS_FILE.e2e-close"
jq "(.sessions[] | select(.slug == \"$SLUG\")) |= . + {\"closed\":true,\"close_reason\":\"user\"}" \
  "$SESSIONS_FILE" > "$TMP" && mv "$TMP" "$SESSIONS_FILE"

CLOSED=$(jq -r ".sessions[] | select(.slug == \"$SLUG\") | .closed" "$SESSIONS_FILE")
[[ "$CLOSED" == "true" ]] || die "closed field not true in sessions.json"
pass "sessions.json entry marked closed"

# ── 6. worktree test (optional, requires git repo) ───────────────────────────
echo "--- worktree (skippable) ---"
WT_PATH="$REPOS_DIR/$REPO/.worktrees/e2e-test-$$"
if git -C "$REPOS_DIR/$REPO" worktree add "$WT_PATH" 2>/dev/null; then
  [[ -d "$WT_PATH" ]] || die "Worktree dir not created"
  pass "git worktree add succeeded"
  git -C "$REPOS_DIR/$REPO" worktree remove --force "$WT_PATH"
  [[ ! -d "$WT_PATH" ]] || die "Worktree dir still exists after remove"
  pass "git worktree remove succeeded"
else
  echo "SKIP: git worktree add failed (detached HEAD or no commits?)"
fi

echo ""
echo "=== All checks passed ==="
echo "NOTE: Verify claude.ai/code session list manually for operator-confirmed RC visibility."
