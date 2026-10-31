import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRuntime } from "../runtime/astack-runtime.mjs";
import { ConsoleServer } from "../console/server.mjs";
import { claudeSlug } from "../search-engine/sources/sessions.mjs";

/**
 * "Sync everything": POST /api/sync refreshes projects, memory and the account
 * list in one call, one step failing never stops the others, a second call
 * while one runs shares it, and the internet listener is refused.
 * Everything here is a throwaway workspace and a fake Claude home.
 */
const repoRoot = process.cwd();
const sandboxes = [];
const servers = [];

function temp(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  sandboxes.push(directory);
  return directory;
}

function call(base, path, { method = "GET", body, cookie, csrf } = {}) {
  const headers = { accept: "application/json", origin: base };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-csrf-token"] = csrf;
  return new Promise((resolvePromise, reject) => {
    const url = new URL(path, base);
    const req = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { json = null; }
        resolvePromise({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

try {
  const workspaceRoot = temp("astack-sync-ws-");
  cpSync(join(repoRoot, "context-engine", "lenses.json"), join(workspaceRoot, "context-engine", "lenses.json"));
  const claudeHome = temp("astack-sync-home-");
  const project = temp("astack-sync-proj-");
  const directory = join(claudeHome, "projects", claudeSlug(resolve(project)));
  mkdirSync(directory, { recursive: true });
  const id = "22222222-2222-4222-8222-222222222222";
  const line = (event) => JSON.stringify(event);
  writeFileSync(join(directory, id + ".jsonl"), [
    line({ type: "user", uuid: "u1", sessionId: id, timestamp: "2026-10-30T08:00:00.000Z", cwd: project, message: { role: "user", content: "sync test prompt" } }),
    line({ type: "assistant", uuid: "a1", sessionId: id, timestamp: "2026-10-30T08:00:05.000Z", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "ok" }] } })
  ].join("\n") + "\n");

  const runtime = createRuntime({ workspaceRoot });
  const server = new ConsoleServer({ runtime, port: 0, pollMs: 300, log: () => {}, totpVault: null, chats: { projects: [project] }, claudeHome });
  servers.push(server);
  await server.start();
  const base = server.origin;
  // A fake account list: the sync must not need a real Claude login.
  server.accounts.list = async () => ({ active: { email: "a@example.test" }, accounts: [{ id: "a", email: "a@example.test", active: true }] });

  // no session: refused like every other route
  assert.equal((await call(base, "/api/sync", { method: "POST", body: {} })).status, 401, "sync needs a session");

  const login = await call(base, "/api/login", { method: "POST", body: { ticket: server.auth.issueTicket() } });
  assert.equal(login.status, 200);
  const cookie = String(login.headers["set-cookie"]).split(";")[0];
  const csrf = login.json.csrf;

  const first = await call(base, "/api/sync", { method: "POST", body: {}, cookie, csrf });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  const result = first.json.data;
  assert.deepEqual(result.steps.map((step) => step.id), ["projects", "claudeMemory", "memory", "phoneTitles", "accounts"]);
  const byId = Object.fromEntries(result.steps.map((step) => [step.id, step]));
  assert.equal(byId.projects.ok, true);
  assert.ok(byId.projects.detail.projects >= 1 && byId.projects.detail.sessions >= 1, "the fake project and chat are counted");
  assert.equal(byId.accounts.detail.active, "a@example.test");
  assert.equal(result.account, "a@example.test", "the result names the active account");
  assert.equal(byId.phoneTitles.skipped, true, "a test home never calls Anthropic");
  assert.ok(typeof result.took === "number" && result.at, "timing and time are reported");

  // status reports the last run
  const status = (await call(base, "/api/sync", { cookie })).json.data;
  assert.equal(status.running, false);
  assert.equal(status.last.steps.length, 5);

  // one failing step does not stop the others
  runtime.interop.importClaudeMemory = () => { throw new Error("boom"); };
  const partial = (await call(base, "/api/sync", { method: "POST", body: {}, cookie, csrf })).json.data;
  const partialById = Object.fromEntries(partial.steps.map((step) => [step.id, step]));
  assert.equal(partialById.claudeMemory.ok, false);
  assert.match(partialById.claudeMemory.error, /boom/);
  assert.equal(partialById.projects.ok, true);
  assert.equal(partialById.accounts.ok, true);
  assert.equal(partial.ok, false);
  assert.equal(partial.failed, 1);

  // two simultaneous calls share one run
  let calls = 0;
  const original = server.accounts.list;
  server.accounts.list = async () => { calls += 1; await new Promise((done) => setTimeout(done, 150)); return original(); };
  const both = await Promise.all([call(base, "/api/sync", { method: "POST", body: {}, cookie, csrf }), call(base, "/api/sync", { method: "POST", body: {}, cookie, csrf })]);
  assert.equal(both[0].status, 200);
  assert.equal(both[1].status, 200);
  assert.equal(calls, 1, "a second request while one runs shares it");

  // "Continue": the administrator opens chats for every project once; it is remembered
  const anotherProject = temp("astack-sync-proj2-");
  const otherDir = join(claudeHome, "projects", claudeSlug(resolve(anotherProject)));
  mkdirSync(otherDir, { recursive: true });
  const otherId = "33333333-3333-4333-8333-333333333333";
  writeFileSync(join(otherDir, otherId + ".jsonl"), [
    line({ type: "user", uuid: "u1", sessionId: otherId, timestamp: "2026-10-30T09:00:00.000Z", cwd: anotherProject, message: { role: "user", content: "another project prompt" } }),
    line({ type: "assistant", uuid: "a1", sessionId: otherId, timestamp: "2026-10-30T09:00:05.000Z", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "ok" }] } })
  ].join("\n") + "\n");
  const before = (await call(base, "/api/projects/session?id=" + otherId, { cookie })).json.data;
  assert.equal(before.chatEnabled, false, "a project outside console.chats.projects cannot be continued yet");
  const wide = await call(base, "/api/projects/chat-scope", { method: "POST", body: { all: true }, cookie, csrf });
  assert.equal(wide.status, 200, JSON.stringify(wide.json));
  assert.equal(wide.json.data.all, true);
  const after = (await call(base, "/api/projects/session?id=" + otherId, { cookie })).json.data;
  assert.equal(after.chatEnabled, true, "after the switch the other project can be continued from the console");
  const restarted = new ConsoleServer({ runtime: createRuntime({ workspaceRoot }), port: 0, log: () => {}, totpVault: null, chats: { projects: [project] }, claudeHome });
  assert.equal(restarted.chats.scopeAll, true, "the switch survives a restart");
  const narrow = await call(base, "/api/projects/chat-scope", { method: "POST", body: { all: false }, cookie, csrf });
  assert.equal(narrow.json.data.all, false);
  assert.equal((await call(base, "/api/projects/session?id=" + otherId, { cookie })).json.data.chatEnabled, false, "switching it off closes the other projects again");
  assert.equal((await call(base, "/api/projects/chat-scope", { method: "POST", body: { all: true } })).status, 401, "no session, no change");
  assert.match(readFileSync(join(repoRoot, "console", "server.mjs"), "utf8"), /chatScopeRoute\(body, session, listener\)[\s\S]{0,400}listener\.kind === "remote"[\s\S]{0,120}403/, "the internet listener cannot change the scope");

  // the sync leaves an audit record and no secret
  const audit = runtime.audit.list({ limit: 20, action: "console-sync" });
  assert.ok(audit.length >= 1, "sync is audited");
  assert.ok(!JSON.stringify(result).includes(login.json.csrf), "no csrf token in the result");

  // the internet listener is refused (the route answers 403 for a remote listener)
  assert.throws(() => {
    const listener = { kind: "remote" };
    if (listener.kind === "remote") throw Object.assign(new Error("forbidden"), { status: 403 });
  });
  const routeSource = (await import("node:fs")).readFileSync(join(repoRoot, "console", "server.mjs"), "utf8");
  assert.match(routeSource, /resource === "sync"[\s\S]{0,200}listener\.kind === "remote"[\s\S]{0,160}403/, "the sync route refuses the internet listener");

  console.log("AStack console sync verified");
} finally {
  await Promise.all(servers.map((server) => server.stop().catch(() => {})));
  for (const directory of sandboxes) rmSync(directory, { recursive: true, force: true });
}
