import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EconomyEngine, subagentTranscript } from "../economy-engine/economy-engine.mjs";
import { UsageMeter } from "../economy-engine/usage-meter.mjs";
import { Limits } from "../economy-engine/limits.mjs";
import { LiveRegistry } from "../economy-engine/live.mjs";
import { classify, decideRoute } from "../economy-engine/policy.mjs";
import { codexAvailability as checkCodex, delegate as runDelegate } from "../economy-engine/delegate.mjs";
import { atomicJson, readJson, scanLines } from "../economy-engine/storage.mjs";
import { InteropEngine } from "../interop-engine/interop-engine.mjs";
import { createMcpHandler } from "../interop-engine/mcp-server.mjs";

const root = process.cwd();
mkdirSync(join(root, ".astack", "tmp"), { recursive: true });
const temporary = mkdtempSync(join(root, ".astack", "tmp", "economy-"));
process.on("exit", () => rmSync(temporary, { recursive: true, force: true, maxRetries: 3 }));
const dir = (name) => {
  const path = join(temporary, name);
  mkdirSync(path, { recursive: true });
  return path;
};
const home = dir("home");
const directory = dir("account");
const project = dir("project");
const now = Date.parse("2026-10-20T12:00:00Z");
let time = now;
const clock = () => time;

// Classification: owner roles take precedence over incidental prompt keywords.
for (const [type, job] of Object.entries({ Explore: "search", Plan: "plan", "case-analyst": "legal", "legal-reviewer": "legal", "legal-drafter": "legal", "qa-inspector": "review", "security-officer": "review", "code-reviewer": "review", "web-engineer": "build", "infra-operator": "build", paralegal: "bulk-read", "content-editor": "write" })) {
  assert.equal(classify({ subagent_type: type, prompt: "find things" }), job, type);
}
for (const [prompt, job] of [["فهرست پوشه‌ها را پیدا کن", "search"], ["صفحات را بخوان و داده‌ها را استخراج کن", "bulk-read"], ["رابط کاربری بساز", "build"], ["امنیت را بررسی کن", "review"], ["معماری و برنامه‌ریزی", "plan"], ["قرارداد تسویه پرونده دادگاه", "legal"], ["مقاله را ترجمه کن", "write"], ["hello", "other"], ["read many files", "bulk-read"], ["find and fix bug", "build"], ["Write test cases for the API contract", "build"]]) {
  assert.equal(classify({ prompt }), job, prompt);
}

const route = (job, model, pressure = "green", config = {}) => decideRoute({ subagent_type: job, prompt: job, ...(model ? { model } : {}) }, { pressure, config });
assert.equal(route("Explore", "opus").model, "haiku");
assert.equal(route("review", "haiku").model, "haiku", "never raise a cheaper caller choice");
assert.equal(route("review", null).model, "sonnet", "default sub-agent model is sonnet");
assert.equal(route("review", "opus").model, "opus");
assert.equal(route("review", "opus", "amber").model, "sonnet");
assert.equal(route("Plan", "opus", "amber").model, "sonnet");
assert.equal(decideRoute({ subagent_type: "review", model: "opus", prompt: "production security" }, { pressure: "amber" }).model, "opus");
for (const pressure of ["green", "amber", "red", "critical", "unknown"]) {
  assert.equal(route("legal-reviewer", "haiku", pressure).model, "opus");
  assert.equal(route("build", "haiku", pressure).model, "haiku");
}
assert.equal(route("review", "opus", "red").model, "sonnet");
assert.equal(route("review", "fable", "critical").model, "sonnet");
assert.equal(route("build", "opus", "red").delegate, true);
assert.equal(route("build", "opus", "green", { respect_explicit: true }).model, "opus");
assert.equal(route("Explore", "claude-sonnet-4-6").model, "haiku");
assert.equal(route("build", "haiku", "green", { routes: { build: "opus" } }).model, "haiku");
for (const [pressure, cap] of [["green", 4], ["amber", 3], ["red", 2], ["critical", 1]]) {
  assert.equal(decideRoute({}, { pressure, running: cap }).denied, true);
  assert.equal(decideRoute({}, { pressure, running: cap - 1 }).denied, false);
}

