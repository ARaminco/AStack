import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../runtime/astack-runtime.mjs";
import { ConsoleServer, isLoopback, resolveConsoleSettings } from "../console/server.mjs";
import { createService } from "../console/service.mjs";
import { confirmCode, isIrreversible, redactValue, SAFE_JOB_KINDS } from "../console/api.mjs";

const repoRoot = process.cwd();
const sandboxes = [];
function sandbox() {
  const directory = mkdtempSync(join(tmpdir(), "astack-console-"));
  sandboxes.push(directory);
  // The context engine reads its lenses from the workspace it is given.
  cpSync(join(repoRoot, "context-engine", "lenses.json"), join(directory, "context-engine", "lenses.json"));
  return directory;
}

const servers = [];
async function cleanup() {
  for (const server of servers) {
    await server.stop().catch(() => {});
  }
  for (const directory of sandboxes) {
    rmSync(directory, { recursive: true, force: true });
  }
}

function call(base, path, { method = "GET", body, cookie, csrf, origin, host } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-csrf-token"] = csrf;
  if (origin) headers.origin = origin;
  if (host) headers.host = host;
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const req = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

try {
  // ------------------------------------------------------------ pure helpers
  assert.equal(isLoopback("127.0.0.1"), true);
  assert.equal(isLoopback("localhost"), true);
  assert.equal(isLoopback("::1"), true);
  assert.equal(isLoopback("0.0.0.0"), false);
  const configOnly = resolveConsoleSettings({ host: "0.0.0.0" });
  assert.equal(configOnly.host, "127.0.0.1", "a non-loopback host from the config alone is refused");
  assert.ok(configOnly.warnings.length >= 1);
  const explicit = resolveConsoleSettings({}, { host: "0.0.0.0" });
  assert.equal(explicit.host, "0.0.0.0", "--host binds where the owner typed");
  assert.match(explicit.warnings.join(" "), /beyond|network|listening/i, "and prints a warning");
  assert.equal(resolveConsoleSettings({}).port, 7717);
  assert.equal(resolveConsoleSettings({ poll_interval: "2s" }).pollMs, 2000);
  assert.equal(isIrreversible({ action: "email.send", level: "L2" }), true);
  assert.equal(isIrreversible({ action: "report.draft", level: "L2" }), false);
  assert.equal(isIrreversible({ action: "report.draft", level: "L4" }), true, "L4 always needs the typed code");
  assert.equal(confirmCode("AP-12ab34cd"), "34CD");
  const masked = redactValue({ to: "a@example.com", password: "hunter22", card: "credential://bank/main", nested: { apiKey: "abcdef123456" } });
  assert.equal(masked.password, "[redacted]");
  assert.equal(masked.card, "credential://bank/main", "credential references are shown, never resolved");
  assert.equal(masked.nested.apiKey, "[redacted]");
  assert.ok(!SAFE_JOB_KINDS.includes("command") && !SAFE_JOB_KINDS.includes("browser-task"));

  // --------------------------------------------------------- live server
  const workspace = sandbox();
  const runtime = createRuntime({ workspaceRoot: workspace });
  const logs = [];
  const server = new ConsoleServer({ runtime, port: 0, pollMs: 300, log: (line) => logs.push(line) });
  servers.push(server);
  await server.start();
  const base = server.origin;
  assert.ok(existsSync(join(workspace, ".astack", "console", "token")), "the owner token is created on first start");
  assert.ok(existsSync(join(workspace, ".astack", "console", "server.json")));
  const token = readFileSync(join(workspace, ".astack", "console", "token"), "utf8").trim();
  assert.ok(token.length >= 40);

  // Static shell, manifest and service worker are public and carry the CSP.
  const shell = await call(base, "/");
  assert.equal(shell.status, 200);
  assert.match(shell.headers["content-type"], /text\/html/);
  assert.match(shell.headers["content-security-policy"], /default-src 'self'/);
  assert.match(shell.headers["content-security-policy"], /script-src 'self'(;|$)/, "no inline or remote scripts");
  assert.equal(shell.headers["x-frame-options"], "DENY");
  assert.ok(!/__BUILD__/.test(shell.text), "the build stamp is filled in");
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(shell.text), "the shell loads nothing from another origin");
  const manifest = await call(base, "/manifest.webmanifest");
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers["content-type"], /manifest\+json/);
  assert.equal(manifest.json.name, "Aramin");
  assert.equal(manifest.json.short_name, "Aramin");
  assert.equal(manifest.json.display, "standalone");
  assert.ok(manifest.json.icons.some((icon) => icon.sizes === "512x512"));
  const worker = await call(base, "/sw.js");
  assert.equal(worker.status, 200);
  assert.match(worker.headers["content-type"], /javascript/);
  assert.match(worker.text, /startsWith\("\/api\/"\)/, "the service worker never touches API responses");
  assert.ok(!/__BUILD__/.test(worker.text));
  for (const asset of ["/app.js", "/app.css", "/boot.js", "/icons/icon-192.png", "/icons/icon-512.png", "/fonts/vazirmatn-variable.woff2", "/fonts/OFL.txt"]) {
    assert.equal((await call(base, asset)).status, 200, asset);
  }
  const traversal = await call(base, "/..%2F..%2Fpackage.json");
  assert.ok(!/"name": "astack-enterprise"/.test(traversal.text), "no path traversal out of console/public");

  // DNS rebinding: a foreign Host header is refused on a loopback bind.
  assert.equal((await call(base, "/api/health", { host: "evil.example:" + server.port })).status, 421);

  // Auth required everywhere under /api except health, i18n, session and login.
  assert.equal((await call(base, "/api/home")).status, 401);
  assert.equal((await call(base, "/api/approvals")).status, 401);
  assert.equal((await call(base, "/api/events")).status, 401);
  assert.equal((await call(base, "/api/health")).status, 200);
  const i18n = await call(base, "/api/i18n?lang=fa");
  assert.equal(i18n.json.meta.direction, "rtl");
  assert.equal(i18n.json.strings.brand, "آرامین");
  assert.equal((await call(base, "/api/i18n?lang=en")).json.strings.brand, "Aramin");
  assert.equal((await call(base, "/api/session")).json.authenticated, false);

  // Login: wrong token refused, cross-origin refused, right token gives a strict cookie.
  assert.equal((await call(base, "/api/login", { method: "POST", body: { token: "ar_wrong" }, origin: base })).status, 401);
  assert.equal((await call(base, "/api/login", { method: "POST", body: { token }, origin: "http://evil.example" })).status, 403);
  const login = await call(base, "/api/login", { method: "POST", body: { token }, origin: base });
  assert.equal(login.status, 200);
  const setCookie = String(login.headers["set-cookie"]);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(";")[0];
  const csrf = login.json.csrf;
  assert.ok(csrf && csrf.length >= 20);
  assert.ok(!logs.some((line) => line.includes(token)), "the token is never logged");
  const sessionsFile = readFileSync(join(workspace, ".astack", "console", "sessions.json"), "utf8");
  assert.ok(!sessionsFile.includes(cookie.split("=")[1]), "only hashes of session ids reach the disk");
  const session = await call(base, "/api/session", { cookie });
  assert.equal(session.json.authenticated, true);
  assert.equal(session.json.csrf, csrf);

  // One-time ticket (astack console start --open): works once.
  const ticket = server.auth.issueTicket();
  assert.equal((await call(base, "/api/login", { method: "POST", body: { ticket }, origin: base })).status, 200);
  assert.equal((await call(base, "/api/login", { method: "POST", body: { ticket }, origin: base })).status, 401, "a ticket is single use");

  // Every read endpoint answers; optional engines degrade to "not installed".
  for (const path of ["/api/home", "/api/approvals?state=all", "/api/missions", "/api/jobs", "/api/hooks", "/api/audit", "/api/memory", "/api/memory/stats", "/api/memory/entity?q=acme", "/api/skills", "/api/system", "/api/search?q=test", "/api/notifications", "/api/counts"]) {
    const response = await call(base, path, { cookie });
    assert.equal(response.status, 200, path + " " + response.text.slice(0, 200));
    assert.equal(response.json.ok, true, path);
  }
  // Optional engines: present ones report installed, absent ones degrade.
  const has = (name) => Boolean(runtime[name]);
  const runsData = (await call(base, "/api/runs", { cookie })).json.data;
  if (has("runner")) assert.equal(runsData.installed, true);
  else assert.deepEqual(runsData, { installed: false, items: [] });
  assert.equal((await call(base, "/api/board", { cookie })).json.data.installed, has("board"));
  assert.equal((await call(base, "/api/gateway", { cookie })).json.data.installed, has("gateway"));
  assert.equal((await call(base, "/api/skills", { cookie })).json.data.hub.installed, has("skillHub"));
  const system = (await call(base, "/api/system", { cookie })).json.data;
  assert.equal(system.features.runner, has("runner"));
  assert.equal(system.features.gateway, has("gateway"));
  assert.equal(system.console.loopback, true);
  assert.ok(system.services.find((entry) => entry.id === "console").present);
  const dryRun = await call(base, "/api/runs", { method: "POST", body: { objective: "test", dryRun: true }, cookie, csrf, origin: base });
  if (has("runner")) assert.ok(dryRun.status < 500, "a dry run with the runner answers " + dryRun.status + " " + dryRun.text.slice(0, 200));
  else assert.equal(dryRun.status, 404, "no runner, no runs");
  assert.equal((await call(base, "/api/nope", { cookie })).status, 404);

  // SSE: an approval requested anywhere reaches the stream.
  const events = [];
  const stream = await new Promise((resolve, reject) => {
    const url = new URL("/api/events", base);
    const req = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname, headers: { cookie, accept: "text/event-stream" } }, (res) => {
      assert.equal(res.statusCode, 200);
      assert.match(res.headers["content-type"], /text\/event-stream/);
      res.setEncoding("utf8");
      res.on("data", (chunk) => events.push(chunk));
      resolve({ req, res });
    });
    req.on("error", reject);
    req.end();
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(events.join("").includes("event: hello"), "the stream greets with the current counts");

  // Approvals: approve (typed confirmation for irreversible) and deny, through the real engine.
  const send = runtime.approvals.request({ action: "email.send", summary: "Send the quote", parameters: { to: "client@example.com", password: "secret-value-1" }, level: "L4", target: "client@example.com", requestedBy: "test" });
  const publish = runtime.approvals.request({ action: "blog.publish", summary: "Publish the post", parameters: { slug: "post" }, level: "L3", requestedBy: "test" });
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && !(events.join("").includes("event: notification") && events.join("").includes(send.id))) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const streamed = events.join("");
  assert.ok(streamed.includes("event: activity") && streamed.includes("approval.requested"), "bus events are forwarded");
  assert.ok(streamed.includes("event: notification") && streamed.includes(send.id), "a new approval becomes a notification");

  const pending = (await call(base, "/api/approvals", { cookie })).json.data;
  assert.equal(pending.pending, 2);
  const listed = pending.items.find((item) => item.id === send.id);
  assert.equal(listed.action, "email.send");
  assert.equal(listed.target, "client@example.com");
  assert.equal(listed.parameters.to, "client@example.com", "exact values are shown");
  assert.equal(listed.parameters.password, "[redacted]", "secrets are masked");
  assert.equal(listed.irreversible, true);
  assert.equal(listed.confirmCode, confirmCode(send.id));
  assert.equal(listed.risk, "high");

  const decide = (id, body, extra = {}) => call(base, "/api/approvals/" + id + "/decide", { method: "POST", body, cookie, origin: base, ...extra });
  assert.equal((await decide(send.id, { decision: "approve", confirm: listed.confirmCode })).status, 403, "CSRF is enforced on writes");
  assert.equal((await decide(send.id, { decision: "approve", confirm: listed.confirmCode }, { csrf: "wrong" })).status, 403);
  assert.equal((await decide(send.id, { decision: "approve", confirm: listed.confirmCode }, { csrf, origin: "http://evil.example" })).status, 403, "cross-origin writes are refused");
  const noCode = await decide(send.id, { decision: "approve" }, { csrf });
  assert.equal(noCode.status, 422, "irreversible approvals need the typed code");
  assert.equal(runtime.approvals.get(send.id).state, "pending", "nothing changed without the code");
  assert.equal((await decide(send.id, { decision: "maybe" }, { csrf })).status, 400);
  const approved = await decide(send.id, { decision: "approve", confirm: listed.confirmCode.toLowerCase(), note: "ok from test" }, { csrf });
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.json.data.state, "approved");
  assert.match(approved.json.data.receipt.id, /^RC-/);
  assert.equal(approved.json.data.decidedBy, "owner@console");
  const engineRecord = runtime.approvals.get(send.id);
  assert.equal(engineRecord.state, "approved");
  assert.equal(engineRecord.decidedBy, "owner@console");
  assert.equal(engineRecord.receipt.approvedBy, "owner@console");
  assert.ok(runtime.audit.list({ action: "approval-granted" }).some((entry) => entry.actor === "owner@console" && entry.result === engineRecord.receipt.id), "the decision is audited");
  assert.equal((await decide(send.id, { decision: "deny" }, { csrf })).status, 409, "a decision is final");

  const denied = await decide(publish.id, { decision: "deny", note: "not now" }, { csrf });
  assert.equal(denied.status, 200);
  assert.equal(denied.json.data.state, "rejected");
  assert.equal(runtime.approvals.get(publish.id).state, "rejected");
  assert.equal(runtime.approvals.get(publish.id).note, "not now");
  assert.equal((await call(base, "/api/approvals", { cookie })).json.data.pending, 0);
  assert.equal((await decide("AP-missing", { decision: "deny" }, { csrf })).status, 404);

  // Missions: pause, resume (continues the run), cancel.
  const mission = runtime.missions.create({ title: "Console mission", steps: [{ title: "first" }, { title: "second" }] });
  const paused = await call(base, "/api/missions/" + mission.id + "/pause", { method: "POST", body: { reason: "hold" }, cookie, csrf, origin: base });
  assert.equal(paused.status, 200);
  assert.equal(runtime.missions.get(mission.id).state, "paused");
  const resumed = await call(base, "/api/missions/" + mission.id + "/resume", { method: "POST", body: {}, cookie, csrf, origin: base });
  assert.equal(resumed.status, 200);
  for (let i = 0; i < 30 && runtime.missions.get(mission.id).state !== "completed"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(runtime.missions.get(mission.id).state, "completed", "resume continues the mission like the CLI");
  assert.equal((await call(base, "/api/missions/" + mission.id + "/cancel", { method: "POST", body: {}, cookie, csrf, origin: base })).status, 409);
  const other = runtime.missions.create({ title: "Cancel me", steps: [{ title: "only" }] });
  assert.equal((await call(base, "/api/missions/" + other.id + "/cancel", { method: "POST", body: { reason: "no" }, cookie, csrf, origin: base })).status, 200);
  assert.equal(runtime.missions.get(other.id).state, "cancelled");
  const detail = (await call(base, "/api/missions/" + mission.id, { cookie })).json.data;
  assert.equal(detail.stepList.length, 2);
  assert.ok(detail.timeline.some((event) => event.event === "paused"));
  assert.ok(runtime.audit.list({ action: "mission-paused" }).some((entry) => entry.actor === "owner@console"));

  // Jobs: only safe kinds run from the console.
  runtime.scheduler.create({ id: "beat", name: "Heartbeat", kind: "heartbeat", schedule: { every: "10m" } });
  runtime.scheduler.create({ id: "shell", name: "Shell", kind: "command", schedule: { every: "10m" }, payload: { command: "node", args: ["-v"] } });
  const ran = await call(base, "/api/jobs/beat/run", { method: "POST", body: {}, cookie, csrf, origin: base });
  assert.equal(ran.status, 200, ran.text);
  assert.equal(ran.json.data.status, "ok");
  assert.equal((await call(base, "/api/jobs/shell/run", { method: "POST", body: {}, cookie, csrf, origin: base })).status, 403, "command jobs never start from a tap");
  const jobs = (await call(base, "/api/jobs", { cookie })).json.data;
  assert.equal(jobs.items.find((job) => job.id === "shell").runnable, false);

  // Hooks never expose their secret or token.
  runtime.signals.create({ name: "Form", source: "generic" });
  const hooks = (await call(base, "/api/hooks", { cookie })).json;
  const hookJson = JSON.stringify(hooks);
  const hookRecord = runtime.signals.get("form");
  assert.ok(!hookJson.includes(hookRecord.secret) && !hookJson.includes(hookRecord.token), "hook secrets stay on the server");

  // Audit paging and filters.
  const audit = (await call(base, "/api/audit?size=5&page=1", { cookie })).json.data;
  assert.equal(audit.items.length, 5);
  assert.ok(audit.pages >= 2);
  const filtered = (await call(base, "/api/audit?action=approval-granted", { cookie })).json.data;
  assert.ok(filtered.items.length >= 1 && filtered.items.every((entry) => entry.action === "approval-granted"));

  // Memory and the palette.
  runtime.memory.remember("preference", { title: "Reports in short Persian lines", tags: ["reporting"] });
  const memory = (await call(base, "/api/memory?q=reports", { cookie })).json.data;
  assert.equal(memory.engine, "memory");
  assert.ok(memory.items.some((item) => /Persian/.test(item.title)));
  const search = (await call(base, "/api/search?q=console", { cookie })).json.data;
  assert.ok(search.missions.some((entry) => entry.id === mission.id));

  // Logout ends the session.
  assert.equal((await call(base, "/api/logout", { method: "POST", body: {}, cookie, csrf, origin: base })).status, 200);
  assert.equal((await call(base, "/api/home", { cookie })).status, 401);

  stream.req.destroy();

  // ----------------------------------------- optional engines when present
  const workspace2 = sandbox();
  const runtime2 = createRuntime({ workspaceRoot: workspace2 });
  const runs = [];
  runtime2.runner = {
    async execute({ objective, dryRun, source }) {
      const run = { id: "R-" + (runs.length + 1), objective, source, status: dryRun ? "dry-run" : "completed", summary: dryRun ? "plan: 2 steps" : "done", output: dryRun ? "1. read\n2. draft" : "ok", approvals: [] };
      if (!dryRun) runs.push(run);
      return run;
    },
    list() {
      return runs;
    },
    get(id) {
      return runs.find((run) => run.id === id) ?? null;
    },
    status() {
      return { running: 0, queued: 0, budgetLeft: 3 };
    }
  };
  runtime2.gateway = { status: () => ({ channels: ["telegram"], connected: true, token: "should-not-leak" }) };
  // The real runtime exposes board through a getter; replace it with a fake.
  Object.defineProperty(runtime2, "board", { configurable: true, value: { status: () => ({ columns: ["todo", "doing", "done"] }), list: () => [{ id: "C1", title: "Card", column: "todo" }] } });
  const service = createService({ runtime: runtime2, config: { port: 0 }, log: () => {} });
  assert.equal(service.name, "console");
  await service.start();
  const status = service.status();
  assert.equal(status.running, true);
  assert.equal(status.loopback, true);
  const base2 = status.url;
  const token2 = readFileSync(join(workspace2, ".astack", "console", "token"), "utf8").trim();
  const login2 = await call(base2, "/api/login", { method: "POST", body: { token: token2 }, origin: base2 });
  const cookie2 = String(login2.headers["set-cookie"]).split(";")[0];
  const csrf2 = login2.json.csrf;
  const features = (await call(base2, "/api/session", { cookie: cookie2 })).json.features;
  assert.equal(features.runner, true);
  assert.equal(features.gateway, true);
  assert.equal(features.board, true);
  const gateway = (await call(base2, "/api/gateway", { cookie: cookie2 })).json.data;
  assert.equal(gateway.installed, true);
  assert.equal(gateway.status.token, "[redacted]");
  const board = (await call(base2, "/api/board", { cookie: cookie2 })).json.data;
  assert.deepEqual(board.columns, ["todo", "doing", "done"]);
  assert.equal(board.cards[0].title, "Card");
  const post = (body) => call(base2, "/api/runs", { method: "POST", body, cookie: cookie2, csrf: csrf2, origin: base2 });
  const blind = await post({ objective: "Draft the weekly report", dryRun: false });
  assert.equal(blind.status, 428, "a real run needs a dry run first");
  const preview = await post({ objective: "Draft the weekly report", dryRun: true });
  assert.equal(preview.status, 200);
  assert.equal(preview.json.data.result.status, "dry-run");
  assert.equal((await post({ objective: "Something else", dryRun: false, previewId: preview.json.data.previewId })).status, 428, "the preview covers that objective only");
  const real = await post({ objective: "Draft the weekly report", dryRun: false, previewId: preview.json.data.previewId });
  assert.equal(real.status, 200, real.text);
  assert.equal(real.json.data.result.status, "completed");
  assert.equal((await post({ objective: "Draft the weekly report", dryRun: false, previewId: preview.json.data.previewId })).status, 428, "a preview is spent by one run");
  const runList = (await call(base2, "/api/runs", { cookie: cookie2 })).json.data;
  assert.equal(runList.installed, true);
  assert.equal(runList.items.length, 1);
  assert.equal(runList.status.budgetLeft, 3);
  assert.ok(runtime2.audit.list({ action: "console-run-started" }).length === 1);
  await service.stop();
  assert.equal(service.status().running, false);

  console.log("AStack console (Aramin) verification passed");
} finally {
  await cleanup();
}
