import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRuntime } from "../runtime/astack-runtime.mjs";
import { ConsoleServer } from "../console/server.mjs";
import { ConsoleOverview } from "../console/overview.mjs";
import { claudeSlug } from "../search-engine/sources/sessions.mjs";

/**
 * The dashboard's numbers: GET /api/overview. A fake Claude home with two
 * projects and recent transcripts that carry token usage and a model name; a
 * fake economy (usage limits) and a fake local model list, so nothing real is
 * read. The internet listener must not receive any project name.
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
  const workspaceRoot = temp("astack-overview-ws-");
  cpSync(join(repoRoot, "context-engine", "lenses.json"), join(workspaceRoot, "context-engine", "lenses.json"));
  const claudeHome = temp("astack-overview-home-");
  const now = Date.now();
  const iso = (offsetMs) => new Date(now - offsetMs).toISOString();
  const line = (event) => JSON.stringify(event);
  const projectNames = [];
  for (const [index, model] of [["a", "claude-opus-5-5"], ["b", "claude-sonnet-5-5"]]) {
    const folder = temp("astack-overview-proj-" + index + "-");
    projectNames.push(resolve(folder));
    const directory = join(claudeHome, "projects", claudeSlug(resolve(folder)));
    mkdirSync(directory, { recursive: true });
    const id = (index === "a" ? "55555555" : "66666666") + "-5555-4555-8555-555555555555";
    writeFileSync(join(directory, id + ".jsonl"), [
      line({ type: "user", uuid: "u1", sessionId: id, timestamp: iso(3600000), cwd: folder, message: { role: "user", content: "secret prompt " + index } }),
      line({ type: "assistant", uuid: "a1", sessionId: id, timestamp: iso(3500000), message: { id: "m-" + index, model, role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 4000, cache_creation_input_tokens: 200 } } })
    ].join("\n") + "\n");
  }

  const runtime = createRuntime({ workspaceRoot });
  const server = new ConsoleServer({ runtime, port: 0, pollMs: 300, log: () => {}, totpVault: null, claudeHome });
  servers.push(server);
  await server.start();
  const base = server.origin;
  // fakes: no real account, economy file or Ollama is read
  server.accounts.list = async () => ({ active: { email: "a@example.test" }, accounts: [] });
  server.overview = new ConsoleOverview(server, {
    economy: () => ({ config: {}, limits: { read: () => ({ claude: { rate_limits: { five_hour: { used_percentage: 33, resets_at: Math.floor(now / 1000) + 7200 }, seven_day: { used_percentage: 71, resets_at: Math.floor(now / 1000) + 86400 * 3 } }, capturedAt: now - 60000 }, codex: { rate_limits: { primary: { used_percent: 48, resets_at: Math.floor(now / 1000) + 86400 }, plan_type: "prolite" } } }) } }),
    localModelList: async () => ["qwen2.5:14b", "translategemma:4b"]
  });

  assert.equal((await call(base, "/api/overview")).status, 401, "the dashboard needs a session");
  const login = await call(base, "/api/login", { method: "POST", body: { ticket: server.auth.issueTicket() } });
  const cookie = String(login.headers["set-cookie"]).split(";")[0];

  const first = await call(base, "/api/overview", { cookie });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  const data = first.json.data;
  assert.equal(data.kpis.projects, 2);
  assert.equal(data.kpis.sessions, 2);
  assert.equal(data.tokensByDay.length, 7, "seven days of tokens");
  assert.equal(data.tokensByDay[6].input + data.tokensByDay[6].output, 3000, "today's input and output tokens of both chats are summed");
  assert.equal(data.kpis.tokens7d, 3000);
  assert.deepEqual(data.models.seen.map((entry) => entry.model).sort(), ["opus-5-5", "sonnet-5-5"], "models in use come from the chats");
  assert.deepEqual(data.models.local, ["qwen2.5:14b", "translategemma:4b"]);
  assert.equal(data.models.claude.fiveHour.pct, 33);
  assert.equal(data.models.claude.sevenDay.pct, 71);
  assert.equal(data.models.claude.stale, false);
  assert.equal(data.models.codex.pct, 48);
  assert.equal(data.models.account, "a@example.test");
  assert.equal(data.models.routes.search, "haiku");
  assert.ok(data.services.some((service) => service.id === "console" && service.state === "on"));
  assert.ok(data.services.some((service) => service.id === "ollama" && service.state === "on"));
  assert.equal(data.activityByDay.length, 7);
  assert.ok(data.topProjects.length === 2 && data.topProjects[0].tokens >= data.topProjects[1].tokens, "the busiest projects are listed");

  // a stale usage reading is flagged, not shown as current
  const staleOverview = new ConsoleOverview(server, { economy: () => ({ config: {}, limits: { read: () => ({ claude: { rate_limits: { five_hour: { used_percentage: 5, resets_at: 1 } }, capturedAt: now - 3 * 86400000 } }) } }), localModelList: async () => [] });
  assert.equal((await staleOverview.get()).models.claude.stale, true, "an old reading is marked stale");

  // one failing source does not break the page
  const broken = new ConsoleOverview(server, { economy: () => { throw new Error("boom"); }, localModelList: async () => { throw new Error("ollama down"); } });
  const partial = await broken.get();
  assert.equal(partial.kpis.projects, 2, "the rest of the dashboard still answers");
  assert.equal(partial.models.claude, null);
  assert.deepEqual(partial.models.local, []);

  // cached for a moment, and ?fresh=1 bypasses the cache
  const calls = { n: 0 };
  server.overview.economy = () => { calls.n += 1; return { config: {}, limits: { read: () => ({}) } }; };
  server.overview.cache = null;
  await call(base, "/api/overview", { cookie });
  await call(base, "/api/overview", { cookie });
  assert.equal(calls.n, 1, "the second call within 20 seconds is served from the cache");
  await call(base, "/api/overview?fresh=1", { cookie });
  assert.equal(calls.n, 2, "fresh=1 rebuilds");

  // the internet listener never gets a project name
  const remoteView = server.overview.privateView(data);
  assert.deepEqual(remoteView.topProjects, []);
  assert.equal(remoteView.private, true);
  assert.ok(!JSON.stringify(remoteView).includes("secret prompt"), "no prompt text in the overview");

  console.log("AStack console overview verified");
} finally {
  await Promise.all(servers.map((server) => server.stop().catch(() => {})));
  for (const directory of sandboxes) rmSync(directory, { recursive: true, force: true });
}
