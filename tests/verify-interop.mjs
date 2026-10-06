import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryEngine } from "../memory-engine/memory-engine.mjs";
import { InteropEngine, claudeProjectSlug, detectRuntime } from "../interop-engine/interop-engine.mjs";
import { createMcpHandler, mcpTools, runtimeFromClient } from "../interop-engine/mcp-server.mjs";
import { RuntimeRegistry } from "../runtime-providers/agent-runtime.mjs";
import { ClaudeCodeRuntime } from "../runtime-providers/adapters/claude-code.mjs";
import { CodexRuntime } from "../runtime-providers/adapters/codex.mjs";
import { ModelRouter } from "../runtime-providers/model-router.mjs";
import { migrations } from "../upgrade-engine/migrations.mjs";

const repoRoot = process.cwd();
const sandboxes = [];
function sandbox(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  sandboxes.push(path);
  return path;
}
function cleanup() {
  for (const path of sandboxes) {
    rmSync(path, { recursive: true, force: true });
  }
}
process.on("exit", cleanup);

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 9, 5, 9, 0, tick++));
const write = (path, text) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
};
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// ---------------------------------------------------------------- the repository itself

const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
const claudeMd = readFileSync(join(repoRoot, "CLAUDE.md"), "utf8");
assert.match(agents, /Shared Brain/, "AGENTS.md is the shared contract");
assert.ok(claudeMd.split(/\r?\n/).some((line) => line.trim() === "@AGENTS.md"), "CLAUDE.md imports the shared contract");
assert.ok(claudeMd.includes("Claude Code"));
const repoInterop = new InteropEngine(repoRoot, { home: sandbox("astack-home-") });
assert.ok(repoInterop.status().parity, "the repository ships Claude Code and Codex in parity: run astack interop sync");

// ---------------------------------------------------------------- sync merges into owner files

const workspace = sandbox("astack-interop-");
const home = sandbox("astack-home-");
assert.throws(() => new InteropEngine(workspace, { home }).sync(), /AGENTS\.md is missing/);

write(join(workspace, "AGENTS.md"), "# Contract\n\nShared rules.\n");
write(join(workspace, "CLAUDE.md"), "# Owner guide\n\nOwner rule that must survive.\n");
write(join(workspace, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "other" } } }));
write(
  join(workspace, ".claude", "settings.json"),
  JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo owner" }] }] } })
);
write(join(workspace, ".codex", "config.toml"), "model = \"owner-model\"\n");

const memory = new MemoryEngine(workspace, { clock });
const interop = new InteropEngine(workspace, { memory, clock, home, env: {} });
const first = interop.sync();
assert.deepEqual(
  first.map((entry) => entry.path + ":" + entry.action),
  ["CLAUDE.md:update", ".mcp.json:update", ".claude/settings.json:update", ".codex/config.toml:update", ".codex/hooks.json:create"]
);
const claudeAfter = readFileSync(join(workspace, "CLAUDE.md"), "utf8");
assert.match(claudeAfter, /Owner rule that must survive/);
assert.match(claudeAfter, /^@AGENTS\.md$/m);
const mcp = readJson(join(workspace, ".mcp.json"));
assert.equal(mcp.mcpServers.other.command, "other", "owner MCP servers are kept");
assert.deepEqual(mcp.mcpServers.astack.args, ["bin/astack.mjs", "mcp", "serve"]);
const settings = readJson(join(workspace, ".claude", "settings.json"));
assert.deepEqual(settings.permissions.allow, ["Bash(ls)", "mcp__astack"], "owner permissions are kept and the astack tools allowed");
assert.equal(settings.hooks.SessionStart.length, 2, "owner hooks are kept beside the astack hook");
assert.ok(settings.enabledMcpjsonServers.includes("astack"));
const codexConfig = readFileSync(join(workspace, ".codex", "config.toml"), "utf8");
assert.match(codexConfig, /model = "owner-model"/);
assert.match(codexConfig, /\[mcp_servers\.astack\]/);
assert.match(codexConfig, /default_tools_approval_mode = "approve"/, "Codex runs astack tools without a prompt, like Claude Code");
const codexHooks = readJson(join(workspace, ".codex", "hooks.json"));
assert.match(codexHooks.hooks.SessionStart[0].hooks[0].command, /interop hook session-start --runtime codex/);

const second = interop.sync();
assert.ok(second.every((entry) => entry.action === "ok"), "sync is idempotent");
assert.equal((readFileSync(join(workspace, ".codex", "config.toml"), "utf8").match(/\[mcp_servers\.astack\]/g) ?? []).length, 1);
assert.equal(readJson(join(workspace, ".claude", "settings.json")).hooks.SessionStart.length, 2, "hooks are never duplicated");

const status = interop.status();
assert.ok(status.parity);
assert.equal(status.contract.hash, new InteropEngine(workspace, { home }).contract().hash, "both runtimes resolve to one contract hash");

