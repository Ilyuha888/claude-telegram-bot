#!/usr/bin/env bash

export PATH=/home/assistant/.local/bin:/home/assistant/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export BUN_INSTALL=/home/assistant/.bun
export HOME=/home/assistant

cd /home/assistant/repos/my_obsidian_knowledge_base

# Pull latest vault state before starting
git pull --rebase --autostash 2>&1 | tail -1

# Switch to bot repo — governance (.haft/, AGENTS.md) and source live here (dec-20260422-004)
cd /home/assistant/repos/claude-telegram-bot

# Auto-enable Remote Control after Claude finishes starting up
(sleep 20 && tmux send-keys -t assistant "/remote-control" Enter && sleep 4 && tmux send-keys -t assistant "1" Enter) &

# Run Claude
/home/assistant/.local/bin/claude \
  --remote-control-session-name-prefix "KB-Assistant" \
  --permission-mode default \
  --name "KB Assistant"