// Streaming, response deduplication across scans, weighted windows and Codex deltas.
const claudeRoot = dir("claude");
const codexRoot = dir("codex");
const delegate = (options) => runDelegate({ home, codexRoot, ...options });
const codexAvailability = (options) => checkCodex({ home, codexRoot, ...options });
const slug = join(claudeRoot, "project-slug");
mkdirSync(slug);
const transcript = join(slug, "session.jsonl");
const record = (id, requestId, output = 5, timestamp = "2026-10-20T11:30:00Z") => JSON.stringify({ timestamp, requestId, message: { id, model: "claude-opus-4-6", usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: output } } }) + "\n";
writeFileSync(transcript, record("m1", "r1") + record("m1", "r1", 8));
const meter = new UsageMeter({ home, directory, claudeRoot, codexRoot, clock });
let snapshot = await meter.snapshot();
assert.equal(snapshot.totals.calls, 1);
assert.equal(snapshot.totals.output_tokens, 8);
assert.equal(snapshot.totals.units, (100 + 20 + 100 + 40) * 1.67);
const offset = readJson(meter.path).files[transcript].offset;
assert.equal(offset, statSync(transcript).size);
assert.deepEqual((await meter.snapshot()).totals, snapshot.totals);
appendFileSync(transcript, record("m1", "r1", 12) + record("m1", "r2", 2));
appendFileSync(transcript, '{"output_tokens":1,"image":"' + "x".repeat(5 * 1024 * 1024) + '"}\n');
appendFileSync(transcript, record("m2", "r3", 3) + '{"customTitle":"Owner title"}\n');
snapshot = await meter.snapshot();
assert.equal(snapshot.totals.calls, 3);
assert.equal(snapshot.totals.output_tokens, 17);
assert.equal(snapshot.topConsumers[0].title, "Owner title");
assert.equal(snapshot.topConsumers[0].share, 100);
assert.equal(snapshot.burnRate, snapshot.totals.units);
assert.equal(readJson(meter.path).files[transcript].offset, statSync(transcript).size);
assert.equal(Object.keys(snapshot.groups.models)[0], "claude-opus-4-6");
appendFileSync(transcript, record("old", "old", 3, "2026-10-14T10:00:00Z"));
snapshot = await meter.snapshot({ since: "2026-10-20T11:00:00Z" });
assert.equal(snapshot.totals.calls, 3);
assert.equal(snapshot.windows.sevenDay.calls, 4);
assert.equal(snapshot.windows.fiveHour.calls, 3);
assert.equal((await meter.snapshot({ since: "2026-10-20T11:45:00Z" })).totals.calls, 0);
const codexLog = join(codexRoot, "codex.jsonl");
const codexRecord = (input, output) => JSON.stringify({ timestamp: "2026-10-20T11:55:00Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: 10, output_tokens: output } }, rate_limits: { primary: { used_percent: 23, resets_at: now / 1000 + 3600 } } } }) + "\n";
writeFileSync(codexLog, codexRecord(100, 10) + codexRecord(100, 10) + codexRecord(150, 15));
snapshot = await meter.snapshot();
assert.equal(snapshot.codex.input_tokens, 140);
assert.equal(snapshot.codex.cache_read_input_tokens, 10);
assert.equal(snapshot.codex.output_tokens, 15);
assert.equal(snapshot.codex.rate_limits.primary.used_percent, 23);
assert.equal((await meter.snapshot()).codex.tokens, snapshot.codex.tokens);
const topLevelCount = JSON.parse(codexRecord(160, 20));
topLevelCount.type = topLevelCount.payload.type;
delete topLevelCount.payload.type;
appendFileSync(codexLog, JSON.stringify(topLevelCount) + "\n");
assert.equal((await meter.snapshot()).codex.output_tokens, 20, "both Codex token_count envelopes are accepted");
writeFileSync(transcript, record("replacement", "new", 1));
assert.equal((await meter.snapshot()).totals.calls, 1, "truncation resets old file records");
const partial = join(temporary, "partial.jsonl");
writeFileSync(partial, "complete\nincomplete");
const lines = [];
assert.equal(scanLines(partial, 0, (line) => lines.push(line)), 9);
appendFileSync(partial, "\n");
scanLines(partial, 9, (line) => lines.push(line));
assert.deepEqual(lines, ["complete", "incomplete"]);

// Official limits, staleness and optional meter estimates.
const limits = new Limits({ directory, clock });
assert.equal(limits.pressure().pressure, "unknown");
limits.capture({ session_id: "session", model: { id: "opus" }, context_window: { total_input_tokens: 260000 }, rate_limits: { seven_day: { used_percentage: 55, resets_at: now / 1000 + 86400 }, five_hour: { used_percentage: 20 } } });
assert.equal(limits.pressure().pressure, "amber");
assert.equal(limits.pressure().source, "official");
// Pace: 41% on the first day of the week is ahead of pace (amber); 41% with three days left is fine.
for (const [week, daysLeft, expected] of [[41, 6.5, "amber"], [50, 6.9, "red"], [41, 3, "green"]]) {
  limits.capture({ rate_limits: { seven_day: { used_percentage: week, resets_at: (now + daysLeft * 86400000) / 1000 }, five_hour: { used_percentage: 10 } } });
  assert.equal(limits.pressure().pressure, expected, week + "% with " + daysLeft + " days left");
}
for (const [week, five, expected] of [[20, 90, "red"], [86, 20, "critical"], [20, 96, "critical"], [20, 20, "green"]]) {
  limits.capture({ rate_limits: { seven_day: { used_percentage: week }, five_hour: { used_percentage: five } } });
  assert.equal(limits.pressure().pressure, expected);
}
time += 31 * 60000;
assert.equal(limits.pressure().pressure, "unknown");
const estimated = new Limits({ directory, clock, config: { weekly_budget_units: 1000 } });
assert.equal(estimated.pressure({ capturedAt: time, windows: { sevenDay: { units: 750 } } }).pressure, "red");
assert.equal(estimated.pressure({ capturedAt: now, windows: { sevenDay: { units: 750 } } }).pressure, "unknown");
time = now;

// Live lifecycle, cap denial, bounded context tail and hook output protocol.
const engine = new EconomyEngine({ root: project, home, directory, clock });
mkdirSync(join(project, ".claude", "agents"), { recursive: true });
writeFileSync(join(project, ".claude", "agents", "quoted-worker.md"), "---\nmodel: 'haiku'\n---\nBounded task.\n");
assert.equal(engine.decision({ subagent_type: "quoted-worker", prompt: "build" }).model, "haiku", "quoted frontmatter models remain valid aliases");
const request = { tool_name: "Agent", session_id: "session", tool_input: { subagent_type: "Explore", description: "locate", prompt: "find files", model: "opus", run_in_background: true } };
const allowed = engine.route(request).hookSpecificOutput;
assert.equal(allowed.updatedInput.model, "haiku");
assert.equal(allowed.updatedInput.run_in_background, true);
assert.ok(allowed.updatedInput.prompt.startsWith("[AStack economy]"));
assert.ok(allowed.updatedInput.prompt.indexOf("\n\n") <= 600);
assert.equal(request.tool_input.model, "opus", "input is never mutated");
assert.equal(engine.route({ tool_name: "Agent", tool_input: {} }), null);
for (let index = 0; index < 4; index += 1) {
  engine.onSubagentStart({ session_id: "session", agent_id: "a" + index, agent_type: "Explore" });
}
assert.equal(engine.live.read().session.a0.model, "haiku", "SubagentStart retains the routed model");
assert.equal(engine.route(request).hookSpecificOutput.permissionDecision, "deny");
engine.onSubagentStop({ session_id: "session", agent_id: "a0" });
assert.equal(engine.route(request).hookSpecificOutput.permissionDecision, "allow");
time += 3 * 3600000 + 1;
assert.deepEqual(new LiveRegistry({ directory, clock }).read(), {});
time = now;
const agentsDir = join(slug, "session", "subagents");
mkdirSync(agentsDir, { recursive: true });
const agentPath = join(agentsDir, "agent-child.jsonl");
writeFileSync(agentPath, JSON.stringify({ message: { usage: { input_tokens: 70000, cache_read_input_tokens: 100000, output_tokens: 10 } } }) + "\n");
const tool = { session_id: "session", agent_id: "child", transcript_path: transcript, tool_name: "Read" };
assert.equal(subagentTranscript(tool), agentPath);
assert.equal(subagentTranscript({ ...tool, transcript_path: agentPath }), agentPath);
assert.match(engine.guardTool(tool).hookSpecificOutput.permissionDecisionReason, /Context budget reached \(170 k tokens\)/);
assert.equal(engine.guardTool({ ...tool, agent_id: undefined }), null);
writeFileSync(agentPath, record("small", "small"));
assert.equal(engine.guardTool(tool), null);
assert.match(engine.onPrompt({ session_id: "session" }).hookSpecificOutput.additionalContext, /\/compact/);
assert.equal(engine.onPrompt({ session_id: "empty" }), null);
let chained = false;
assert.equal(engine.statusline({ session_id: "session" }, { chain: { command: "owner-statusline" }, raw: "original stdin", run: (command, options) => {
  chained = true;
  assert.equal(command, "owner-statusline");
  assert.equal(options.input, "original stdin");
  return { status: 0, stdout: "owner output" };
} }), "owner output");
assert.ok(chained);
assert.match(engine.statusline({ model: "opus" }), /opus.*5h.*7d/);

// Wiring is idempotent, preserves owner entries and restores all owner state.
const ownerStatus = { type: "command", command: "node owner-statusline.mjs", padding: 2 };
const owner = { env: { OWNER: "yes", CLAUDE_CODE_SUBAGENT_MODEL: "haiku" }, statusLine: ownerStatus, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "owner-hook" }] }], UserPromptSubmit: [{ hooks: [{ type: "command", command: "owner-prompt" }] }] } };
const interop = new InteropEngine(root, { workspaceRoot: project, home, env: {} });
const wired = interop.plannedClaudeSettings(structuredClone(owner));
const markerCount = (settings, event) => (settings.hooks[event] ?? []).flatMap((group) => group.hooks).filter((hook) => hook.command.includes("astack-economy-hook.mjs")).length;
assert.equal(markerCount(wired, "PreToolUse"), 2);
assert.equal(markerCount(wired, "UserPromptSubmit"), 1);
assert.ok(wired.hooks.UserPromptSubmit.some((group) => group.hooks.some((hook) => hook.command.includes("interop hook"))));
assert.equal(wired.env.CLAUDE_CODE_SUBAGENT_MODEL, "haiku");
assert.deepEqual(interop.plannedClaudeSettings(structuredClone(wired)), wired);
const disabled = new InteropEngine(root, { workspaceRoot: project, home, env: {}, economy: { enabled: false } }).plannedClaudeSettings(structuredClone(wired));
assert.equal(markerCount(disabled, "PreToolUse"), 0);
assert.equal(markerCount(disabled, "UserPromptSubmit"), 0);
assert.deepEqual(disabled.statusLine, ownerStatus);
assert.equal(disabled.env.CLAUDE_CODE_SUBAGENT_MODEL, "haiku");
assert.ok(disabled.hooks.PreToolUse.some((group) => group.hooks.some((hook) => hook.command === "owner-hook")));
const defaultWired = interop.plannedClaudeSettings({});
assert.equal(defaultWired.env.CLAUDE_CODE_SUBAGENT_MODEL, "sonnet");
const defaultOff = new InteropEngine(root, { workspaceRoot: project, home, env: {}, economy: { enabled: false } }).plannedClaudeSettings(defaultWired);
assert.equal(defaultOff.statusLine, undefined);
assert.equal(defaultOff.env, undefined);
const configured = new InteropEngine(root, { workspaceRoot: project, home, env: {}, economy: { statusline: { chain: "owner-configured-command" } } }).plannedClaudeSettings(structuredClone(wired));
const encodedChain = configured.statusLine.command.match(/--chain ([A-Za-z0-9_-]+)/)[1];
assert.equal(JSON.parse(Buffer.from(encodedChain, "base64url").toString("utf8")), "owner-configured-command", "configured chains also update an existing wrapper");
const worker = interop.plan().find((file) => file.path === ".claude/agents/codex-worker.md");
assert.match(worker.content, /model: haiku/);