// A malformed owner file is reported and left untouched.
const broken = sandbox("astack-broken-");
write(join(broken, "AGENTS.md"), "# Contract\n");
write(join(broken, ".mcp.json"), "{ not json");
const brokenResult = new InteropEngine(broken, { home }).sync();
assert.equal(brokenResult.find((entry) => entry.path === ".mcp.json").action, "invalid");
assert.equal(readFileSync(join(broken, ".mcp.json"), "utf8"), "{ not json");

// ---------------------------------------------------------------- journal, handoffs and session context

assert.throws(() => interop.handoff({ runtime: "codex", summary: " " }), /needs a summary/);
const handoff = interop.handoff({
  runtime: "codex",
  summary: "Refactored the billing module",
  done: "split invoice.mjs",
  findings: ["rounding bug in VAT", "token=abcd1234secret leaked in a fixture"],
  openQuestions: ["keep the legacy export?"],
  next: "run the billing tests"
});
assert.ok(handoff.memoryId, "a handoff is also episodic memory");
assert.ok(!JSON.stringify(handoff).includes("abcd1234secret"), "handoffs are redacted");
const recalled = memory.recall({ query: "billing refactor" });
assert.ok(recalled.some((hit) => hit.id === handoff.memoryId), "the other runtime can recall the handoff");
assert.equal(recalled.find((hit) => hit.id === handoff.memoryId).source, "codex");

memory.remember("preference", { title: "Owner prefers Persian status reports", source: "claude-code" });
const start = interop.sessionStart({ runtime: "claude-code", payload: { session_id: "s-1", source: "startup" } });
assert.equal(start.output.hookSpecificOutput.hookEventName, "SessionStart");
const context = start.output.hookSpecificOutput.additionalContext;
assert.match(context, /codex handoff: Refactored the billing module → next: run the billing tests/, "Claude Code sees Codex's work");
assert.match(context, /Owner prefers Persian status reports/, "and the shared memory");
assert.match(context, new RegExp("AGENTS\\.md#" + status.contract.hash));
const codexContext = interop.sessionContext({ runtime: "codex" });
assert.equal(
  codexContext.replace(/^Runtime: .*$/m, ""),
  context.replace(/^Runtime: .*$/m, ""),
  "both runtimes start from the same state"
);
interop.sessionEnd({ runtime: "claude-code", payload: { session_id: "s-1", reason: "exit" } });
const journal = interop.journal({ limit: 10 });
assert.deepEqual(journal.map((entry) => entry.kind), ["session-end", "session-start", "handoff"]);
assert.equal(interop.status().lastSeen.codex.kind, "handoff");

// ---------------------------------------------------------------- Claude Code auto-memory import

const claudeMemory = join(home, ".claude", "projects", claudeProjectSlug(workspace), "memory");
write(join(claudeMemory, "MEMORY.md"), "- [Index](owner.md)\n");
write(
  join(claudeMemory, "owner.md"),
  "---\nname: owner-role\ndescription: Owner is a lawyer who runs AStack for case work\nmetadata:\n  type: user\n---\n\nPrefers Persian answers.\n"
);
write(join(claudeMemory, "tests.md"), "---\nname: run-tests\ndescription: Always run npm test before committing\ntype: feedback\n---\n\nWhy: CI is slow.\n");
const firstImport = interop.importClaudeMemory();
assert.equal(firstImport.imported, 2, "MEMORY.md is an index, not a fact");
const owner = memory.recall({ query: "lawyer case work" })[0];
assert.equal(owner.facet, "identity");
assert.equal(owner.source, "claude-code-memory");
assert.equal(memory.recall({ query: "npm test before committing" })[0].facet, "preference");
assert.equal(interop.importClaudeMemory().unchanged, 2, "an unchanged file is not imported twice");
write(
  join(claudeMemory, "owner.md"),
  "---\nname: owner-role\ndescription: Owner is a lawyer and accountant who runs AStack\nmetadata:\n  type: user\n---\n\nPrefers Persian answers.\n"
);
const reimport = interop.importClaudeMemory();
assert.equal(reimport.updated, 1, "a changed file supersedes its record");
assert.ok(memory.facets.get(owner.id).supersededBy, "history is kept, not overwritten");
assert.equal(new InteropEngine(sandbox("astack-other-"), { memory, home }).importClaudeMemory().directory, null);

// ---------------------------------------------------------------- Codex trust

const codexHome = sandbox("astack-codex-home-");
write(join(codexHome, ".codex", "config.toml"), "model = \"x\"\n\n[projects.'/elsewhere']\ntrust_level = \"trusted\"\n");
const trusting = new InteropEngine(workspace, { home: codexHome });
assert.equal(trusting.codexTrust().trusted, false);
const trusted = trusting.trustCodex();
assert.ok(trusted.changed && existsSync(trusted.backup));
assert.ok(trusting.codexTrust().trusted);
assert.equal(trusting.trustCodex().changed, false, "trust is added once");
assert.match(readFileSync(join(codexHome, ".codex", "config.toml"), "utf8"), /model = "x"/);

// ---------------------------------------------------------------- runtime detection

assert.equal(detectRuntime({ CLAUDECODE: "1" }), "claude-code");
assert.equal(detectRuntime({ CODEX_SANDBOX: "seatbelt" }), "codex");
assert.equal(detectRuntime({ ASTACK_RUNTIME: "codex", CLAUDECODE: "1" }), "codex");
assert.equal(detectRuntime({}), "unknown");

