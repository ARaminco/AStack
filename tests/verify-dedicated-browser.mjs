import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DedicatedBrowser, PLAYWRIGHT_MCP_VERSION, PORT_RANGE } from "../browser-engine/dedicated.mjs";
import { BROWSER_SERVER_ID, InteropEngine } from "../interop-engine/interop-engine.mjs";
import { looksLikeInstruction } from "../memory-engine/blocks.mjs";
import { actionKey, commitTarget, filenameProblem, indexSnapshotRefs, logEntry, secretFieldProblem, targetRefs, urlProblem } from "../browser-engine/browser-policy.mjs";
import { ApprovalEngine } from "../trust-engine/approvals.mjs";

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
const tomlBlock = (text) => (text.split("# >>> astack")[1] ?? "").split("# <<< astack")[0];
assert.equal(BROWSER_SERVER_ID, "astack-browser", "a name of its own never collides with an owner's server");
let mcp = JSON.parse(planned(wire(), ".mcp.json"));
assert.match(JSON.stringify(mcp.mcpServers[BROWSER_SERVER_ID]), /astack-browser-mcp\.mjs/, "every project gets its browser server");
let settings = JSON.parse(planned(wire(), ".claude/settings.json"));
assert.ok(settings.enabledMcpjsonServers.includes(BROWSER_SERVER_ID));
assert.ok(settings.permissions.allow.includes("mcp__astack-browser__browser_snapshot"), "looking needs no prompt");
assert.ok(!settings.permissions.allow.some((entry) => /browser_(click|type|fill_form|file_upload|evaluate|tabs)/.test(entry)), "acting (and closing tabs) always asks");
assert.match(tomlBlock(planned(wire(), ".codex/config.toml")), /\[mcp_servers\.astack-browser\]\ncommand = "node"\nargs = \[".*astack-browser-mcp\.mjs"\]/, "Codex gets the same browser");

// An embedded core (lawyer: core in astack/) gets paths relative to the project.
const embedded = sandbox("browser-embedded");
const embeddedPlan = new InteropEngine(repoRoot, { workspaceRoot: repoRoot, projectRoot: embedded }).plan();
assert.match(embeddedPlan.find((entry) => entry.path === ".mcp.json").content, /astack-browser-mcp\.mjs/);

// The owner's own Playwright server — under any name, in either runtime —
// is the project's browser: AStack adds none, for Claude Code or Codex.
const ownBrowser = { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest", "--cdp-endpoint", "http://127.0.0.1:9401"] };
writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { browser: ownBrowser } }, null, 2));
mcp = JSON.parse(planned(wire(), ".mcp.json"));
assert.deepEqual(mcp.mcpServers.browser, ownBrowser, "an owner-written browser server is kept as it is");
assert.equal(mcp.mcpServers[BROWSER_SERVER_ID], undefined, "and no second browser is added");
settings = JSON.parse(planned(wire(), ".claude/settings.json"));
assert.ok(!settings.permissions.allow.some((entry) => entry.includes("browser__")), "no auto-allow reaches the owner's browser");
assert.ok(!settings.enabledMcpjsonServers.includes(BROWSER_SERVER_ID));
assert.doesNotMatch(tomlBlock(planned(wire(), ".codex/config.toml")), /astack-browser/, "Codex stays on the owner's browser too");

// A stale enable/allow of ours is removed when AStack no longer manages it.
mkdirSync(join(project, ".claude"), { recursive: true });
writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ enabledMcpjsonServers: ["astack-browser"], permissions: { allow: ["mcp__astack-browser__browser_snapshot", "Bash(ls)"] } }));
settings = JSON.parse(planned(wire(), ".claude/settings.json"));
assert.ok(!settings.enabledMcpjsonServers.includes(BROWSER_SERVER_ID) && !settings.permissions.allow.some((entry) => entry.startsWith("mcp__astack-browser__")));
assert.ok(settings.permissions.allow.includes("Bash(ls)"), "the owner's own permissions stay");

// Codex: any owner shape for a Playwright server means no second definition.
writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
for (const owner of [
  "[mcp_servers.\"browser\"]\ncommand = \"npx\"\nargs = [\"@playwright/mcp@latest\"]\n",
  "[ mcp_servers.browser ] # mine\ncommand = \"npx\"\nargs = [\"@playwright/mcp\"]\n",
  "mcp_servers.browser = { command = \"npx\", args = [\"@playwright/mcp\"] }\n",
  "[mcp_servers]\nbrowser = { command = \"npx\", args = [\"@playwright/mcp\"] }\n"
]) {
  mkdirSync(join(project, ".codex"), { recursive: true });
  writeFileSync(join(project, ".codex", "config.toml"), owner);
  assert.doesNotMatch(tomlBlock(planned(wire(), ".codex/config.toml")), /astack-browser/, "owner TOML shape kept alone: " + owner.split("\n")[0]);
  assert.equal(JSON.parse(planned(wire(), ".mcp.json")).mcpServers[BROWSER_SERVER_ID], undefined, "and Claude Code stays on the same browser");
}
writeFileSync(join(project, ".codex", "config.toml"), "");

