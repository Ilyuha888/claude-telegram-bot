#!/usr/bin/env bash
#
# Writes the interactive-session permission rules (config/claude-permissions.json)
# into .claude/settings.local.json of every git repo under REPOS_DIR, so the KB
# Assistant and mode-2 remote-control hosts stop asking for local work; worktrees
# receive the file through WORKTREE_COPY_PATHS. `remote-control` has no
# --settings flag and Claude Code has no user-level local settings file, which is
# why this is per repo.
#
# The repo that is the bot's CLAUDE_WORKING_DIR gets no broad allows: mode 1 runs
# there with its own canUseTool policy (src/security.ts), and a bare Bash allow
# would let the CLI approve commands before that policy sees them and empty the
# audit trail. It gets the ask-list plus the `deferToBot` rules, which route the
# tools the shared user allowlist would otherwise approve back to the callback.
#
# Idempotent: existing entries and unrelated keys are kept. Run as the bot user.
set -euo pipefail
umask 077

if [ "$(id -u)" -eq 0 ]; then
  echo "run as the bot user, not root: Claude Code must be able to append to these files later" >&2
  exit 1
fi

HERE=$(cd "$(dirname "$0")/.." && pwd)
SRC="$HERE/config/claude-permissions.json"
REPOS_DIR="${REPOS_DIR:-$HOME/repos}"

envval() {
  grep -E "^(export )?$1=" "$HERE/.env" 2>/dev/null | tail -1 | cut -d= -f2- \
    | sed -e 's/\r$//' -e 's/[[:space:]]*#.*$//' -e 's/[[:space:]]*$//' -e "s/^[\"']//" -e "s/[\"']\$//" || true
}

BOT_CWD="${CLAUDE_WORKING_DIR:-$(envval CLAUDE_WORKING_DIR)}"
if [ -z "$BOT_CWD" ]; then
  echo "CLAUDE_WORKING_DIR is not set (env or .env): refusing, the bot's cwd must receive the ask-only rules" >&2
  exit 1
fi
BOT_CWD=$(realpath -m "${BOT_CWD/#\~/$HOME}")
if [ ! -d "$BOT_CWD/.git" ] || [ "$(dirname "$BOT_CWD")" != "$(realpath "$REPOS_DIR")" ] || [[ "$(basename "$BOT_CWD")" == .* ]]; then
  echo "CLAUDE_WORKING_DIR=$BOT_CWD is not a git repo directly under $REPOS_DIR; refusing to write anything" >&2
  exit 1
fi

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

target=""
trap '[ -n "$target" ] && rm -f "$target.tmp"' EXIT

matched=0
for repo in "$REPOS_DIR"/*/; do
  repo="${repo%/}"
  [ -d "$repo/.git" ] || continue
  mode="full"
  if [ "$(realpath "$repo")" = "$BOT_CWD" ]; then
    mode="ask-only"
    matched=1
  fi

  target="$repo/.claude/settings.local.json"
  mkdir -p "$repo/.claude"
  [ -f "$target" ] || echo '{}' >"$target"

  jq --slurpfile src "$SRC" --arg mode "$mode" '
    def merge(a; b): (a // []) + b | reduce .[] as $x ([]; if index($x) then . else . + [$x] end);
    $src[0] as $s
    | .permissions //= {}
    | if $mode == "ask-only" then
        .permissions.allow = ((.permissions.allow // []) - $s.allow)
        | .permissions.ask = merge(.permissions.ask; $s.ask + $s.deferToBot)
      else
        .permissions.allow = merge(.permissions.allow; $s.allow)
        | .permissions.ask = (merge(.permissions.ask; $s.ask) - $s.deferToBot)
      end
  ' "$target" >"$target.tmp"
  mv "$target.tmp" "$target"
  chmod 600 "$target"

  # Untracked and not ignored would mean the next `git add -A` commits it.
  if ! git -C "$repo" ls-files --error-unmatch .claude/settings.local.json >/dev/null 2>&1 \
     && ! git -C "$repo" check-ignore -q .claude/settings.local.json; then
    echo ".claude/settings.local.json" >>"$repo/.git/info/exclude"
  fi
  echo "synced $target ($mode)"
done

if [ "$matched" -eq 0 ]; then
  echo "no repo under $REPOS_DIR matches CLAUDE_WORKING_DIR=$BOT_CWD; nothing received the ask-only rules" >&2
  exit 1
fi
