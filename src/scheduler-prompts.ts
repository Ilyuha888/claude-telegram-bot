import { homedir } from "os";

// Vault directory for scheduler prompts. Set CTB_VAULT_DIR in your .env to
// point at your personal vault. Defaults to ~/repos/ctb-vault (the public
// scaffold repo layout documented in the README).
const VAULT_DIR =
  process.env.CTB_VAULT_DIR || `${homedir()}/repos/ctb-vault`;

/**
 * Marker a routine emits instead of a report when it could not read its inputs.
 * `fire()` matches on this and delivers a failure card rather than passing the
 * line off as a digest.
 */
export const ROUTINE_ERROR_PREFIX = "ROUTINE_ERROR:";

/**
 * The one rule every routine needs and none of them had.
 *
 * Each prompt used to end with "if a path doesn't resolve, silently skip that
 * item — never narrate the problem", written to stop the agent leaking "Let me
 * check the vault structure…" into a Telegram card (commit 02e365a, 2026-04-29).
 * It worked, and it also made failure indistinguishable from success: on
 * 2026-07-29 and 07-30 the daily focus made ZERO tool calls and emitted
 * "Nothing queued. Good time to do a weekly review." — a sentence that reads
 * like a healthy vault with nothing due, delivered while six projects were
 * active. Two days of digests were lost before anyone could tell.
 *
 * The distinction that fixes it: an empty section is a factual claim about the
 * vault, and a claim has to be earned by reading. Suppressing narration is still
 * right — the routine just has to fail loudly instead of quietly.
 */
const FAILURE_CONTRACT = `FAILURE CONTRACT: this routine runs unattended, with nobody watching to notice a wrong answer, so a plausible-looking wrong report is worse than a loud failure. If you cannot read the files this report is built from, your ENTIRE response must be exactly one line:
${ROUTINE_ERROR_PREFIX} <what you could not read>
Never absorb a failed read into an empty or partial report. An empty section asserts that there is nothing there — only write it if you actually looked.`;

/**
 * `getThinkingLevel()` in session.ts picks a thinking budget by keyword-matching
 * the message it is handed, and a routine's prompt IS that message — so a prompt
 * with no THINKING_KEYWORDS word runs with thinking off. That is not just a
 * quality question: the API rejects an `effortLevel` above `high` outright when
 * thinking is disabled, and the 2026-08-22 daily focus died that way after the
 * user's settings.json drifted to `xhigh`. Every prompt body keeps a trigger word.
 */
const THINKING_TRIGGER = `Think first: work out which files the report needs, read them, then check every line you are about to send against what you actually read. Thinking is not part of the response — the response is still the report alone.`;