// Turning the browser off removes AStack's entry only, under any old name.
writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { browser: { type: "stdio", command: "node", args: ["bin/astack-browser-mcp.mjs"] } } }, null, 2));
mcp = JSON.parse(planned(wire(), ".mcp.json"));
assert.equal(mcp.mcpServers.browser, undefined, "an entry of ours under the pre-release name is replaced");
assert.ok(mcp.mcpServers[BROWSER_SERVER_ID]);
mcp = JSON.parse(planned(wire({ browser: { enabled: false } }), ".mcp.json"));
assert.equal(mcp.mcpServers[BROWSER_SERVER_ID], undefined, "browser.dedicated.enabled: false removes AStack's server");

// --------------------------------------------------------------- the policy
assert.match(urlProblem({ url: "javascript:alert(1)" }), /javascript:/, "a javascript: address never runs");
assert.match(urlProblem({ url: " JavaScript:void(0)" }), /Refused/);
assert.match(urlProblem({ action: "new", url: "data:text/html,<script>x</script>" }), /data:/);
assert.match(urlProblem({ url: "file:///C:/Projects/lawyer/case.pdf" }), /file:/);
assert.equal(urlProblem({ url: "https://example.com/a?b=c" }), null);
assert.equal(urlProblem({ url: "about:blank" }), null);
assert.match(filenameProblem({ filename: "CLAUDE.md" }) ?? "", /^$/, "a bare name is fine (it lands in the output folder)");
for (const name of [".claude/settings.json", "..\\AGENTS.md", "C:\\x.png", "sub/x.png", ".env"]) {
  assert.match(filenameProblem({ filename: name }), /Refused/, name);
}
assert.match(secretFieldProblem("browser_type", { element: "Password textbox", text: "x" }), /owner/);
assert.match(secretFieldProblem("browser_type", { element: "فیلد رمز عبور", text: "x" }), /owner/);
assert.match(secretFieldProblem("browser_fill_form", { fields: [{ name: "Email", type: "textbox" }, { name: "One-time code", type: "textbox" }] }), /owner/);
assert.equal(secretFieldProblem("browser_type", { element: "Search box", text: "laravel" }), null);
assert.ok(commitTarget("browser_click", { element: "Pay now button", ref: "e12" }), "a pay click is a commit");
assert.ok(commitTarget("browser_click", { element: "دکمه ثبت نهایی", ref: "e3" }));
assert.ok(commitTarget("browser_type", { element: "Message box send", text: "hi", submit: true }));
assert.ok(commitTarget("browser_file_upload", { paths: ["Z:/DrLawyer/case.pdf"] }), "every upload is a commit");
assert.ok(commitTarget("browser_handle_dialog", { accept: true }));
assert.equal(commitTarget("browser_click", { element: "Next page link", ref: "e5" }), null);
assert.equal(commitTarget("browser_snapshot", {}), null);
assert.notEqual(actionKey("browser_click", { element: "Pay", ref: "e1" }), actionKey("browser_click", { element: "Pay", ref: "e2" }), "one approval covers exactly one call");
const refs = indexSnapshotRefs('- generic [ref=e1]:\n  - button "Pay now" [ref=e12] [cursor=pointer]\n  - link "Next" [ref=e13]');
assert.equal(commitTarget("browser_click", { element: "blue button", ref: "e12" }, targetRefs({ ref: "e12" }).map((ref) => refs.get(ref)).join(" ")) !== null, true, "a misleading description does not get past the gate");
assert.equal(commitTarget("browser_click", { element: "link", ref: "e13" }, refs.get("e13")), null);
assert.ok(commitTarget("browser_mouse_click_xy", { x: 10, y: 20 }), "a coordinate click always needs approval");
const entry = logEntry("browser_navigate", { url: "https://site.test/reset?token=abc#x", text: "secret" });
assert.equal(entry.url, "https://site.test/reset", "the log keeps no query string");
assert.equal(entry.text, undefined, "or typed text");

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
  const claudeBefore = readFileSync(join(repoRoot, "CLAUDE.md"));
  // Claude Code declares roots; the proxy must keep Playwright out of the project anyway.
  await call("initialize", { protocolVersion: "2025-06-18", capabilities: { roots: { listChanged: true } }, clientInfo: { name: "claude-code", version: "1" } });
  const listed = await call("tools/list", {});
  assert.ok(listed.result.tools.some((tool) => tool.name === "browser_snapshot"));
  assert.ok(!listed.result.tools.some((tool) => ["browser_evaluate", "browser_run_code_unsafe"].includes(tool.name)), "code-running tools are hidden");
  const refused = await call("tools/call", { name: "browser_evaluate", arguments: { function: "() => document.cookie" } });
  assert.equal(refused.result.isError, true, "and refused when called anyway");
  const navigated = await call("tools/call", { name: "browser_navigate", arguments: { url: "https://example.com" } });
  assert.ok(!navigated.result.isError && /Example Domain/.test(JSON.stringify(navigated.result)), "Playwright drives the project's window");
  assert.match(navigated.result.content[0].text, /untrusted data/, "page output is marked untrusted");
  const script = await call("tools/call", { name: "browser_navigate", arguments: { url: "javascript:void(document.title='JSRAN')" } });
  assert.equal(script.result.isError, true, "javascript: is refused before Playwright sees it");
  const overwrite = await call("tools/call", { name: "browser_take_screenshot", arguments: { filename: "../../../../CLAUDE.md" } });
  assert.equal(overwrite.result.isError, true, "no tool writes outside the output folder");
  const pay = { name: "browser_click", arguments: { element: "Pay now button", ref: "e999" } };
  const stopped = await call("tools/call", pay);
  const approvalId = /AP-[0-9a-f]+/.exec(stopped.result.content[0].text)?.[0];
  assert.ok(stopped.result.isError && approvalId, "a commit click stops with an approval id");
  new ApprovalEngine(repoRoot).approve(approvalId, { by: "owner" });
  const allowed = await call("tools/call", pay);
  assert.doesNotMatch(JSON.stringify(allowed.result), /Stopped before a commit/, "after approval the same call goes through once");
  const again = await call("tools/call", pay);
  assert.match(again.result.content[0].text, /Stopped before a commit/, "one approval never covers a second click");
  const shot = await call("tools/call", { name: "browser_take_screenshot", arguments: { filename: "CLAUDE.md" } });
  assert.ok(!shot.result.isError, "a bare filename is accepted");
  assert.ok(readFileSync(join(repoRoot, "CLAUDE.md")).equals(claudeBefore), "the project's CLAUDE.md is untouched even with client roots");
  assert.ok(existsSync(join(repoRoot, ".astack", "browser", "dedicated", "output", "CLAUDE.md")), "the file lands in the output folder");
  rmSync(join(repoRoot, ".astack", "browser", "dedicated", "output", "CLAUDE.md"), { force: true });
  assert.ok(!listed.result.tools.some((tool) => /mouse_click_xy/.test(tool.name)), "no coordinate clicks by default");
  // A real page with a pay button, described misleadingly by the agent.
  const site = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>shop</title><button onclick=\"document.title='PAID'\">Pay now</button><a href=\"#next\">Next</a>");
  });
  await new Promise((resolveListen) => site.listen(0, "127.0.0.1", resolveListen));
  const shop = "http://127.0.0.1:" + site.address().port + "/";
  await call("tools/call", { name: "browser_navigate", arguments: { url: shop } });
  const snapshot = await call("tools/call", { name: "browser_snapshot", arguments: {} });
  const payRef = /button "Pay now" \[ref=([A-Za-z0-9_-]+)\]/.exec(JSON.stringify(snapshot.result).replace(/\\"/g, '"'))?.[1];
  assert.ok(payRef, "the snapshot names the pay button");
  const disguised = await call("tools/call", { name: "browser_click", arguments: { element: "blue button", ref: payRef } });
  assert.match(disguised.result.content[0].text, /Stopped before a commit/, "the gate reads the page, not the agent's description");
  const title = await call("tools/call", { name: "browser_snapshot", arguments: {} });
  assert.doesNotMatch(JSON.stringify(title.result), /PAID/, "nothing was paid");
  site.close();
  child.stdin.end();
  await new DedicatedBrowser(repoRoot).stop();
  assert.ok(existsSync(join(repoRoot, ".astack", "browser", "dedicated", "calls.jsonl")), "tool calls are logged");
  rmSync(core, { recursive: true, force: true });
}

for (const directory of sandboxes) {
  rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
}
console.log("AStack dedicated browser verification passed.");
