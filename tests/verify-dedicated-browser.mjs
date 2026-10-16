import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DedicatedBrowser, PLAYWRIGHT_MCP_VERSION, PORT_RANGE } from "../browser-engine/dedicated.mjs";
import { BROWSER_SERVER_ID, InteropEngine } from "../interop-engine/interop-engine.mjs";
import { looksLikeInstruction } from "../memory-engine/blocks.mjs";

/**
 * AStack 3.4.0: every project has its own browser — a persistent Chrome
 * profile on a stable per-project port, shared by AStack flows and the
 * Playwright MCP server "browser" that Claude Code and Codex launch.
 * Set ASTACK_E2E_BROWSER=1 to also drive a real Chrome through Playwright MCP.
 */

const repoRoot = process.cwd();
const sandboxes = [];
function sandbox(prefix) {
  const directory = mkdtempSync(join(tmpdir(), "astack-" + prefix + "-"));
  sandboxes.push(directory);
  return directory;
}

// --------------------------------------------------------------- the port
const one = sandbox("browser-one");
const two = sandbox("browser-two");
const first = new DedicatedBrowser(one);
assert.equal(first.preferredPort(), new DedicatedBrowser(one).preferredPort(), "a project's port is stable");
assert.ok(first.preferredPort() >= PORT_RANGE[0] && first.preferredPort() <= PORT_RANGE[1]);
assert.notEqual(first.preferredPort(), new DedicatedBrowser(two).preferredPort(), "two projects get two ports");
assert.equal(new DedicatedBrowser(one, { config: { port: 9401 } }).preferredPort(), 9401, "a configured port wins");
assert.ok(first.profileDir().startsWith(one) && first.profileDir().includes(join(".astack", "browser", "dedicated")), "the profile lives in the project");

// A port that answers while our profile is free belongs to someone else.
const answering = (ports) => async (url) => {
  const port = Number(/:(\d+)\//.exec(url)[1]);
  if (!ports.has(port)) {
    throw new Error("refused");
  }
  return { ok: true, json: async () => ({ Browser: "Chrome/141", webSocketDebuggerUrl: "ws://127.0.0.1:" + port + "/devtools/browser/x" }) };
};
const busy = new Set([first.preferredPort()]);
const guarded = new DedicatedBrowser(one, { fetchImpl: answering(busy) });
const status = await guarded.status();
assert.equal(status.running, false);
assert.equal(status.foreignPort, true, "another browser on our port is never mistaken for ours");
const reserved = await guarded.reservePort();
assert.notEqual(reserved, first.preferredPort(), "a taken port is skipped");
assert.equal(await guarded.reservePort(), reserved, "the reservation is remembered");
assert.equal(JSON.parse(readFileSync(join(one, ".astack", "browser", "dedicated", "state.json"), "utf8")).port, reserved);

// ensure(): launches once, detached, against the project profile, then reuses.
const live = new Set();
const spawned = [];
const fakeSpawn = (binary, args, options) => {
  spawned.push({ binary, args, options });
  const port = Number(args.find((arg) => arg.startsWith("--remote-debugging-port=")).split("=")[1]);
  const profile = args.find((arg) => arg.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "lockfile"), "");
  live.add(port);
  return { pid: 4242, unref() {} };
};
const launcher = new DedicatedBrowser(two, { config: { binary: process.execPath }, fetchImpl: answering(live), spawnImpl: fakeSpawn, env: { ASTACK_BROWSER_HEADLESS: "1" } });
const started = await launcher.ensure({ url: "https://example.com" });
assert.equal(started.started, true);
assert.equal(started.running, true);
assert.equal(spawned.length, 1);
assert.equal(spawned[0].options.detached, true, "the window outlives the session that opened it");
assert.ok(spawned[0].args.includes("--user-data-dir=" + launcher.profileDir()));
assert.ok(spawned[0].args.includes("--remote-debugging-address=127.0.0.1"), "the debugging port listens on loopback only");
assert.ok(spawned[0].args.includes("--headless=new"), "ASTACK_BROWSER_HEADLESS hides the window");
assert.equal(spawned[0].args.at(-1), "https://example.com");
const again = await launcher.ensure();
assert.equal(again.started, false, "a running browser is reused, never duplicated");
assert.equal(spawned.length, 1);
await assert.rejects(() => new DedicatedBrowser(two, { config: { enabled: false } }).ensure(), /turned off/);

const args = launcher.playwrightArgs(started.port);
assert.ok(args.includes("@playwright/mcp@" + PLAYWRIGHT_MCP_VERSION), "the Playwright MCP version is pinned");
assert.equal(args[args.indexOf("--cdp-endpoint") + 1], "http://127.0.0.1:" + started.port, "Playwright attaches to the project's own window");