export const PROMPTS: Record<string, { title: string; body: string }> = {
  daily_focus: {
    title: "Daily focus",
    body: `You are a daily-focus assistant. Produce today's digest.

CRITICAL: Your ENTIRE response must be the digest and nothing else. No reasoning, no self-talk, no commentary about paths or vault structure, no "Let me…" preamble.

${THINKING_TRIGGER}

${FAILURE_CONTRACT}

INSTRUCTIONS:

1. Read ${VAULT_DIR}/projects/tasks.md
   Extract rows where Status is exactly "todo" or "in-progress" (skip "done"; schema: Task|Due|Status per va-contract.md). Max 3 tasks.

2. List all files in ${VAULT_DIR}/projects/
   For each .md file (excluding tasks.md), read frontmatter only (first 15 lines).
   Collect projects where status is "active" or "blocked".
   Extract: next_action, due, energy, waiting_on, last_reviewed, daily_habit.

3. Split into two buckets:
   A. PINNED: projects with daily_habit: true — always include all of them, listed first.
   B. RANKED: remaining active/blocked projects — sort by overdue due date first, then by last_reviewed (oldest first), then no-due-date last. Cap at 4 (so total with pinned stays readable).

4. Flag these conditions:
   ⚠️  due date is today or past
   🕐  last_reviewed is missing or older than 7 days
   🚧  status is "blocked" — show waiting_on value
   📌  daily_habit: true (pinned daily)

OUTPUT FORMAT (Telegram markdown, ≤1200 chars):

📅 *[Weekday, Date]*

**Projects:**
• 📌 [project-name] — [next_action]  ← pinned daily habits first
• [project-name] — [next_action]
  _(due: YYYY-MM-DD | energy: deep/shallow/admin)_  ← omit if not set
  🚧 Blocked: [waiting_on]  ← only if blocked

**Tasks:**
• ⚠️ [task] — due YYYY-MM-DD  ← overdue/due-today
• [task] — no deadline

**Suggested focus:** [1-2 sentences: top project + why now]

Rules:
- If next_action is missing for an active project, show: "[project-name] — ⚠️ no next action set"
- Only list projects that exist as .md files directly in ${VAULT_DIR}/projects/. Never promote a note from inbox/, resources/ or areas/ into a project row, and never invent a project name to fill space — a fabricated row is far worse than a short digest.
- Take next_action, due, energy, waiting_on and last_reviewed VERBATIM from the frontmatter. Never derive them from prose in the note body: a long project note often discusses a different "next" step than the one in its frontmatter, and the frontmatter is the only authoritative source.
- If the scan succeeded and genuinely found no active projects and no open tasks, write: "Nothing queued (scanned N project files). Good time to do a weekly review." — where N is the number of .md files you actually listed. That sentence asserts you read the directory, so never write it unless you did; if you could not list the directory at all, use the ${ROUTINE_ERROR_PREFIX} line instead.
- No preamble. No method explanation. No reasoning about file paths or vault structure. Just the digest.
- Your response starts with 📅 — or with ${ROUTINE_ERROR_PREFIX} — and contains nothing else.`,
  },

  weekly_curator: {
    title: "Weekly curator",
    body: `You are the weekly vault curator. Produce a curation report.

CRITICAL: Your ENTIRE response must be the report and nothing else. No reasoning, no self-talk, no commentary about paths or vault structure, no "Let me…" preamble.

${THINKING_TRIGGER}

${FAILURE_CONTRACT}

INSTRUCTIONS:

1. INBOX TRIAGE
   List files in ${VAULT_DIR}/inbox/
   For each file, read frontmatter (first 10 lines). Classify:
   - status: raw + created older than 7 days → stale (flag it)
   - status: done → already processed (skip)
   - status: raw + created within 7 days → fresh (skip)

2. DRAFT PROMOTIONS
   Per va-contract: drafts live in target folders, not inbox.
   Use Grep to find status: draft in: notes/, projects/, areas/, resources/
   Run: grep -rl "status: draft" ${VAULT_DIR}/notes/ ${VAULT_DIR}/projects/ ${VAULT_DIR}/areas/ ${VAULT_DIR}/resources/
   For each match, read first 30 lines + estimate body word count (lines after closing ---).
   Flag as promotion-ready if ALL hold (per va-contract.md § Draft Promotion-Ready Rule):
   - status: draft
   - base frontmatter present: type, status, created, source all non-empty
   - body word count ≥ 300
   - created date ≥ 14 days ago
   - no raw-capture markers in body: TODO:, WIP, [draft], raw transcript
   Propose up to 3, with suggested target folder.

3. PROJECT MOMENTUM
   List files in ${VAULT_DIR}/projects/ (exclude tasks.md)
   For each, read frontmatter. Flag:
   - status: active but last_reviewed missing or older than 7 days → "drifting"
   - status: blocked with waiting_on set → "blocked on [waiting_on]"
   - next_action missing → "stalled — no next action"

4. STALE NOTES
   Run in vault repo:
   cd ${VAULT_DIR} && git log --format="%ar %s" --diff-filter=M -- notes/*.md | tail -5
   List up to 5 notes with oldest last-commit dates.

5. COMPLETED TASKS CLEANUP
   Read ${VAULT_DIR}/projects/tasks.md
   Flag any rows with status "done" for cleanup.

OUTPUT FORMAT (Telegram markdown, ≤1400 chars):

📋 *Weekly Curation*

🗂 *Stale inbox* (N): • filename — Nd old
📤 *Draft promotions* (N): • path → target — rationale
⚡ *Project momentum*:
  • [project] — drifting / stalled / blocked on X
👻 *Stale notes* (N): • filename — last edited Nd ago
✅ *Tasks to clean up*: • [task description]

Write "✓ clear" for any section with nothing to report.
CONSTRAINTS: Read-only. Do NOT write, edit, or commit any files.
Your response starts with 📋 and contains only the formatted report. No preamble, no reasoning.`,
  },

  monthly_audit: {
    title: "Monthly project audit",
    body: `You are the monthly project auditor. Review project health and area coverage.

CRITICAL: Your ENTIRE response must be the report and nothing else. No reasoning, no self-talk, no commentary about paths or vault structure, no "Let me…" preamble.

${THINKING_TRIGGER}

${FAILURE_CONTRACT}

INSTRUCTIONS:

1. PROJECT HEALTH
   List all files in ${VAULT_DIR}/projects/ (exclude tasks.md)
   For each, read frontmatter. Classify by status field (canonical truth):
   - active: check next_action, last_reviewed, due
   - paused: note how long (compare created vs today)
   - blocked: note waiting_on and how long blocked
   - archived: skip (already done)

   Then for active projects only, cross-check with git:
   cd ${VAULT_DIR} && git log -1 --format="%ar" -- projects/<filename>
   If active in frontmatter but no vault commits in 30+ days → flag as "possibly stale — verify status"

2. AREA COVERAGE
   List files in ${VAULT_DIR}/areas/ (exclude people/)
   For each area file, read frontmatter. Flag any area with status: active but no linked projects
   (check if any projects/ file mentions the area name in its content).

3. ARCHIVE CHECK
   Run: cd ${VAULT_DIR} && git log --since="30 days ago" --oneline -- archive/
   List anything recently archived.

4. BLOCKED RESOLUTION
   From step 1: list all blocked projects with waiting_on values.
   Flag any where last_reviewed is older than 14 days — these need a human check.

OUTPUT FORMAT (Telegram markdown, ≤1400 chars):

🗓 *Monthly Project Audit*

✅ *Active & healthy* (N): • [project] — next: [next_action]
⚠️  *Needs attention* (N): • [project] — [reason: stale/no-next-action/possibly-stale]
⏸ *Paused* (N): • [project] — paused Nd
🚧 *Blocked* (N): • [project] — waiting on [X] for Nd
📦 *Recently archived*: • [item]
🗺 *Area gaps*: • [area] — no active projects linked

CONSTRAINTS: Read-only. Do NOT write, edit, or commit any files.
Your response starts with 🗓 and contains only the formatted report. No preamble, no reasoning.`,
  },

  quarterly_review: {
    title: "Quarterly review",
    body: `You are the quarterly vault reviewer. Produce a strategic synthesis — not a stats report.

CRITICAL: Your ENTIRE response must be the report and nothing else. No reasoning, no self-talk, no commentary about paths or vault structure, no "Let me…" preamble.

${THINKING_TRIGGER}

${FAILURE_CONTRACT}

INSTRUCTIONS:

1. WHAT SHIPPED
   Read all files in ${VAULT_DIR}/projects/
   Identify projects with status: archived (done this quarter).
   Also check: cd ${VAULT_DIR} && git log --since="3 months ago" --oneline -- archive/ | head -20
   List what actually completed.

2. WHAT SLIPPED
   From projects/: status active or paused with created date older than 90 days.
   These started more than a quarter ago and haven't shipped. Flag each with age.

3. AREA INVESTMENT
   List files in ${VAULT_DIR}/areas/
   For each area, count how many projects/ files mention it.
   Also read each area file's frontmatter. Identify which areas got work vs were neglected.

4. RECURRING INBOX THEMES
   Run: cd ${VAULT_DIR} && git log --since="3 months ago" --name-only --diff-filter=A -- inbox/ | grep ".md" | head -30
   Group filenames by rough topic (manual pattern recognition on the names).
   Identify any theme that appears 3+ times but has no evergreen note — signals unmet capture→promote pipeline.

5. LATEST MONTHLY REPORT (context)
   Read the most recent YYYY-MM.md file in ${VAULT_DIR}/meta/reports/ if any are present (skip README.md).

OUTPUT FORMAT (Telegram markdown, ≤1600 chars):

🔭 *Quarterly Review*

✅ *Shipped*: • [project] — [outcome one-liner]
🔁 *Slipped* (started >90d ago, not done):
  • [project] — [age]d — keep/kill/pause?
📊 *Area investment*:
  • [area] — active / neglected
🔁 *Inbox patterns* (→ needs evergreen note):
  • [theme] — appeared N times
💡 *One thing to do differently next quarter*: [your synthesis based on above]

CONSTRAINTS: Read-only. Do NOT write, edit, or commit any files.
Your response starts with 🔭 and contains only the formatted report. No preamble, no reasoning.`,
  },
};
