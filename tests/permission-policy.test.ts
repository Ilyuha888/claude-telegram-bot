/**
 * Tests for the mode-1 auto-approval policy in src/security.ts:
 * only remote writes and privilege escalation ask, everything local runs.
 *
 * Run with: bun test tests/permission-policy.test.ts
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { checkAutoApprove, isClaudeAiReadTool, isRemoteWriteCommand } from "../src/security";
import { ALLOWED_PATHS } from "../src/config";

describe("isRemoteWriteCommand", () => {
  const asks = [
    "ssh host uptime",
    "scp file.txt host:/tmp/",
    "rsync -av notes/ host:backup/",
    "sudo apt install jq",
    "sendmail user@example.com < msg.txt",
    "gh pr create --fill",
    "gh pr comment 12 --body ok",
    "gh pr merge 12 --squash",
    "gh issue create --title x",
    "gh api -X PATCH repos/o/r --field name=x",
    "gh api repos/o/r/issues -f title=x",
    "curl -X POST https://hooks.slack.com/services/x -d '{}'",
    "curl -d @payload.json https://example.com/api",
    "curl --json '{\"a\":1}' https://example.com",
    "wget --post-data 'a=1' https://example.com",
    "cd /tmp && ssh host ls",
    "echo $(ssh host hostname)",
    "timeout 25 gh pr create --fill",
    "TZ=UTC ssh host date",
    "bash -lc 'ssh host ls'",
    "git status || sudo reboot",
    "curl \"https://x/$(date +%s)/api\" -X POST -d '{}'",
    "gh api \"repos/$(gh repo view -q .nameWithOwner)/issues\" -X POST -f title=x",
    "gh api --method=POST repos/o/r/issues",
    "curl -sX POST https://example.com",
    "curl -sSd '{}' https://example.com",
    "curl -d@payload.json https://example.com",
    "curl -X \"POST\" https://example.com",
    "curl --data-binary @f https://example.com",
    "curl --form-string a=b https://example.com",
    "wget --method=POST https://example.com",
    "wget --body-data 'a=1' https://example.com",
    "\\ssh host ls",
    "\"ssh\" host ls",
    "/usr/bin/ssh host ls",
    "$(which ssh) host ls",
    "su -c 'ls' root",
    "msmtp user@example.com < msg",
    "env -i ssh host ls",
    "timeout -k 5 25 ssh host ls",
    "FOO=\"a b\" ssh host ls",
    "echo host | xargs -n 1 ssh",
    "echo host | xargs -I {} ssh {} uptime",
    "sleep 1 & ssh host reboot",
    "{ ssh host; }",
    "for h in a b; do ssh $h reboot; done",
    "if ssh host true; then echo ok; fi",
    "gh workflow run deploy.yml",
    "gh run rerun 123",
    "gh secret set TOKEN",
    "gh pr reopen 12",
    "gh gist create notes.md",
    "gh repo archive o/r",
    "curl https://example.com \\\n  -X POST \\\n  -d '{}'",
    "gh api repos/o/r/issues \\\n  -X POST -f title=x",
    "curl -H 'Content-Type: application/json; charset=utf-8' -X POST -d '{}' https://example.com",
    "curl \"https://api.example.com/x?a=1&b=2\" -X POST",
    "curl -s -o /dev/null -w \"%{http_code}\" -X POST https://example.com",
    "curl -d'{\"a\":1}' https://example.com",
    "curl -dfoo=bar https://example.com",
    "echo host | xargs -n1 ssh",
    "timeout -s KILL 25 ssh host ls",
    "nice -10 ssh host ls",
    "sshpass -p x ssh host ls",
    "git send-email --to a@b HEAD~1",
    "bash -c 'cd /srv && ssh host restart'",
    "eval \"ssh host ls\"",
    "gh api graphql -f query='mutation { addStar(input:{starrableId:\"x\"}) { clientMutationId } }'",
    "gh release create v1.0 --notes x",
  ];
  for (const cmd of asks) {
    it(`asks for: ${cmd}`, () => {
      expect(isRemoteWriteCommand(cmd)).toBe(true);
    });
  }

  const runs = [
    "",
    "cd /home/user/repos/vault && git log --oneline | tail -5",
    "git push",
    "git push origin main",
    "git commit -m 'update notes'",
    "git add -A && git commit -q -m x && git push",
    "rm -rf build",
    "curl -s https://example.com/page",
    "curl -sI --max-time 5 https://example.com",
    "gh api repos/joomcode/api --jq .full_name",
    "gh pr view 12",
    "gh pr list --state open",
    "timeout 25 gh api repos/o/r",
    "python3 - <<'EOF'\nimport json\nprint(1)\nEOF",
    "grep -rn ssh notes/ | head",
    "echo \"mail merge\" > notes/x.md",
    "export PATH=$HOME/.local/go/bin:$PATH && go test ./...",
    "bun -e \"console.log('hi')\"",
    "for f in *.md; do echo $f; done",
    "ssh-keygen -t ed25519 -f /tmp/k -N ''",
    "GIT_SSH_COMMAND=ssh git push",
    "command -v ssh",
    "gh release list",
    "gh release view v1.0",
    "gh run view 123 --log",
    "gh pr checkout 12",
    "gh auth status",
    "gh search issues panicsafe",
    "gh api --paginate repos/o/r/issues --jq '.[].title'",
    "curl -fsSL https://example.com -o /tmp/f",
    "curl -H 'Accept: application/json' https://example.com",
    "wget -qO- https://example.com",
    "curl -f https://example.com",
    "curl -sSf https://example.com -o /tmp/x",
    "curl -D - https://example.com",
    "gh -R o/r pr view 1",
    "gh --repo o/r issue list",
    "git commit -m \"fix (ssh config)\"",
    "git commit -m \"add (mail templates)\"",
    "echo \"(sudo needed)\"",
    "grep -n 'rsync' notes/*.md",
    "echo ${mail}",
    "eval \"$(ssh-agent -s)\"",
    "gh api -X GET search/issues -f q='repo:o/r is:open'",
    "gh api graphql -f query='query { viewer { login } }'",
    "gh release download v1.0",
    "curl -sfL https://example.com | sh",
    "curl -sS --retry 3 https://example.com",
  ];
  for (const cmd of runs) {
    it(`runs without asking: ${cmd.replace(/\n/g, " ")}`, () => {
      expect(isRemoteWriteCommand(cmd)).toBe(false);
    });
  }
});

describe("isRemoteWriteCommand heredoc bodies", () => {
  it("treats a heredoc body as data", () => {
    expect(isRemoteWriteCommand("cat <<'EOF' > note.md\nssh keys rotated today\nEOF")).toBe(false);
  });
  it("still sees a remote write after a body with an apostrophe", () => {
    expect(isRemoteWriteCommand("cat > x.md <<'EOF'\nDon't panic\nEOF\ngit add x.md && gh pr create --fill")).toBe(true);
  });
  it("still sees the rest of the line after an unquoted delimiter", () => {
    expect(isRemoteWriteCommand("python3 - <<EOF\nprint('hi')\nEOF\nssh host ls")).toBe(true);
  });
});

describe("isClaudeAiReadTool", () => {
  const reads = [
    "mcp__claude_ai_Slack__slack_read_channel",
    "mcp__claude_ai_Slack__slack_search_users",
    "mcp__claude_ai_Notion__notion-fetch",
    "mcp__claude_ai_Notion__notion-query-data-sources",
    "mcp__claude_ai_Notion__notion-ai-search",
    "mcp__claude_ai_Notion__notion-list-recent-pages",
    "mcp__claude_ai_Gmail__search_threads",
    "mcp__claude_ai_Gmail__get_message",
    "mcp__claude_ai_Google_Calendar__list_events",
    "mcp__claude_ai_Google_Calendar__suggest_time",
    "mcp__claude_ai_Google_Drive__read_file_content",
    "mcp__claude_ai_Google_Drive__download_file_content",
    "mcp__claude_ai_Atlassian__getJiraIssue",
    "mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql",
    "mcp__claude_ai_Atlassian__atlassianUserInfo",
    "mcp__claude_ai_JoomPulse_MCP__query_cubejs_joompro",
    "mcp__claude_ai_Notion__notion-check-mcp-next-steps",
    "mcp__claude_ai_Amplitude__render_amplitude_chart",
    "mcp__claude_ai_Amplitude__export_tracking_plan",
    "mcp__claude_ai_Atlassian__lookupJiraAccountId",
  ];
  for (const tool of reads) {
    it(`read: ${tool}`, () => {
      expect(isClaudeAiReadTool(tool)).toBe(true);
    });
  }

  const writes = [
    "mcp__claude_ai_Slack__slack_send_message_draft",
    "mcp__claude_ai_Slack__slack_schedule_message",
    "mcp__claude_ai_Slack__slack_create_canvas",
    "mcp__claude_ai_Notion__notion-create-pages",
    "mcp__claude_ai_Notion__notion-update-page",
    "mcp__claude_ai_Notion__notion-move-pages",
    "mcp__claude_ai_Gmail__send_message",
    "mcp__claude_ai_Gmail__reply",
    "mcp__claude_ai_Gmail__forward",
    "mcp__claude_ai_Gmail__trash_thread",
    "mcp__claude_ai_Google_Calendar__update_event",
    "mcp__claude_ai_Google_Drive__share_file",
    "mcp__claude_ai_Atlassian__createJiraIssue",
    "mcp__claude_ai_Atlassian__transitionJiraIssue",
    "mcp__claude_ai_Atlassian__addCommentToJiraIssue",
    "mcp__claude_ai_Amplitude__foo_bar",
    "mcp__claude_ai_Amplitude__manage_amp_events",
    "mcp__claude_ai_Gmail__create_draft",
    "mcp__claude_ai_Google_Calendar__respond_to_event",
    "mcp__claude_ai_Atlassian__editJiraIssue",
    // Not a connector at all: the caller decides, not this classifier.
    "mcp__send-file__send_file",
    "Bash",
  ];
  for (const tool of writes) {
    it(`not a read: ${tool}`, () => {
      expect(isClaudeAiReadTool(tool)).toBe(false);
    });
  }
});

describe("config/claude-permissions.json ask rules are asks in code too (one direction)", () => {
  const cfg = JSON.parse(readFileSync(new URL("../config/claude-permissions.json", import.meta.url), "utf8")) as {
    ask: string[];
  };
  for (const rule of cfg.ask.filter((r) => r.startsWith("mcp__claude_ai_"))) {
    it(`${rule} is not a read`, () => {
      expect(isClaudeAiReadTool(rule)).toBe(false);
    });
  }
  for (const rule of cfg.ask.filter((r) => r.startsWith("Bash("))) {
    const cmd = rule.replace(/^Bash\((.*?)(?::\*)?\)$/, "$1") + " x";
    it(`${rule} asks in code too`, () => {
      expect(isRemoteWriteCommand(cmd)).toBe(true);
    });
  }
});

describe("checkAutoApprove", () => {
  const dir = ALLOWED_PATHS[0] ?? "/tmp";
  const cases: [string, Record<string, unknown>, boolean][] = [
    ["Write", { file_path: `${dir}/note.md` }, true],
    ["Edit", { file_path: `${dir}/sub/CLAUDE.md` }, false],
    ["Write", { file_path: `${dir}/.claude/settings.local.json` }, false],
    ["Write", { file_path: `${dir}/.claude/skills/curator/SKILL.md` }, false],
    ["Write", { file_path: `${dir}/.mcp.json` }, false],
    ["Edit", { file_path: `${dir}/CLAUDE.local.md` }, false],
    ["Bash", { command: "rm -rf /" }, false],
    ["Agent", { prompt: "x" }, true],
    ["Read", { file_path: `${dir}/CLAUDE.md` }, true],
    ["Write", { file_path: "/etc/hosts" }, false],
    ["Read", {}, false],
    ["Bash", { command: "cd x && git push" }, true],
    ["Bash", { command: "ssh host ls" }, false],
    ["Bash", {}, false],
    ["WebFetch", { url: "https://example.com" }, true],
    ["Skill", { skill: "curator" }, true],
    ["mcp__send-file__send_file", {}, true],
    ["mcp__plugin_context7_context7__query-docs", {}, true],
    ["mcp__claude_ai_Slack__slack_read_channel", {}, true],
    ["mcp__claude_ai_Gmail__send_message", {}, false],
    ["Workflow", {}, false],
  ];
  for (const [tool, input, expected] of cases) {
    it(`${tool} ${JSON.stringify(input)} -> ${expected ? "run" : "ask"}`, () => {
      expect(checkAutoApprove(tool, input)).toBe(expected);
    });
  }
});