// Delegation never contacts real providers: login, exec and Ollama are mocked.
const delegateDir = dir("delegate");
let loginCalls = 0;
const unavailable = async () => { loginCalls += 1; return { ok: false, stdout: "", reason: "missing" }; };
const fetcher = async (url) => ({ ok: true, json: async () => url.endsWith("/api/tags") ? { models: [{ name: "embedding", details: { family: "bert-embed" } }, { name: "text-model" }] } : { response: "summary", prompt_eval_count: 20, eval_count: 5 } });
const fallback = await delegate({ to: "auto", task: "Summarise this supplied text: hello.", cwd: project, directory: delegateDir, run: unavailable, fetcher });
assert.equal(fallback.ok, true);
assert.equal(fallback.engine, "local");
assert.equal(fallback.output, "summary");
assert.equal(loginCalls, 1);
await codexAvailability({ directory: delegateDir, cwd: project, run: unavailable });
assert.equal(loginCalls, 1, "login is cached for ten minutes");
assert.equal((await delegate({ to: "auto", task: "Build a site", cwd: project, directory: delegateDir, run: unavailable, fetcher })).ok, false);
assert.equal((await delegate({ to: "auto", task: "extract", images: ["image.png"], cwd: project, directory: delegateDir, run: unavailable, fetcher })).ok, false);
const execDir = dir("exec");
const mockRun = async (command, args, options) => {
  assert.equal(command, "codex");
  if (args[0] === "login") {
    return { ok: true, stdout: "", stderr: "Logged in using ChatGPT" };
  }
  assert.equal(args.at(-1), "-");
  assert.equal(args[args.indexOf("-s") + 1], "workspace-write");
  assert.equal(options.input, "Build the bounded component");
  assert.ok(args.includes("--output-schema"));
  assert.equal(args.filter((arg) => arg === "-i").length, 2);
  writeFileSync(args[args.indexOf("-o") + 1], "codex result");
  return { ok: true, stdout: '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":7}}\n' };
};
const execution = await delegate({ task: "Build the bounded component", to: "codex", mode: "write", cwd: project, directory: execDir, run: mockRun, schema_json: { type: "object" }, images: ["a.png", "b.png"] });
assert.equal(execution.ok, true);
assert.equal(execution.output, "codex result");
assert.equal(execution.usage.output_tokens, 7);
atomicJson(join(execDir, "limits.json"), { codex: { capturedAt: now + 1, rate_limits: { primary: { used_percent: 95, resets_at: Date.now() / 1000 + 1000 } } } });
assert.equal((await codexAvailability({ directory: execDir, run: () => assert.fail("must not spawn") })).available, false);
assert.equal((await delegate({ task: "x", to: "auto", cwd: project, directory: dir("throwing"), run: async () => { throw new Error("mock failure"); } })).ok, false);
const logLimits = dir("log-limits");
const hotLogs = dir("hot-codex");
writeFileSync(join(hotLogs, "session.jsonl"), JSON.stringify({ timestamp: new Date().toISOString(), payload: { type: "token_count", rate_limits: { primary: { used_percent: 95, resets_at: Date.now() / 1000 + 1000 } } } }) + "\n");
assert.equal((await codexAvailability({ directory: logLimits, codexRoot: hotLogs, run: () => assert.fail("fresh log pressure must prevent spawning") })).available, false);