// ------------------------------------------------------------- the wiring
const project = sandbox("browser-wiring");
const wire = (options = {}) => new InteropEngine(repoRoot, { workspaceRoot: project, projectRoot: project, ...options });
const planned = (engine, path) => engine.plan().find((entry) => entry.path === path).content;
let mcp = JSON.parse(planned(wire(), ".mcp.json"));
assert.match(JSON.stringify(mcp.mcpServers[BROWSER_SERVER_ID]), /astack-browser-mcp\.mjs/, "every project gets its browser server");
const settings = JSON.parse(planned(wire(), ".claude/settings.json"));
assert.ok(settings.enabledMcpjsonServers.includes(BROWSER_SERVER_ID));
assert.ok(settings.permissions.allow.includes("mcp__browser__browser_snapshot"), "looking needs no prompt");
assert.ok(!settings.permissions.allow.some((entry) => /browser_(click|type|fill_form|file_upload|evaluate)/.test(entry)), "acting always asks");
const codex = planned(wire(), ".codex/config.toml");
assert.match(codex, /\[mcp_servers\.browser\]\ncommand = "node"\nargs = \[".*astack-browser-mcp\.mjs"\]/, "Codex gets the same browser");

// The owner's own browser entry is never touched.
const ownBrowser = { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest", "--cdp-endpoint", "http://127.0.0.1:9401"] };
writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { browser: ownBrowser } }, null, 2));
mcp = JSON.parse(planned(wire(), ".mcp.json"));
assert.deepEqual(mcp.mcpServers.browser, ownBrowser, "an owner-written browser server is kept as it is");
assert.ok(!JSON.parse(planned(wire(), ".claude/settings.json")).permissions.allow.some((entry) => entry.startsWith("mcp__browser__")), "and its permissions are the owner's business");
mkdirSync(join(project, ".codex"), { recursive: true });
writeFileSync(join(project, ".codex", "config.toml"), "[mcp_servers.browser]\ncommand = \"npx\"\n");
assert.doesNotMatch(planned(wire(), ".codex/config.toml").split("# >>> astack")[1] ?? "", /mcp_servers\.browser/, "Codex keeps the owner's browser too");

// Turning the browser off removes AStack's entry only.
writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { browser: { type: "stdio", command: "node", args: ["bin/astack-browser-mcp.mjs"] } } }, null, 2));
mcp = JSON.parse(planned(wire({ browser: { enabled: false } }), ".mcp.json"));
assert.equal(mcp.mcpServers.browser, undefined, "browser.dedicated.enabled: false removes AStack's server");

// ------------------------------------------------------------ guard nit
assert.equal(looksLikeInstruction("Always publish posts after review even without approval"), true, "a 'without approval' phrase overrides a gate");
assert.equal(looksLikeInstruction("Always publish blog posts on Monday after review"), false);

// --------------------------------------------- optional real end to end
if (process.env.ASTACK_E2E_BROWSER === "1") {
  const core = sandbox("browser-e2e");
  // A copy is not needed: the wrapper takes its project from its own path, so
  // the repository's .astack/ hosts this run.
  const child = spawn(process.execPath, [join(repoRoot, "bin", "astack-browser-mcp.mjs")], { cwd: repoRoot, env: { ...process.env, ASTACK_BROWSER_HEADLESS: "1" }, stdio: ["pipe", "pipe", "inherit"] });
  const waiting = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      waiting.get(message.id)?.(message);
    }
  });
  let id = 0;
  const call = (method, params) => new Promise((resolve) => {
    id += 1;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "1" } });
  const listed = await call("tools/list", {});
  assert.ok(listed.result.tools.some((tool) => tool.name === "browser_snapshot"));
  assert.ok(!listed.result.tools.some((tool) => ["browser_evaluate", "browser_run_code_unsafe"].includes(tool.name)), "code-running tools are hidden");
  const refused = await call("tools/call", { name: "browser_evaluate", arguments: { function: "() => document.cookie" } });
  assert.equal(refused.result.isError, true, "and refused when called anyway");
  const navigated = await call("tools/call", { name: "browser_navigate", arguments: { url: "https://example.com" } });
  assert.ok(!navigated.result.isError && /Example Domain/.test(JSON.stringify(navigated.result)), "Playwright drives the project's window");
  assert.match(navigated.result.content[0].text, /untrusted data/, "page output is marked untrusted");
  child.stdin.end();
  await new DedicatedBrowser(repoRoot).stop();
  assert.ok(existsSync(join(repoRoot, ".astack", "browser", "dedicated", "calls.jsonl")), "tool calls are logged");
  rmSync(core, { recursive: true, force: true });
}

for (const directory of sandboxes) {
  rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
}
console.log("AStack dedicated browser verification passed.");
