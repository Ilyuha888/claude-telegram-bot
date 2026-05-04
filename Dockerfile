FROM oven/bun:1.3-debian

# System dependencies:
#   poppler-utils — pdftotext for PDF extraction
#   tzdata       — timezone support for the scheduler
#   ca-certificates, curl — needed by Node.js install script
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    tzdata \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js (required to install the Claude Code CLI via npm)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI — the bot's agent runtime
# Authenticate after container startup via ANTHROPIC_API_KEY env var
# or by bind-mounting your ~/.claude/ directory (see docker-compose.yml)
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source
COPY . .

# Runtime mounts (set in docker-compose.yml):
#   /data/bot-data  — schedules.json, notifications.json (sessions.json excluded)
#   /data/vault     — your ctb-vault clone (or personal vault)
#   /root/.claude   — Claude CLI auth + user settings + skills

ENV BOT_DATA_DIR=/data/bot-data
ENV CTB_VAULT_DIR=/data/vault

CMD ["bun", "run", "src/index.ts"]
