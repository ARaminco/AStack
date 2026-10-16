import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, judgeCommand, judgeEdit } from "../bin/astack-guard.mjs";
import { contextBill } from "../context-engine/context-bill.mjs";
import { InteropEngine } from "../interop-engine/interop-engine.mjs";
import { mcpTools } from "../interop-engine/mcp-server.mjs";

/**
 * AStack 3.5.0 practices adapted from gstack (MIT, © 2026 Garry Tan): the
 * guard hook (careful / freeze) and the context bill.
 */

const repoRoot = process.cwd();
const sandboxes = [];
const sandbox = (prefix) => {
  const directory = mkdtempSync(join(tmpdir(), "astack-" + prefix + "-"));
  sandboxes.push(directory);
  return directory;
};

// ------------------------------------------------------------------ guard
const verdicts = [
  ["rm -rf /", "deny"], ["rm -rf ~", "deny"], ["sudo rm -rf /var", "deny"], ["Remove-Item -Recurse -Force C:\\", "deny"],
  ["git push --force origin main", "deny"], ["git push origin +master", "deny"],
  ["pm2 restart all", "deny"], ["pm2 kill", "deny"], ["mkfs.ext4 /dev/sdb1", "deny"],
  ["rm -rf src/old", "ask"], ["git push -f origin feature/x", "ask"], ["git reset --hard HEAD~1", "ask"], ["git checkout .", "ask"],
  ["php artisan migrate:fresh --seed", "ask"], ["mysql -e \"DROP TABLE users;\"", "ask"], ["mysql -e \"DELETE FROM sessions\"", "ask"],
  ["docker compose down -v", "ask"], ["systemctl restart nginx", "ask"], ["crontab -r", "ask"], ["npm ci && rm -r storage/app", "ask"],
  ["rm -rf node_modules", "allow"], ["rm -rf .next dist", "allow"], ["Remove-Item -Recurse -Force .next", "allow"],
  ["git push origin main", "allow"], ["pm2 restart nobatgir", "allow"], ["php artisan migrate --force", "allow"],
  ["mysql -e \"DELETE FROM sessions WHERE id=1\"", "allow"], ["docker compose down", "allow"], ["nginx -t", "allow"],
  ["grep -rn \"rm -rf\" docs", "allow"], ["echo truncate the text", "allow"], ["git status", "allow"], ["crontab -l", "allow"]
];
for (const [command, expected] of verdicts) {
  assert.equal(judgeCommand(command).decision, expected, command);
}
const frozen = { freeze: "src/payments" };
assert.equal(judgeEdit("src/payments/a.ts", frozen, "/p").decision, "allow");
assert.equal(judgeEdit("src/other.ts", frozen, "/p").decision, "deny");
assert.equal(judgeEdit("../escape.ts", frozen, "/p").decision, "deny");
assert.equal(judgeEdit(null, frozen, "/p").decision, "deny", "a freeze fails closed");
assert.equal(judgeEdit("x.ts", { corrupt: true }, "/p").decision, "deny", "an unreadable state fails closed");
assert.equal(decide({ tool_name: "Bash", tool_input: { command: "pm2 kill" } }, { state: { enabled: false } }).decision, "allow", "guard off lets everything through");
assert.equal(decide({ tool_name: "PowerShell", tool_input: { command: "Remove-Item -Recurse -Force C:\\" } }, { state: {} }).decision, "deny");
assert.equal(decide({ tool_name: "Read", tool_input: { file_path: "/etc/passwd" } }, { state: frozen }).decision, "allow", "reading is never blocked");

// The hook speaks Claude Code's PreToolUse protocol and logs without secrets.
const hook = (payload) => spawnSync(process.execPath, [join(repoRoot, "bin", "astack-guard.mjs")], { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repoRoot } });
const asked = hook({ tool_name: "Bash", tool_input: { command: "git reset --hard && mysql -ppassword123 -e 'select 1'" } });
assert.equal(JSON.parse(asked.stdout).hookSpecificOutput.permissionDecision, "ask");
assert.equal(hook({ tool_name: "Bash", tool_input: { command: "ls" } }).stdout, "", "an allowed command adds nothing");
assert.equal(hook({}).status, 0, "an empty payload never breaks the session");

// Wiring: the hook is added for Claude Code, owner hooks are kept, and
// guard.enabled: false removes it.
const project = sandbox("guard-wiring");
mkdirSync(join(project, ".claude"), { recursive: true });
writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node owner-check.mjs" }] }] } }));
const settings = (options) => JSON.parse(new InteropEngine(repoRoot, { workspaceRoot: project, projectRoot: project, ...options }).plan().find((entry) => entry.path === ".claude/settings.json").content);
const wired = settings({}).hooks.PreToolUse;
assert.ok(wired.some((group) => group.hooks.some((entry) => entry.command === "node owner-check.mjs")), "the owner's hook is kept");
assert.ok(wired.some((group) => /Bash\|PowerShell\|Edit/.test(group.matcher) && group.hooks.some((entry) => entry.command.includes("astack-guard.mjs"))), "the guard is wired");
const unwired = settings({ guard: { enabled: false } }).hooks.PreToolUse;
assert.ok(!unwired.some((group) => group.hooks.some((entry) => entry.command.includes("astack-guard.mjs"))), "guard.enabled: false removes it");
assert.equal(unwired.length, 1);

// ----------------------------------------------------------- context bill
const billRoot = sandbox("bill");
writeFileSync(join(billRoot, "AGENTS.md"), "# Contract\n" + "rule text ".repeat(400));
writeFileSync(join(billRoot, "CLAUDE.md"), "@AGENTS.md\n");
mkdirSync(join(billRoot, ".claude", "skills", "demo"), { recursive: true });
writeFileSync(join(billRoot, ".claude", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: A demo skill for the bill\n---\n" + "body ".repeat(2000));
const bill = contextBill({ projectRoot: billRoot, interop: { sessionContext: () => "brief" }, mcpTools, home: billRoot, budget: 100 });
assert.ok(bill.items.some((item) => item.name.startsWith("AGENTS.md") && item.tokens > 300));
assert.ok(bill.items.some((item) => item.name.startsWith("astack MCP server (" + mcpTools.length)));
const skillLine = bill.items.find((item) => item.name.startsWith("project skills"));
assert.ok(skillLine && skillLine.tokens < 50, "only a skill's description is always loaded, never its body");
assert.equal(bill.total, bill.items.reduce((sum, item) => sum + item.tokens, 0));
assert.equal(bill.overBudget, true, "a bill over its budget says so");

for (const directory of sandboxes) {
  rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
}
console.log("AStack practices (guard, context bill) verification passed.");