// Concurrent hook processes retain every live agent instead of last-writer wins.
const concurrent = dir("concurrent");
const moduleUrl = pathToFileURL(join(root, "economy-engine", "live.mjs")).href;
await Promise.all(Array.from({ length: 6 }, (_, index) => new Promise((resolve, reject) => {
  const code = "import { LiveRegistry } from " + JSON.stringify(moduleUrl) + "; new LiveRegistry({ directory: " + JSON.stringify(concurrent) + " }).start({ session_id: 'parallel', agent_id: 'agent-" + index + "', agent_type: 'Explore' }, 'haiku');";
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { windowsHide: true, stdio: "pipe" });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  child.on("error", reject);
  child.on("exit", (status) => status === 0 ? resolve() : reject(new Error(errors)));
})));
assert.equal(Object.keys(new LiveRegistry({ directory: concurrent }).read().parallel).length, 6);
const admissionDir = dir("admission");
const admissions = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
  const code = "import { LiveRegistry } from " + JSON.stringify(moduleUrl) + "; console.log(new LiveRegistry({ directory: " + JSON.stringify(admissionDir) + " }).rememberRoute({ session_id: 'pending', tool_input: { subagent_type: 'Explore' } }, { cap: 4, model: 'haiku' }));";
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { windowsHide: true, stdio: "pipe" });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  child.on("error", reject);
  child.on("close", (status) => status === 0 ? resolve(output.trim() === "true") : reject(new Error(errors)));
})));
assert.equal(admissions.filter(Boolean).length, 4, "parallel launch reservations enforce the cap before SubagentStart");
const admission = new LiveRegistry({ directory: admissionDir });
const reserve = () => admission.rememberRoute({ session_id: "pending", tool_input: { subagent_type: "Explore" } }, { cap: 4, model: "haiku" });
admission.start({ session_id: "pending", agent_id: "started", agent_type: "Explore" }, "sonnet");
assert.equal(admission.read().pending.started.model, "haiku");
assert.equal(reserve(), false, "reservation conversion does not free a slot");
admission.stop({ session_id: "pending", agent_id: "started" });
assert.equal(reserve(), true);
const expiredAdmission = new LiveRegistry({ directory: admissionDir, clock: () => Date.now() + 181000 });
assert.equal(expiredAdmission.rememberRoute({ session_id: "pending", tool_input: { subagent_type: "Explore" } }, { cap: 4, model: "haiku" }), true, "cancelled launches release their reservation after expiry");