// ---------------------------------------------------------------- MCP server

assert.equal(runtimeFromClient({ name: "claude-code" }), "claude-code");
assert.equal(runtimeFromClient({ name: "codex-mcp-client" }), "codex");
const calls = [];
const handle = createMcpHandler({ version: "test", run: async (args) => (calls.push(args), { ok: true, output: "done" }) });
const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "codex-mcp-client" } } });
assert.equal(init.result.serverInfo.name, "astack");
assert.equal(init.result.protocolVersion, "2025-06-18");
assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
const listed = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
assert.equal(listed.result.tools.length, mcpTools.length);
assert.ok(listed.result.tools.every((tool) => tool.name.startsWith("astack_") && tool.inputSchema.type === "object"));
const remembered = await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "astack_memory_remember", arguments: { title: "x; rm -rf /" } } });
assert.equal(remembered.result.isError, false);
assert.deepEqual(calls.at(-1), ["memory", "remember", "x; rm -rf /", "--source", "codex"], "arguments are a vector, provenance is the client");
const missing = await handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "astack_memory_search", arguments: {} } });
assert.equal(missing.result.isError, true);
const unknown = await handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope" } });
assert.equal(unknown.error.code, -32602);
assert.equal((await handle({ jsonrpc: "2.0", id: 6, method: "resources/list" })).error.code, -32601);
await handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "astack_handoff_write", arguments: { summary: "s", findings: ["a", "b"], next: "n" } } });
assert.deepEqual(calls.at(-1), ["interop", "handoff", "s", "--runtime", "codex", "--findings", "a;b", "--next", "n"]);

// The real server over stdio, the way Claude Code and Codex launch it.
const transcript = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(repoRoot, "bin", "astack.mjs"), "mcp", "serve"], { cwd: repoRoot, windowsHide: true });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.on("error", reject);
  child.on("close", () => resolve(output));
  child.stdin.end(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "claude-code" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" }
    ]
      .map((message) => JSON.stringify(message))
      .join("\n") + "\n"
  );
});
const responses = transcript.trim().split(/\r?\n/).map((line) => JSON.parse(line));
assert.equal(responses.length, 2, "stdout carries JSON-RPC only");
assert.equal(responses.find((entry) => entry.id === 1).result.protocolVersion, "2024-11-05");
assert.equal(responses.find((entry) => entry.id === 2).result.tools.length, mcpTools.length);

// ---------------------------------------------------------------- hosted runtimes

const runtimeRoot = sandbox("astack-runtime-");
write(join(runtimeRoot, "AGENTS.md"), "# Contract\n");
const registry = new RuntimeRegistry(runtimeRoot, { clock });
registry.register(new ClaudeCodeRuntime({ root: runtimeRoot, clock }));
registry.register(new CodexRuntime({ root: runtimeRoot, clock }));
const codex = registry.get("codex");
assert.equal(codex.describe().status, "implemented");
assert.ok(codex.ready());
assert.equal(registry.get("claude-code").ready(), false, "Claude Code needs CLAUDE.md");
const session = codex.start({ role: "engineer", objective: "add the export endpoint", brief: { contextLines: ["- src/export.mjs"] } });
const ran = await codex.run(session.id);
assert.equal(ran.state, "running");
const order = readFileSync(join(runtimeRoot, ran.workOrder), "utf8");
assert.match(order, /- Runtime: codex/);
assert.match(order, /Retrieved context/);
const neutral = new ModelRouter(runtimeRoot, { registry, clock }).route({ task: "fix the failing build" });
assert.equal(neutral.runtime, "claude-code", "without a host the registration order breaks the tie");
const hosted = new ModelRouter(runtimeRoot, { registry, clock, host: "codex" }).route({ task: "fix the failing build" });
assert.equal(hosted.runtime, "codex", "the hosting runtime executes its own work orders");
const explicit = new ModelRouter(runtimeRoot, { registry, clock, host: "codex" }).route({ task: "fix the failing build", preferred: "claude-code" });
assert.equal(explicit.runtime, "claude-code", "an explicit preference beats the host");

// ---------------------------------------------------------------- upgrade migration

const migration = migrations.find((entry) => entry.id === "2026.7-runtime-interop");
assert.ok(migration, "installs upgraded from 2.1 are wired by a migration");
const legacy = sandbox("astack-legacy-");
write(join(legacy, "AGENTS.md"), "# Contract\n");
write(join(legacy, "CLAUDE.md"), "# Old guide\n");
write(join(legacy, ".gitignore"), "node_modules/\n");
assert.ok(migration.appliesTo(legacy));
assert.match(migration.run(legacy), /wired/);
assert.ok(!migration.appliesTo(legacy), "the migration is idempotent");
assert.match(readFileSync(join(legacy, ".gitignore"), "utf8"), /\.astack\/interop\//);
assert.ok(!migration.appliesTo(sandbox("astack-no-contract-")), "nothing to wire without the shared contract");

console.log("AStack interop verification passed");