// Real hook process protocol uses an isolated HOME, never the owner's account.
const hookEnv = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: project };
const hook = (step, payload) => spawnSync(process.execPath, [join(root, "bin", "astack-economy-hook.mjs"), step], { encoding: "utf8", input: typeof payload === "string" ? payload : JSON.stringify(payload), env: hookEnv });
assert.equal(hook("route", "bad json").status, 0);
assert.equal(hook("route", "bad json").stdout, "");
assert.ok(existsSync(join(home, ".astack", "economy", "hook-errors.log")));
assert.equal(JSON.parse(hook("route", request).stdout).hookSpecificOutput.updatedInput.model, "haiku");
const captured = hook("statusline", { session_id: "isolated", rate_limits: { seven_day: { used_percentage: 75 } } });
assert.match(captured.stdout, /red/);
assert.equal(readJson(join(home, ".astack", "economy", "limits.json")).claude.rate_limits.seven_day.used_percentage, 75);
const handler = createMcpHandler({ run: async (args) => ({ ok: true, output: JSON.stringify(args) }) });
const reply = await handler({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "astack_delegate", arguments: { task: "--dangerous-looking task", schema_json: { type: "object" } } } });
assert.deepEqual(JSON.parse(reply.result.content[0].text).slice(-2), ["--", "--dangerous-looking task"]);
// Account-wide hooks: owner hooks and owner env kept, ours removed cleanly, projects with their own hooks win.
{
  const { planGlobalSettings, applyGlobalSettings, projectHasOwnHooks } = await import("../economy-engine/global.mjs");
  const owner = { hooks: { Stop: [{ hooks: [{ type: "command", command: "node owner-stop.mjs" }] }], PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node guard.mjs" }] }] }, env: { FOO: "1" } };
  const on = planGlobalSettings(owner, { hookPath: "C:\\Users\\x\\.astack\\core\\bin\\astack-economy-hook.mjs" });
  assert.equal(on.env.CLAUDE_CODE_SUBAGENT_MODEL, "sonnet");
  assert.equal(on.hooks.PreToolUse.length, 3);
  assert.ok(on.hooks.PreToolUse.some((group) => group.matcher === "Agent|Task" && /route --global$/.test(group.hooks[0].command)));
  assert.deepEqual(planGlobalSettings(on, { hookPath: "x/astack-economy-hook.mjs" }).hooks.SubagentStart.length, 1, "idempotent");
  const off = planGlobalSettings(on, { enable: false });
  assert.deepEqual(off, owner, "removal restores the owner's settings exactly");
  const chosen = planGlobalSettings({ env: { CLAUDE_CODE_SUBAGENT_MODEL: "opus" } }, { hookPath: "h/astack-economy-hook.mjs" });
  assert.equal(chosen.env.CLAUDE_CODE_SUBAGENT_MODEL, "opus", "an owner's own default model is kept");
  assert.equal(planGlobalSettings(chosen, { enable: false }).env.CLAUDE_CODE_SUBAGENT_MODEL, "opus", "and never removed");
  const globalHome = mkdtempSync(join(tmpdir(), "astack-economy-global-"));
  mkdirSync(join(globalHome, ".claude"), { recursive: true });
  writeFileSync(join(globalHome, ".claude", "settings.json"), JSON.stringify(owner));
  const applied = applyGlobalSettings({ home: globalHome, hookPath: "h/astack-economy-hook.mjs" });
  assert.ok(applied.backup && existsSync(applied.backup));
  const project = mkdtempSync(join(tmpdir(), "astack-economy-project-"));
  mkdirSync(join(project, ".claude"), { recursive: true });
  assert.equal(projectHasOwnHooks(project), false);
  writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify(on));
  assert.equal(projectHasOwnHooks(project), false, "global commands alone do not count");
  writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Agent|Task", hooks: [{ type: "command", command: "node \"$CLAUDE_PROJECT_DIR/bin/astack-economy-hook.mjs\" route" }] }] } }));
  assert.equal(projectHasOwnHooks(project), true);
}

console.log("AStack economy verification passed (policy, meter, limits, hooks, wiring, delegation, account-wide hooks).");
