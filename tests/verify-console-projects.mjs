import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRuntime } from "../runtime/astack-runtime.mjs";
import { ConsoleServer } from "../console/server.mjs";
import { HttpError } from "../console/api.mjs";
import { ProjectsError, ProjectsHub, privateProject } from "../console/projects.mjs";

const repoRoot = process.cwd();
const sandboxes = [];
const servers = [];
function sandbox(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  sandboxes.push(directory);
  return directory;
}

// ------------------------------------------------------------------ fixtures
const NOW = new Date("2026-10-31T12:00:00.000Z");
const clock = () => new Date(NOW.getTime());
const FAKE_KEY = "sk-ant-api03-" + "abcdefghijklmnopqrstuvwx1234567890";
const FAKE_TOKEN = "fake-oauth-value-for-tests-only-" + "0123456789";

const S_ASTACK = "11111111-1111-4111-8111-111111111111";
const S_OWNER = "22222222-2222-4222-8222-222222222222";
const S_SUMMARY = "33333333-3333-4333-8333-333333333333";
const S_PROMPT = "44444444-4444-4444-8444-444444444444";
const S_BIG = "55555555-5555-4555-8555-555555555555";
const S_EMPTY = "66666666-6666-4666-8666-666666666666";
const S_BETA = "77777777-7777-4777-8777-777777777777";
const AGENT = "agent-abc123def";

const L = (record) => JSON.stringify(record) + "\n";
const ctx = (sessionId, cwd, ts, branch = "main") => ({ sessionId, cwd, timestamp: ts, gitBranch: branch, isSidechain: false });
const userLine = (sessionId, cwd, ts, text, extra = {}) => L({ type: "user", ...ctx(sessionId, cwd, ts), message: { role: "user", content: text }, ...extra });
const toolLine = (sessionId, cwd, ts, size = 900) => L({ type: "user", ...ctx(sessionId, cwd, ts), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "x".repeat(size) }] } });
function assistantLine(sessionId, cwd, ts, { text = "ok", id, model = "claude-test-1", usage = [0, 0, 0, 0], sidechain = false, branch = "main" } = {}) {
  const [input, output, cacheRead, cacheWrite] = usage;
  return L({
    type: "assistant",
    ...ctx(sessionId, cwd, ts, branch),
    isSidechain: sidechain,
    message: { model, id, role: "assistant", content: [{ type: "text", text }], usage: { input_tokens: input, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead, output_tokens: output } }
  });
}
const touch = (path, date) => utimesSync(path, date, date);
// A JSON line of exactly n bytes (newline included) that is not a chat record.
const padLine = (n) => {
  const base = '{"type":"queue-operation","pad":""}' + String.fromCharCode(10);
  const at = base.indexOf('"pad":"') + 7;
  return base.slice(0, at) + "x".repeat(n - Buffer.byteLength(base)) + base.slice(at);
};
function miniHome(slug, cwd) {
  const home = sandbox("astack-projects-mini-");
  const dir = join(home, "projects", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: FAKE_TOKEN, expiresAt: Date.parse("2030-01-01T00:00:00Z") } }));
  return { home, dir, cwd, alphaCwd: cwd };
}
const ago = (seconds) => new Date(NOW.getTime() - seconds * 1000);

function buildHome() {
  const home = sandbox("astack-projects-home-");
  const alphaCwd = "/work/alpha";
  const betaCwd = "/work/beta";
  const alpha = join(home, "projects", "C--tmp-alpha");
  const beta = join(home, "projects", "C--tmp-beta");
  mkdirSync(alpha, { recursive: true });
  mkdirSync(beta, { recursive: true });
  writeFileSync(join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: FAKE_TOKEN, expiresAt: Date.parse("2030-01-01T00:00:00Z") } }));

  // S_ASTACK: AI title only (renamed later), usage lines, a phone (Remote Control) link, sub-agents.
  writeFileSync(join(alpha, S_ASTACK + ".jsonl"),
    L({ type: "queue-operation", operation: "enqueue", timestamp: "2026-10-30T08:00:00.000Z", sessionId: S_ASTACK }) +
    userLine(S_ASTACK, alphaCwd, "2026-10-30T08:00:01.000Z", "Fix the login page redirect") +
    assistantLine(S_ASTACK, alphaCwd, "2026-10-31T09:00:00.000Z", { id: "msg_1", usage: [100, 50, 1000, 200] }) +
    L({ type: "ai-title", aiTitle: "AI generated title one", sessionId: S_ASTACK }) +
    L({ type: "bridge-session", bridgeSessionId: "cse_AbCdEf1234567890", sessionId: S_ASTACK }) +
    userLine(S_ASTACK, alphaCwd, "2026-10-31T09:01:00.000Z", "Now the logout button") +
    assistantLine(S_ASTACK, alphaCwd, "2026-10-30T10:00:00.000Z", { id: "msg_2", usage: [10, 5, 0, 0] }) +
    assistantLine(S_ASTACK, alphaCwd, "2026-10-30T10:00:01.000Z", { id: "msg_2", usage: [20, 8, 0, 0] }) +
    assistantLine(S_ASTACK, alphaCwd, "2026-10-10T10:00:00.000Z", { id: "msg_old", usage: [999, 999, 999, 999] }) +
    userLine(S_ASTACK, alphaCwd, "2026-10-31T11:59:00.000Z", "Third request"));
  const subagents = join(alpha, S_ASTACK, "subagents");
  mkdirSync(subagents, { recursive: true });
  writeFileSync(join(subagents, AGENT + "9.jsonl"), assistantLine(S_ASTACK, alphaCwd, "2026-10-31T09:30:00.000Z", { id: "msg_sub", usage: [1, 2, 3, 4], sidechain: true }));
  writeFileSync(join(subagents, AGENT + "9.meta.json"), JSON.stringify({ agentType: "Explore", description: "look around the repo" }));

  // S_OWNER: a custom-title AStack never wrote.
  writeFileSync(join(alpha, S_OWNER + ".jsonl"),
    userLine(S_OWNER, alphaCwd, "2026-10-29T08:00:00.000Z", "Plan the release") +
    assistantLine(S_OWNER, alphaCwd, "2026-10-29T08:00:05.000Z", { model: "claude-owner-2" }) +
    L({ type: "ai-title", aiTitle: "AI title that loses", sessionId: S_OWNER }) +
    L({ type: "custom-title", customTitle: "Owner chosen name", sessionId: S_OWNER }));

  // S_SUMMARY: Claude's summary beats its generated title.
  writeFileSync(join(alpha, S_SUMMARY + ".jsonl"),
    L({ type: "summary", summary: "Summary of the migration chat", leafUuid: "x" }) +
    L({ type: "ai-title", aiTitle: "Generated migration title", sessionId: S_SUMMARY }) +
    userLine(S_SUMMARY, alphaCwd, "2026-10-28T08:00:00.000Z", "Migrate the database") +
    assistantLine(S_SUMMARY, alphaCwd, "2026-10-28T08:00:09.000Z"));

  // S_PROMPT: no title at all; the first prompt (cleaned, redacted) is the title.
  writeFileSync(join(alpha, S_PROMPT + ".jsonl"),
    userLine(S_PROMPT, alphaCwd, "2026-10-27T08:00:00.000Z", "<system-reminder>ignore me</system-reminder>use this key " + FAKE_KEY + " for the deploy") +
    assistantLine(S_PROMPT, alphaCwd, "2026-10-27T08:00:09.000Z"));

  // S_BIG: ~3 MB, a rename 700 KB before the end (outside the tail window), a poisoned middle.
  const bigParts = [
    userLine(S_BIG, alphaCwd, "2026-10-20T08:00:00.000Z", "BIGHEAD first prompt of the large chat", { gitBranch: "feature/big" }),
    assistantLine(S_BIG, alphaCwd, "2026-10-20T08:00:05.000Z", { model: "claude-old-model" })
  ];
  let bytes = 0;
  const filler = () => {
    const line = toolLine(S_BIG, alphaCwd, "2026-10-21T08:00:00.000Z", 2000) + userLine(S_BIG, alphaCwd, "2026-10-21T08:00:01.000Z", "MIDDLE-POISON prompt") + assistantLine(S_BIG, alphaCwd, "2026-10-21T08:00:02.000Z", { text: "y".repeat(1500), model: "claude-middle-model" });
    bytes += Buffer.byteLength(line);
    return line;
  };
  while (bytes < 2400 * 1024) {
    bigParts.push(filler());
  }
  bigParts.push(L({ type: "custom-title", customTitle: "Big custom title", sessionId: S_BIG }));
  const beforeTail = bytes;
  while (bytes - beforeTail < 700 * 1024) {
    bigParts.push(filler());
  }
  bigParts.push(userLine(S_BIG, alphaCwd, "2026-10-30T07:00:00.000Z", "tail prompt", { gitBranch: "feature/tail" }));
  bigParts.push(assistantLine(S_BIG, alphaCwd, "2026-10-30T07:00:05.000Z", { model: "claude-tail-model", branch: "feature/tail" }));
  writeFileSync(join(alpha, S_BIG + ".jsonl"), bigParts.join(""));

  // Only queue operations: not a chat. A top-level agent (sidechain) file.
  writeFileSync(join(alpha, S_EMPTY + ".jsonl"), L({ type: "queue-operation", operation: "enqueue", timestamp: "2026-10-26T08:00:00.000Z", sessionId: S_EMPTY }));
  writeFileSync(join(alpha, AGENT + ".jsonl"), L({ type: "user", ...ctx(S_ASTACK, alphaCwd, "2026-10-30T08:10:00.000Z"), isSidechain: true, message: { role: "user", content: "sub task for the agent" } }));

  writeFileSync(join(beta, S_BETA + ".jsonl"),
    userLine(S_BETA, betaCwd, "2026-10-25T08:00:00.000Z", "beta only prompt") +
    assistantLine(S_BETA, betaCwd, "2026-10-25T08:00:09.000Z"));

  // Distinct, ordered modification times (newest first: ASTACK live, OWNER, SUMMARY, PROMPT, BIG).
  const order = [[S_ASTACK, ago(30)], [S_OWNER, ago(3600)], [S_SUMMARY, ago(7200)], [S_PROMPT, ago(10800)], [S_BIG, ago(14400)], [S_EMPTY, ago(20000)]];
  for (const [id, date] of order) {
    touch(join(alpha, id + ".jsonl"), date);
  }
  touch(join(alpha, AGENT + ".jsonl"), ago(5000));
  touch(join(subagents, AGENT + "9.jsonl"), ago(40));
  touch(join(beta, S_BETA + ".jsonl"), ago(90000));
  return { home, alpha, beta, alphaCwd, betaCwd, subagents };
}

function newHub(fixture, extra = {}) {
  const state = (fixture.state ??= sandbox("astack-projects-state-"));
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ?? null, auth: init.headers?.Authorization ?? null });
    if (String(url).includes("/v1/code/sessions?")) {
      return { status: 200, json: async () => ({ data: [{ id: "cse_AbCdEf1234567890" }] }) };
    }
    return { status: 200, json: async () => ({}) };
  };
  const hub = new ProjectsHub({
    claudeHome: fixture.home,
    metaPath: join(state, "console", "projects-meta.json"),
    clock,
    chatProjects: () => [resolve(fixture.alphaCwd)],
    titlesHome: state,
    titlesRoot: join(state, "session-titles"),
    fetchImpl,
    ...extra
  });
  return { hub, calls, state };
}

function call(base, path, { method = "GET", body, cookie, csrf, origin } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-csrf-token"] = csrf;
  if (origin) headers.origin = origin;
  return new Promise((resolvePromise, reject) => {
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
        resolvePromise({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function rejects(promise, status) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ProjectsError || error instanceof HttpError, "typed error, got " + error);
    assert.equal(error.status, status, error.message);
    return error;
  }
  assert.fail("expected a " + status + " refusal");
}

try {
  const fixture = buildHome();
  const everything = [];
  const keep = (value) => {
    everything.push(JSON.stringify(value));
    return value;
  };
  const { hub, calls, state } = newHub(fixture);
  const alphaId = "c--tmp-alpha";
  const betaId = "c--tmp-beta";
  assert.ok(statSync(join(fixture.alpha, S_BIG + ".jsonl")).size > 3 * 1024 * 1024, "the large transcript is over 3 MB");

  // ===================================================== projects (listing)
  const projects = keep(hub.projects());
  assert.deepEqual(projects.map((project) => project.id).sort(), [alphaId, betaId], "every project folder is listed");
  const alpha = projects.find((project) => project.id === alphaId);
  const beta = projects.find((project) => project.id === betaId);
  assert.equal(alpha.name, "alpha", "the real working folder name comes from the transcripts' cwd");
  assert.equal(alpha.path, fixture.alphaCwd);
  assert.equal(alpha.chatEnabled, true, "chatEnabled follows console.chats.projects");
  assert.equal(beta.chatEnabled, false);
  assert.equal(alpha.live, 1, "one alpha transcript was written in the last two minutes");
  assert.equal(beta.live, 0);
  assert.equal(alpha.updatedAt, ago(30).toISOString());
  assert.equal(projects[0].id, alphaId, "newest project first");
  assert.equal(alpha.pinned, false);

  // ======================================================= sessions (list)
  const list = keep(hub.sessions({ project: alphaId }));
  assert.equal(list.total, 5, "five real chats: the empty file and the agent file are left out");
  assert.deepEqual(list.items.map((item) => item.id), [S_ASTACK, S_OWNER, S_SUMMARY, S_PROMPT, S_BIG], "newest first");
  const byId = Object.fromEntries(list.items.map((item) => [item.id, item]));
  assert.equal(byId[S_ASTACK].title, "AI generated title one");
  assert.equal(byId[S_ASTACK].titleSource, "ai");
  assert.equal(byId[S_ASTACK].live, true);
  assert.equal(byId[S_ASTACK].hasSubagents, true);
  assert.equal(byId[S_ASTACK].turns, 3);
  assert.equal(byId[S_ASTACK].turnsApprox, false);
  assert.equal(byId[S_ASTACK].model, "claude-test-1");
  assert.equal(byId[S_ASTACK].gitBranch, "main");
  assert.equal(byId[S_ASTACK].firstPrompt, "Fix the login page redirect");
  assert.equal(byId[S_ASTACK].startedAt, "2026-10-30T08:00:01.000Z", "the queue operation is not the start of the chat");
  assert.equal(byId[S_ASTACK].chatEnabled, true);
  assert.equal(byId[S_ASTACK].project, alphaId);
  assert.equal(byId[S_OWNER].title, "Owner chosen name", "a custom title beats the generated one");
  assert.equal(byId[S_OWNER].titleSource, "owner");
  assert.equal(byId[S_OWNER].model, "claude-owner-2");
  assert.equal(byId[S_OWNER].live, false);
  assert.equal(byId[S_SUMMARY].title, "Summary of the migration chat", "Claude's summary beats its generated title");
  assert.equal(byId[S_SUMMARY].titleSource, "summary");
  assert.equal(byId[S_PROMPT].titleSource, "prompt");
  assert.ok(byId[S_PROMPT].title.startsWith("use this key"), "injected reminder blocks are cleaned from the first prompt: " + byId[S_PROMPT].title);

  // Large transcript: head and tail only; the rename 700 KB before the end is still found.
  const big = byId[S_BIG];
  assert.equal(big.title, "Big custom title", "a title older than the tail window is found by the bounded look-back");
  assert.equal(big.titleSource, "owner");
  assert.equal(big.firstPrompt, "BIGHEAD first prompt of the large chat");
  assert.equal(big.model, "claude-tail-model", "model and branch come from the tail");
  assert.equal(big.gitBranch, "feature/tail");
  assert.equal(big.turnsApprox, true, "turns of a large file are an estimate from the head and tail");
  assert.ok(big.turns > 2, "estimate counts the sampled prompts");
  assert.ok(big.sizeBytes > 3 * 1024 * 1024);
  assert.ok(!JSON.stringify(list).includes("MIDDLE-POISON"), "the middle of a large file is never read into the list");
  assert.equal(big.startedAt, "2026-10-20T08:00:00.000Z");

  // Agent files and empty chats only on request.
  const withSide = keep(hub.sessions({ project: alphaId, sidechains: "1", size: 100 }));
  const agentItem = withSide.items.find((item) => item.id === AGENT);
  assert.ok(agentItem, "the agent file is listed with sidechains=1");
  assert.equal(agentItem.sidechain, true);
  assert.equal(agentItem.parent, S_ASTACK, "its parent session is derived from the transcript");
  assert.equal(withSide.items.some((item) => item.id === S_EMPTY), false, "an empty file is never a chat");

  // Detail with resume info and sub-agents.
  const detail = keep(hub.session(S_ASTACK));
  assert.deepEqual(detail.resume, { command: "claude --resume " + S_ASTACK, cwd: fixture.alphaCwd });
  assert.equal(detail.subagents.length, 1);
  assert.equal(detail.subagents[0].type, "Explore");
  assert.equal(detail.subagents[0].description, "look around the repo");
  await rejects(Promise.resolve().then(() => hub.session("99999999-9999-4999-8999-999999999999")), 404);
  await rejects(Promise.resolve().then(() => hub.session("../../etc/passwd")), 400);
  await rejects(Promise.resolve().then(() => hub.sessions({ project: "../x" })), 400);
  await rejects(Promise.resolve().then(() => hub.sessions({ project: "nope" })), 404);

  // ============================================================ search/sort
  assert.deepEqual(hub.sessions({ project: alphaId, q: "migrate" }).items.map((item) => item.id), [S_SUMMARY], "search reads the first prompt");
  assert.deepEqual(hub.sessions({ project: alphaId, q: "AI GENERATED" }).items.map((item) => item.id), [S_ASTACK], "case-insensitive title search");
  assert.deepEqual(hub.sessions({ q: "beta" }).items.map((item) => item.id), [S_BETA], "search without a project spans all projects and matches the project name");
  assert.equal(hub.sessions({ q: "alpha" }).total, 5, "the project name matches every session of it");
  assert.equal(hub.sessions({ project: alphaId, q: "no-such-words-anywhere" }).total, 0);
  assert.deepEqual(hub.sessions({ project: alphaId, sort: "turns" }).items[0].id, S_BIG, "sort by turns (large file estimate is the highest)");
  assert.deepEqual(hub.sessions({ project: alphaId, sort: "started" }).items.map((item) => item.id)[0], S_ASTACK, "sort by start time: newest start first");
  assert.deepEqual(hub.sessions({ project: alphaId, live: "1" }).items.map((item) => item.id), [S_ASTACK]);
  assert.equal(hub.sessions({ project: alphaId, live: "0" }).total, 4);
  const paged = hub.sessions({ project: alphaId, size: 2, page: 2 });
  assert.deepEqual([paged.page, paged.pages, paged.total, paged.items.length], [2, 3, 5, 2]);
  assert.equal(paged.items[0].id, S_SUMMARY);

  // ==================================== pin / archive / tags (persistence)
  keep(hub.setSessionMeta(S_PROMPT, { pinned: true, tags: ["Deploy", "urgent", "deploy"] }));
  keep(hub.setSessionMeta(S_SUMMARY, { archived: true }));
  const afterMeta = keep(hub.sessions({ project: alphaId }));
  assert.equal(afterMeta.items[0].id, S_PROMPT, "pinned sessions come first");
  assert.deepEqual(afterMeta.items[0].tags, ["Deploy", "urgent"], "tags are de-duplicated without case");
  assert.equal(afterMeta.total, 4, "archived sessions are hidden by default");
  assert.deepEqual(hub.sessions({ project: alphaId, archived: "1" }).items.map((item) => item.id), [S_SUMMARY]);
  assert.deepEqual(hub.sessions({ project: alphaId, pinned: "1" }).items.map((item) => item.id), [S_PROMPT]);
  assert.deepEqual(hub.sessions({ project: alphaId, tag: "DEPLOY" }).items.map((item) => item.id), [S_PROMPT], "tag filter ignores case");
  assert.deepEqual(hub.sessions({ project: alphaId, q: "urgent" }).items.map((item) => item.id), [S_PROMPT], "search reads tags");
  assert.equal(hub.sessions({ project: alphaId, tag: "missing" }).total, 0);
  // A second hub on the same file sees everything: the store is on disk.
  const reopened = newHub(fixture).hub;
  assert.equal(reopened.sessions({ project: alphaId }).items[0].id, S_PROMPT);
  assert.deepEqual(reopened.sessions({ project: alphaId, archived: "1" }).items.map((item) => item.id), [S_SUMMARY]);
  const metaPath = join(state, "console", "projects-meta.json");
  const stored = JSON.parse(readFileSync(metaPath, "utf8"));
  assert.deepEqual(stored.sessions[S_PROMPT], { pinned: true, tags: ["Deploy", "urgent"] });
  assert.deepEqual(readdirSync(join(state, "console")), ["projects-meta.json"], "writes are atomic: no temporary file is left");
  keep(hub.setSessionMeta(S_SUMMARY, { archived: false }));
  keep(hub.setSessionMeta(S_PROMPT, { pinned: false, tags: [] }));
  assert.deepEqual(JSON.parse(readFileSync(metaPath, "utf8")).sessions, {}, "an entry with nothing set is dropped");
  await rejects(Promise.resolve().then(() => hub.setSessionMeta(S_PROMPT, { tags: ["x".repeat(40)] })), 400);
  await rejects(Promise.resolve().then(() => hub.setSessionMeta(S_PROMPT, { tags: Array.from({ length: 13 }, (_, i) => "t" + i) })), 400);
  await rejects(Promise.resolve().then(() => hub.setSessionMeta("99999999-9999-4999-8999-999999999999", { pinned: true })), 404);

  // Project metadata.
  const pinnedBeta = keep(hub.setProjectMeta(betaId, { pinned: true, label: "Beta product", color: "#ff8800" }));
  assert.equal(pinnedBeta.pinned, true);
  assert.equal(pinnedBeta.label, "Beta product");
  assert.equal(hub.projects()[0].id, betaId, "a pinned project is listed first");
  assert.equal(newHub(fixture).hub.projects()[0].color, "#ff8800", "project metadata persists");
  await rejects(Promise.resolve().then(() => hub.setProjectMeta(betaId, { color: "javascript:alert(1)" })), 400);
  await rejects(Promise.resolve().then(() => hub.setProjectMeta(betaId, { label: "l".repeat(80) })), 400);
  await rejects(Promise.resolve().then(() => hub.setProjectMeta("nope", { pinned: true })), 404);
  keep(hub.setProjectMeta(betaId, { pinned: false, label: "", color: "" }));
  assert.deepEqual(JSON.parse(readFileSync(metaPath, "utf8")).projects, {});

  // ======================================================= rename (titles)
  const before = statSync(join(fixture.alpha, S_ASTACK + ".jsonl"));
  await rejects(hub.rename(S_ASTACK, "ab"), 400);
  await rejects(hub.rename(S_ASTACK, "my key is " + FAKE_KEY), 400);
  await rejects(hub.rename(AGENT, "A title for an agent"), 400);
  const renamed = keep(await hub.rename(S_ASTACK, "نوبت‌گیر · بررسی نقشه سایت"));
  assert.equal(renamed.rename.status, "renamed");
  assert.equal(renamed.title, "نوبت‌گیر · بررسی نقشه سایت");
  assert.equal(renamed.titleSource, "astack", "a title written through the engine is an AStack title");
  assert.match(readFileSync(join(fixture.alpha, S_ASTACK + ".jsonl"), "utf8"), /"type":"custom-title","sessionId":"11111111-1111-4111-8111-111111111111","customTitle":"نوبت‌گیر · بررسی نقشه سایت"/, "the rename is a custom-title record in the transcript, as Claude Code writes it");
  assert.equal(statSync(join(fixture.alpha, S_ASTACK + ".jsonl")).mtimeMs, before.mtimeMs, "a rename does not count as activity");
  const history = readFileSync(join(state, "session-titles", "history.jsonl"), "utf8").trim().split("\n").map((row) => JSON.parse(row));
  assert.equal(history.length, 1);
  assert.equal(history[0].id, S_ASTACK);
  assert.equal(history[0].oldTitle, "AI generated title one");
  assert.equal(history[0].runtime, "console");
  assert.equal(hub.sessions({ project: alphaId, q: "نوبتگیر" }).items[0]?.id, S_ASTACK, "search folds the Persian half-space");
  // The phone copy is updated through the title engine (fake fetch, fake sign-in).
  const put = calls.find((entry) => entry.method === "PUT");
  assert.ok(put, "the Remote Control copy is renamed too");
  assert.match(put.url, /\/v1\/code\/sessions\/cse_AbCdEf1234567890$/);
  assert.equal(JSON.parse(put.body).title, "نوبت‌گیر · بررسی نقشه سایت");
  assert.equal(renamed.rename.remote.pushed, 1);
  assert.equal(JSON.stringify(renamed).includes(FAKE_TOKEN), false, "the sign-in token never reaches a result");
  const again = await hub.rename(S_ASTACK, "نوبت‌گیر · بررسی نقشه سایت");
  assert.equal(again.rename.status, "unchanged");
  // session_titles.sync_remote: false — a console rename makes no call to Anthropic at all.
  const offline = newHub(fixture, { titlesConfig: { sync_remote: false } });
  const quiet = await offline.hub.rename(S_SUMMARY, "Migration chat, renamed offline");
  assert.equal(quiet.rename.status, "renamed");
  assert.equal(quiet.rename.remote, null);
  assert.equal(offline.calls.length, 0, "the owner's sync_remote opt-out sends nothing, not even the session list request");

  // ================================================================== usage
  const usage = keep(await hub.usage({ project: alphaId }));
  assert.equal(usage.days.length, 7);
  assert.equal(usage.days.at(-1).date, "2026-10-31");
  assert.equal(usage.days[0].date, "2026-10-25");
  assert.deepEqual(usage.days.at(-1), { date: "2026-10-31", input: 101, output: 52, cacheRead: 1003, cacheWrite: 204 }, "main chat + sub-agent tokens of the day");
  assert.deepEqual(usage.days.at(-2), { date: "2026-10-30", input: 20, output: 8, cacheRead: 0, cacheWrite: 0 }, "a streamed message counts once, with its last usage");
  assert.deepEqual(usage.total, { input: 121, output: 60, cacheRead: 1003, cacheWrite: 204 }, "tokens older than seven days are not summed");
  assert.equal(usage.days.filter((day) => day.input).length, 2);
  // Append-only growth is picked up incrementally.
  appendFileSync(join(fixture.alpha, S_ASTACK + ".jsonl"), assistantLine(S_ASTACK, fixture.alphaCwd, "2026-10-31T11:58:00.000Z", { id: "msg_3", usage: [7, 3, 0, 0] }));
  touch(join(fixture.alpha, S_ASTACK + ".jsonl"), ago(30));
  const grown = await hub.usage({ project: alphaId });
  assert.deepEqual(grown.total, { input: 128, output: 63, cacheRead: 1003, cacheWrite: 204 });
  const betaUsage = await hub.usage({ project: betaId });
  assert.equal(betaUsage.total.input, 0, "an old transcript adds nothing to the week");
  await rejects(hub.usage({ project: "nope" }), 404);

  // ============================================================ redaction
  assert.ok(byId[S_PROMPT].firstPrompt.includes("[redacted"), "a key in a prompt is masked");
  const all = everything.join("\n") + JSON.stringify(hub.sessions({ project: alphaId, size: 100, sidechains: "1" }));
  assert.equal(all.includes(FAKE_KEY), false, "no result carries the key");
  assert.equal(all.includes("abcdefghijklmnopqrstuvwx1234567890"), false);
  assert.equal(all.includes(FAKE_TOKEN), false);
  assert.equal(all.includes("ignore me"), false, "injected reminder text is stripped");

  // ============================== caches follow the disk and stay small
  {
    const entryOfAstack = hub.usageFiles.get(join(fixture.alpha, S_ASTACK + ".jsonl"));
    assert.ok(entryOfAstack, "the scanned transcript is cached for incremental reads");
    assert.ok([...entryOfAstack.messages.values()].every((message) => message.day >= "2026-10-25"), "days that left the seven-day window are not kept");
    const stale = join(fixture.alpha, S_OWNER + ".jsonl");
    touch(stale, new Date(NOW.getTime() - 20 * 86400000));
    await hub.usage({ project: alphaId });
    assert.equal(hub.usageFiles.has(stale), false, "a transcript that left the window is forgotten");
    touch(stale, ago(3600));
  }

  // ====================== project and session counts follow the list rules
  {
    const mini = miniHome("C--tmp-count", "/work/count");
    const A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
    const B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
    const E = "eeeeeeee-3333-4333-8333-eeeeeeeeeeee";
    const SIDE = "cccccccc-4444-4444-8444-cccccccccccc";
    const ARCH = "dddddddd-5555-4555-8555-dddddddddddd";
    writeFileSync(join(mini.dir, A + ".jsonl"), userLine(A, mini.cwd, "2026-10-30T08:00:00.000Z", "first real chat") + assistantLine(A, mini.cwd, "2026-10-30T08:00:05.000Z"));
    writeFileSync(join(mini.dir, ARCH + ".jsonl"), userLine(ARCH, mini.cwd, "2026-10-29T08:00:00.000Z", "archived chat") + assistantLine(ARCH, mini.cwd, "2026-10-29T08:00:05.000Z"));
    writeFileSync(join(mini.dir, E + ".jsonl"), L({ type: "queue-operation", operation: "enqueue", timestamp: "2026-10-28T08:00:00.000Z", sessionId: E }));
    writeFileSync(join(mini.dir, SIDE + ".jsonl"), L({ type: "user", ...ctx(SIDE, mini.cwd, "2026-10-28T09:00:00.000Z"), isSidechain: true, message: { role: "user", content: "side task" } }));
    for (const id of [A, ARCH, E, SIDE]) touch(join(mini.dir, id + ".jsonl"), ago(7200));
    const counting = newHub(mini).hub;
    counting.setSessionMeta(ARCH, { archived: true });
    const projectId = "c--tmp-count";
    const badge = () => counting.projects().find((project) => project.id === projectId).sessions;
    assert.equal(badge(), 1, "before any list is opened the badge already ignores empty, sidechain and archived files");
    assert.equal(counting.sessions({ project: projectId }).total, 1);
    assert.equal(badge(), counting.sessions({ project: projectId }).total, "the badge equals the list total after the list is opened");
    // A started session appears in the badge at once: the cache key (mtime, size) is checked.
    appendFileSync(join(mini.dir, E + ".jsonl"), userLine(E, mini.cwd, "2026-10-31T11:00:00.000Z", "now a real prompt") + assistantLine(E, mini.cwd, "2026-10-31T11:00:02.000Z"));
    touch(join(mini.dir, E + ".jsonl"), ago(10));
    assert.equal(badge(), 2, "a file that became a chat is counted without reopening the list");
    assert.equal(badge(), counting.sessions({ project: projectId }).total);
    counting.setSessionMeta(ARCH, { archived: false });
    assert.equal(badge(), 3);
    assert.equal(badge(), counting.sessions({ project: projectId }).total);
  }

  // ======================== a nested "summary" object must not hide a message
  {
    const mini = miniHome("C--tmp-nested", "/work/nested");
    const N = "99999999-aaaa-4aaa-8aaa-999999999999";
    writeFileSync(join(mini.dir, N + ".jsonl"),
      userLine(N, mini.cwd, "2026-10-30T09:00:00.000Z", "hello nested") +
      L({ type: "assistant", ...ctx(N, mini.cwd, "2026-10-30T10:00:00.000Z", "feat-nested"), message: { model: "claude-nested", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Task", input: { type: "summary", text: "x" } }] } }) +
      L({ type: "user", ...ctx(N, mini.cwd, "2026-10-30T10:00:05.000Z", "feat-nested"), toolUseResult: { type: "ai-title", aiTitle: "nested not a title" }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] } }) +
      L({ type: "ai-title", aiTitle: "Real generated title", sessionId: N }) +
      L({ type: "summary", summary: "Real top-level summary", leafUuid: "z" }));
    const raw = newHub(mini).hub.summarize({ path: join(mini.dir, N + ".jsonl"), directory: mini.dir, id: N, agent: false, stat: statSync(join(mini.dir, N + ".jsonl")) });
    assert.equal(raw.model, "claude-nested", "the assistant line with a nested summary object is counted");
    assert.equal(raw.lastAt, "2026-10-30T10:00:05.000Z");
    assert.equal(raw.gitBranch, "feat-nested");
    assert.equal(raw.empty, false);
    assert.equal(raw.aiTitle, "Real generated title", "a nested ai-title object is not a title, the real record is");
    assert.equal(raw.summary, "Real top-level summary", "a real top-level summary record still sets the summary");
    assert.equal(raw.turns, 1);
    // Hand-formatted JSON ("type": "user") is read too.
    const SP = "88888888-aaaa-4aaa-8aaa-888888888888";
    const spaced = (record) => JSON.stringify(record).replace(/"(type|sessionId)":"/g, '"$1": "');
    writeFileSync(join(mini.dir, SP + ".jsonl"),
      spaced({ type: "user", ...ctx(SP, mini.cwd, "2026-10-30T09:00:00.000Z"), message: { role: "user", content: "spaced prompt" } }) + "\n" +
      spaced({ type: "assistant", ...ctx(SP, mini.cwd, "2026-10-30T09:00:03.000Z"), message: { model: "claude-spaced", role: "assistant", content: [] } }) + "\n");
    const listed = newHub(mini).hub.sessions({ project: "c--tmp-nested" }).items.find((item) => item.id === SP);
    assert.equal(listed?.firstPrompt, "spaced prompt");
    assert.equal(listed?.turns, 1);
    assert.equal(listed?.model, "claude-spaced");
  }

  // ======= head/tail seams: no line is lost and an exact count stays exact
  {
    const mini = miniHome("C--tmp-seam", "/work/seam");
    const S = "77777777-bbbb-4bbb-8bbb-777777777777";
    const small = (index) => userLine(S, mini.cwd, "2026-10-30T09:00:00.000Z", "q" + String(index).padStart(6, "0"));
    const lineLength = Buffer.byteLength(small(0));
    const bigLine = (x) => userLine(S, mini.cwd, "2026-10-29T09:00:00.000Z", "P".repeat(x));
    const overhead = Buffer.byteLength(bigLine(0));
    const window = 4 * 128 * 1024;
    // x makes the first line end exactly where a whole number of small lines ends on the 512 KB window edge.
    const aligned = 200 * 1024 + ((((window - overhead - 200 * 1024) % lineLength) + lineLength) % lineLength);
    for (const [name, x] of [["on a line boundary", aligned], ["one byte into a line", aligned + 1], ["in the middle of a line", aligned + Math.floor(lineLength / 2)]]) {
      const count = Math.ceil((window - Buffer.byteLength(bigLine(x))) / lineLength) + 400;
      let text = bigLine(x);
      for (let index = 0; index < count; index += 1) text += small(index);
      const path = join(mini.dir, S + ".jsonl");
      writeFileSync(path, text);
      const raw = newHub(mini).hub.summarize({ path, directory: mini.dir, id: S, agent: false, stat: statSync(path) });
      assert.ok(statSync(path).size > window, "the head window is widened to 512 KB: " + name);
      assert.equal(raw.turnsApprox, false, "head and tail meet: " + name);
      assert.equal(raw.turns, count + 1, "every prompt is counted once, none lost on the seam: " + name);
    }
    // A custom title straddling the point where the tail window starts is found whole.
    const TITLE = L({ type: "custom-title", customTitle: "Seam owner title", sessionId: S });
    const titleBytes = Buffer.byteLength(TITLE);
    const first = userLine(S, mini.cwd, "2026-10-29T09:00:00.000Z", "seam first prompt");
    const filler = padLine(500);
    const after = 500;
    const last = padLine(262144 + 10 - titleBytes - 500 * (after - 1));
    const path = join(mini.dir, S + ".jsonl");
    writeFileSync(path, first + filler.repeat(600) + TITLE + filler.repeat(after - 1) + last);
    const stat = statSync(path);
    const titleStart = Buffer.byteLength(first) + 500 * 600;
    assert.equal(stat.size - 262144, titleStart + 10, "the tail window starts ten bytes into the title record");
    const found = newHub(mini).hub.summarize({ path, directory: mini.dir, id: S, agent: false, stat });
    assert.equal(found.customTitle, "Seam owner title", "a title record on the head/tail seam is not lost");
    assert.equal(found.firstPrompt, "seam first prompt");
    // And on the boundary between two one-megabyte look-back blocks.
    const end = 2_248_576;
    const seam = end - 1024 * 1024;
    const prefixLength = seam - 10;
    const parts = [];
    let length = 0;
    const push = (text) => {
      parts.push(text);
      length += Buffer.byteLength(text);
    };
    while (prefixLength - length > 540) push(padLine(500));
    push(padLine(prefixLength - length));
    push(TITLE);
    while (end - length > 540) push(padLine(500));
    push(padLine(end - length));
    assert.equal(length, end);
    writeFileSync(path, parts.join(""));
    const back = newHub(mini).hub.titlesBefore({ path, agent: false }, end, 0);
    assert.equal(back.customTitle, "Seam owner title", "a title record on a look-back block seam is not lost");
  }

  // ======= a first line larger than the 2 MB head window (pasted screenshot)
  {
    const mini = miniHome("C--tmp-bigline", "/work/bigline");
    const G = "66666666-cccc-4ccc-8ccc-666666666666";
    const image = L({ type: "user", ...ctx(G, mini.cwd, "2026-10-20T08:00:00.000Z"), message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(2_500_000) } }, { type: "text", text: "why is this button broken" }] } });
    let text = image + assistantLine(G, mini.cwd, "2026-10-20T08:00:05.000Z") + L({ type: "ai-title", aiTitle: "Fix broken button", sessionId: G });
    for (let index = 0; index < 20; index += 1) text += userLine(G, mini.cwd, "2026-10-21T08:00:00.000Z", "later " + index) + assistantLine(G, mini.cwd, "2026-10-21T08:00:01.000Z");
    const path = join(mini.dir, G + ".jsonl");
    writeFileSync(path, text);
    const raw = newHub(mini).hub.summarize({ path, directory: mini.dir, id: G, agent: false, stat: statSync(path) });
    assert.equal(raw.firstPrompt, "why is this button broken");
    assert.equal(raw.startedAt, "2026-10-20T08:00:00.000Z");
    assert.equal(raw.turns, 21, "the screenshot prompt and the 20 later ones");
    assert.equal(raw.turnsApprox, false);
    assert.equal(raw.aiTitle, "Fix broken button");
    // The same, with a long chat after it: the first prompt and start time still come from the big line.
    let longer = text;
    for (let index = 0; index < 3000; index += 1) longer += userLine(G, mini.cwd, "2026-10-22T08:00:00.000Z", "again " + index) + assistantLine(G, mini.cwd, "2026-10-22T08:00:01.000Z");
    writeFileSync(path, longer);
    const rawLong = newHub(mini).hub.summarize({ path, directory: mini.dir, id: G, agent: false, stat: statSync(path) });
    assert.equal(rawLong.firstPrompt, "why is this button broken");
    assert.equal(rawLong.startedAt, "2026-10-20T08:00:00.000Z");
    assert.equal(rawLong.aiTitle, "Fix broken button");
    assert.ok(rawLong.turns > 2000 && rawLong.turns < 4000, "the long chat is estimated from the rest, not from the screenshot's bytes: " + rawLong.turns);
  }

  // ============ the cache keeps a short first prompt, not a whole pasted log
  {
    const mini = miniHome("C--tmp-pasted", "/work/pasted");
    const P = "55555555-dddd-4ddd-8ddd-555555555555";
    const path = join(mini.dir, P + ".jsonl");
    writeFileSync(path, userLine(P, mini.cwd, "2026-10-30T09:00:00.000Z", "start " + "log line ".repeat(180000)) + assistantLine(P, mini.cwd, "2026-10-30T09:00:05.000Z"));
    const pasted = newHub(mini).hub;
    const raw = pasted.summarize({ path, directory: mini.dir, id: P, agent: false, stat: statSync(path) });
    assert.ok(raw.firstPrompt.length <= 400, "cached first prompt is cut: " + raw.firstPrompt.length);
    assert.ok(pasted.sessions({ project: "c--tmp-pasted" }).items[0].firstPrompt.startsWith("start log line"));
    assert.equal(pasted.summaries.size, 1);
    rmSync(path);
    assert.equal(pasted.sessions({ project: "c--tmp-pasted" }).total, 0);
    assert.equal(pasted.summaries.size, 0, "the summary of a deleted transcript is forgotten");
  }

  // =============== a cold listing does not freeze the server (warm-up slices)
  {
    const mini = miniHome("C--tmp-cold", "/work/cold");
    const base = userLine("x", mini.cwd, "2026-10-30T09:00:00.000Z", "cold start prompt") + padLine(1000).repeat(1000) + assistantLine("x", mini.cwd, "2026-10-30T09:10:00.000Z");
    for (let index = 0; index < 120; index += 1) {
      const id = String(index).padStart(8, "0") + "-eeee-4eee-8eee-eeeeeeeeeeee";
      writeFileSync(join(mini.dir, id + ".jsonl"), base);
    }
    const cold = newHub(mini).hub;
    let worst = 0;
    let previous = performance.now();
    const ticker = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - previous - 5);
      previous = now;
    }, 5);
    previous = performance.now();
    const started = performance.now();
    const built = await cold.warm();
    const warmMs = performance.now() - started;
    clearInterval(ticker);
    assert.equal(built, 120, "every transcript was summarised");
    assert.equal(cold.sessions({}).total, 120);
    assert.ok(worst < 150, "the event loop was never held for long while warming (worst gap " + Math.round(worst) + " ms of " + Math.round(warmMs) + " ms)");
    assert.equal(await cold.warm(), 0, "nothing is read twice");
  }

  // ===================== a failed or blocked meta write never looks saved
  {
    const mini = miniHome("C--tmp-meta", "/work/meta");
    const M = "44444444-eeee-4eee-8eee-444444444444";
    const OTHER = "33333333-ffff-4fff-8fff-333333333333";
    for (const id of [M, OTHER]) {
      writeFileSync(join(mini.dir, id + ".jsonl"), userLine(id, mini.cwd, "2026-10-30T09:00:00.000Z", "meta chat " + id.slice(0, 4)) + assistantLine(id, mini.cwd, "2026-10-30T09:00:05.000Z"));
    }
    const { hub: locked, state: lockedState } = newHub(mini);
    locked.setSessionMeta(M, { tags: ["first"] });
    const metaFile = join(lockedState, "console", "projects-meta.json");
    const before = readFileSync(metaFile, "utf8");
    locked.renameImpl = () => {
      throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
    };
    assert.throws(() => locked.setSessionMeta(M, { pinned: true }), /EPERM/, "the failure reaches the caller");
    assert.equal(locked.session(M).pinned, false, "memory is unchanged after a failed write");
    assert.equal(readFileSync(metaFile, "utf8"), before, "the file is unchanged");
    assert.deepEqual(readdirSync(join(lockedState, "console")), ["projects-meta.json"], "no temporary file is left behind");
    assert.throws(() => locked.setProjectMeta("c--tmp-meta", { pinned: true }), /EPERM/);
    assert.equal(locked.projects().find((project) => project.id === "c--tmp-meta").pinned, false);
    // A lock that lasts a moment is retried.
    let attempts = 0;
    locked.renameImpl = (from, to) => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      renameSync(from, to);
    };
    assert.equal(locked.setSessionMeta(M, { pinned: true }).pinned, true);
    assert.equal(attempts, 3, "the rename is retried until the file is free");
    assert.deepEqual(readdirSync(join(lockedState, "console")), ["projects-meta.json"]);

    // An unreadable store is never silently replaced by an empty one.
    const good = { version: 1, sessions: { [M]: { pinned: true, tags: ["keep"] } }, projects: { "c--tmp-meta": { label: "Client X" } } };
    const variants = [
      ["a trailing comma", JSON.stringify(good).replace(/\}$/, ",}")],
      ["a truncated file", JSON.stringify(good).slice(0, 40)],
      ["sessions as a list", JSON.stringify({ version: 1, sessions: [1, 2], projects: {} })],
      ["a bare list", "[]"]
    ];
    for (const [name, content] of variants) {
      const damaged = newHub(mini);
      const damagedFile = join(damaged.state, "console", "projects-meta.json");
      mkdirSync(join(damaged.state, "console"), { recursive: true });
      for (const old of readdirSync(join(damaged.state, "console"))) rmSync(join(damaged.state, "console", old), { force: true });
      writeFileSync(damagedFile, content);
      damaged.hub.setSessionMeta(OTHER, { pinned: true });
      const copies = readdirSync(join(damaged.state, "console")).filter((file) => file.includes(".corrupt-"));
      assert.equal(copies.length, 1, "one copy of the unreadable file is kept: " + name);
      assert.equal(readFileSync(join(damaged.state, "console", copies[0]), "utf8"), content, "the copy has the original bytes: " + name);
      assert.equal(damaged.hub.session(OTHER).pinned, true, "the new write itself works: " + name);
      damaged.hub.setSessionMeta(OTHER, { pinned: false });
      assert.equal(readdirSync(join(damaged.state, "console")).filter((file) => file.includes(".corrupt-")).length, 1, "once repaired, no more copies: " + name);
    }
    // A byte order mark from an editor is not damage: the data is kept and nothing is copied aside.
    const bom = newHub(mini);
    mkdirSync(join(bom.state, "console"), { recursive: true });
    for (const old of readdirSync(join(bom.state, "console"))) rmSync(join(bom.state, "console", old), { force: true });
    writeFileSync(join(bom.state, "console", "projects-meta.json"), "\uFEFF" + JSON.stringify(good));
    bom.hub.setSessionMeta(OTHER, { pinned: true });
    const kept = JSON.parse(readFileSync(join(bom.state, "console", "projects-meta.json"), "utf8"));
    assert.deepEqual(kept.sessions[M], { pinned: true, tags: ["keep"] }, "pins and tags survive a file with a byte order mark");
    assert.equal(kept.projects["c--tmp-meta"].label, "Client X");
    assert.equal(readdirSync(join(bom.state, "console")).some((file) => file.includes(".corrupt-")), false);

    // Wrong types are refused, not stored as text.
    await rejects(Promise.resolve().then(() => hub.setSessionMeta(S_PROMPT, { tags: { a: 1 } })), 400);
    await rejects(Promise.resolve().then(() => hub.setSessionMeta(S_PROMPT, { tags: [{}, {}] })), 400);
    await rejects(Promise.resolve().then(() => hub.setSessionMeta(S_PROMPT, { tags: [1, true] })), 400);
    await rejects(Promise.resolve().then(() => hub.setSessionMeta(S_PROMPT, { pinned: "banana" })), 400);
    await rejects(Promise.resolve().then(() => hub.setProjectMeta(betaId, { label: {} })), 400);
    await rejects(Promise.resolve().then(() => hub.setProjectMeta(betaId, { color: {} })), 400);
    await rejects(Promise.resolve().then(() => hub.setProjectMeta(betaId, { pinned: [] })), 400);
    assert.deepEqual(hub.setSessionMeta(S_PROMPT, { tags: "a, b" }).tags, ["a", "b"], "a comma string is still a list of tags");
    hub.setSessionMeta(S_PROMPT, { tags: null });
    assert.equal(hub.session(S_PROMPT).tags.length, 0);
  }

  // ============ a folder name that is not in the id stays on this machine
  {
    const folder = "پرونده طالبی";
    const mini = miniHome("C--Users-USER-Desktop------------", "C:/Users/USER/Desktop/" + folder);
    const R = "22222222-aaaa-4aaa-8aaa-222222222222";
    writeFileSync(join(mini.dir, R + ".jsonl"), userLine(R, mini.cwd, "2026-10-30T09:00:00.000Z", "client matter") + assistantLine(R, mini.cwd, "2026-10-30T09:00:05.000Z"));
    const owner = newHub(mini).hub;
    const [project] = owner.projects();
    assert.equal(project.name, folder, "the owner sees the folder name");
    const seen = privateProject(project);
    assert.equal(seen.name, project.id, "over the internet the name is the id when the owner set no label");
    assert.equal(JSON.stringify(seen).includes(folder), false);
    assert.equal(privateProject({ ...project, label: "Matter 7" }).name, "Matter 7", "or the owner's own label");
    const remote = owner.sessions({ project: project.id }, { privateView: true });
    assert.equal(remote.items[0].projectName, project.id);
    assert.equal(remote.items[0].titleSource, null);
    assert.equal(JSON.stringify(remote).includes(folder), false);
    assert.equal(owner.sessions({ q: "طالبی" }).total, 1, "the owner can search by folder name");
    assert.equal(owner.sessions({ q: "طالبی" }, { privateView: true }).total, 0, "a remote search cannot probe the folder name");
    assert.equal(owner.sessions({ q: "client matter" }, { privateView: true }).total, 0);
    assert.equal(owner.sessions({ q: R.slice(0, 8) }, { privateView: true }).total, 1, "search by id still works remotely");
  }

  // ================================== server: endpoints, listener refusal
  const workspace = sandbox("astack-projects-ws-");
  cpSync(join(repoRoot, "context-engine", "lenses.json"), join(workspace, "context-engine", "lenses.json"), { recursive: true });
  const runtime = createRuntime({ workspaceRoot: workspace });
  const logs = [];
  const server = new ConsoleServer({ runtime, port: 0, pollMs: 300, log: (line) => logs.push(line), claudeHome: fixture.home, chats: { projects: [fixture.alphaCwd] } });
  servers.push(server);
  await server.start();
  const base = server.origin;
  assert.equal((await call(base, "/api/projects")).status, 401, "the hub needs the console session");
  const token = readFileSync(join(workspace, ".astack", "console", "token"), "utf8").trim();
  const login = await call(base, "/api/login", { method: "POST", body: { token }, origin: base });
  assert.equal(login.status, 200);
  const cookie = String(login.headers["set-cookie"]).split(";")[0];
  const csrf = login.json.csrf;
  const api = (path, options = {}) => call(base, path, { cookie, csrf, origin: base, ...options });

  const projectList = await api("/api/projects");
  assert.equal(projectList.status, 200);
  assert.equal(projectList.json.ok, true);
  assert.deepEqual(projectList.json.data.map((project) => project.id).sort(), [alphaId, betaId]);
  assert.equal(projectList.json.data.find((project) => project.id === alphaId).chatEnabled, true);
  const sessionsApi = await api("/api/projects/sessions?project=" + alphaId + "&q=owner&sort=updated&size=10");
  assert.equal(sessionsApi.status, 200);
  assert.deepEqual(sessionsApi.json.data.items.map((item) => item.id), [S_OWNER]);
  assert.equal(sessionsApi.json.data.total, 1);
  assert.equal(sessionsApi.json.data.page, 1);
  const sessionApi = await api("/api/projects/session?id=" + S_OWNER);
  assert.equal(sessionApi.json.data.resume.command, "claude --resume " + S_OWNER);
  assert.equal((await api("/api/projects/session?id=" + "99999999-9999-4999-8999-999999999999")).status, 404);
  assert.equal((await api("/api/projects/sessions?project=nope")).status, 404);
  const usageApi = await api("/api/projects/usage?project=" + alphaId);
  assert.equal(usageApi.status, 200);
  assert.equal(usageApi.json.data.days.length, 7);

  const metaApi = await api("/api/projects/session/meta", { method: "POST", body: { id: S_OWNER, pinned: true, tags: ["api"] } });
  assert.equal(metaApi.status, 200, metaApi.text);
  assert.equal(metaApi.json.data.pinned, true);
  assert.equal((await api("/api/projects/sessions?project=" + alphaId + "&pinned=1")).json.data.items[0].id, S_OWNER);
  const projectMetaApi = await api("/api/projects/meta", { method: "POST", body: { id: alphaId, label: "Main", pinned: true } });
  assert.equal(projectMetaApi.json.data.label, "Main");
  const renameApi = await api("/api/projects/session/rename", { method: "POST", body: { id: S_OWNER, title: "Release plan for October" } });
  assert.equal(renameApi.status, 200, renameApi.text);
  assert.equal(renameApi.json.data.title, "Release plan for October");
  assert.ok(existsSync(join(workspace, ".astack", "session-titles", "history.jsonl")), "the console keeps its title history inside its own workspace when the Claude home is not the default");
  assert.equal((await api("/api/projects/session/rename", { method: "POST", body: { id: S_OWNER, title: "x" } })).status, 400);
  assert.equal((await call(base, "/api/projects/session/meta", { method: "POST", body: { id: S_OWNER, pinned: false }, cookie, csrf, origin: "http://evil.example" })).status, 403, "cross-origin writes are refused");
  assert.equal((await api("/api/projects/session/meta", { method: "POST", body: { id: S_OWNER, tags: ["a".repeat(50)] } })).status, 400);
  assert.equal((await api("/api/projects/nothing")).status, 404);
  // A body that is not a JSON object is a 400, never a server error.
  for (const path of ["/api/projects/session/meta", "/api/projects/session/rename", "/api/projects/meta"]) {
    for (const body of [null, [], "x", 5]) {
      const refused = await api(path, { method: "POST", body });
      assert.equal(refused.status, 400, path + " " + JSON.stringify(body) + " -> " + refused.text);
      assert.match(refused.json.error, /JSON object/);
    }
  }
  assert.ok(!logs.some((line) => line.includes("[console] error")), "a bad body is not logged as a server error");
  assert.equal((await api("/api/projects/session/meta", { method: "POST", body: { id: S_OWNER, tags: { a: 1 } } })).status, 400, "wrong field types are refused over the API too");
  assert.equal((await api("/api/projects/meta", { method: "POST", body: { id: alphaId, label: {} } })).status, 400);

  // The remote listener may read, never write.
  const remote = { kind: "remote", cookie: "x" };
  const sessionStub = { key: "k", user: null };
  const readOnRemote = await server.route("GET", "/api/projects", {}, {}, sessionStub, remote, "198.51.100.1");
  assert.equal(readOnRemote.length, 2, "reading projects works on the internet listener");
  const sessionsOnRemote = await server.route("GET", "/api/projects/sessions", { project: alphaId }, {}, sessionStub, remote, "198.51.100.1");
  assert.ok(sessionsOnRemote.total >= 1);
  // Over the internet: ids, counts, timestamps and model only; no titles, prompts or paths.
  assert.ok(readOnRemote.every((project) => project.path === null && project.private === true), "no project path over the internet");
  for (const item of sessionsOnRemote.items) {
    assert.equal(item.title, null, "no session title over the internet");
    assert.equal(item.firstPrompt, null, "no first prompt over the internet");
    assert.equal(item.gitBranch, null);
    assert.ok(item.id && item.updatedAt && Number.isFinite(item.turns), "ids, timestamps and counts stay");
  }
  assert.ok(sessionsOnRemote.items.some((item) => item.model), "the model stays");
  const remoteText = JSON.stringify(readOnRemote) + JSON.stringify(sessionsOnRemote);
  for (const hidden of ["Release plan for October", "Plan the release", "Fix the login page", "/work/alpha", "feature/"]) {
    assert.equal(remoteText.includes(hidden), false, "the internet listener never carries " + hidden);
  }
  const sessionOnRemote = await server.route("GET", "/api/projects/session", { id: S_ASTACK }, {}, sessionStub, remote, "198.51.100.1");
  assert.equal(sessionOnRemote.title, null);
  assert.equal(sessionOnRemote.firstPrompt, null);
  assert.equal(sessionOnRemote.resume.cwd, null, "no working folder over the internet");
  assert.equal(sessionOnRemote.resume.command, "claude --resume " + S_ASTACK);
  assert.ok(sessionOnRemote.subagents.length && sessionOnRemote.subagents.every((agent) => agent.description === null), "no sub-agent description over the internet");
  // Search cannot probe hidden text: a word that is only in a prompt or title finds nothing remotely.
  assert.equal((await server.route("GET", "/api/projects/sessions", { project: alphaId, q: "Release plan" }, {}, sessionStub, remote, "198.51.100.1")).total, 0, "remote search ignores titles");
  assert.equal((await server.route("GET", "/api/projects/sessions", { project: alphaId, q: "migrate database" }, {}, sessionStub, remote, "198.51.100.1")).total, 0, "remote search ignores prompts");
  assert.equal((await server.route("GET", "/api/projects/sessions", { project: alphaId, q: S_OWNER.slice(0, 8) }, {}, sessionStub, remote, "198.51.100.1")).items[0]?.id, S_OWNER, "remote search still finds by id");
  // Neither the folder name nor the way a title was made leaves the machine.
  assert.ok(readOnRemote.every((project) => project.name !== "alpha" && project.name !== "beta"), "no folder name over the internet");
  assert.ok(sessionsOnRemote.items.every((item) => item.projectName === item.project && item.titleSource === null), "no folder name or title source on a session row");
  assert.equal((await server.route("GET", "/api/projects/sessions", { project: alphaId, q: "alpha" }, {}, sessionStub, remote, "198.51.100.1")).total, 0, "remote search cannot probe the folder name");
  assert.equal(sessionOnRemote.projectName, alphaId);
  // The local listener is unchanged.
  const local = { kind: "local", cookie: "y" };
  const sessionsLocal = await server.route("GET", "/api/projects/sessions", { project: alphaId, q: "Release plan" }, {}, sessionStub, local, "127.0.0.1");
  assert.equal(sessionsLocal.items[0]?.title, "Release plan for October", "the local listener shows titles");
  assert.ok((await server.route("GET", "/api/projects", {}, {}, sessionStub, local, "127.0.0.1")).some((project) => project.path), "the local listener shows paths");
  const metaBefore = readFileSync(join(workspace, ".astack", "console", "projects-meta.json"), "utf8");
  const titlesBefore = readFileSync(join(workspace, ".astack", "session-titles", "history.jsonl"), "utf8");
  for (const [path, body] of [
    ["/api/projects/session/meta", { id: S_OWNER, pinned: false }],
    ["/api/projects/session/rename", { id: S_OWNER, title: "Renamed from the internet" }],
    ["/api/projects/meta", { id: alphaId, pinned: false }]
  ]) {
    const refused = await rejects(server.route("POST", path, {}, body, sessionStub, remote, "198.51.100.1"), 403);
    assert.match(refused.message, /not changed over the internet/);
  }
  assert.equal(readFileSync(join(workspace, ".astack", "console", "projects-meta.json"), "utf8"), metaBefore, "a refused write changes nothing");
  assert.equal(readFileSync(join(workspace, ".astack", "session-titles", "history.jsonl"), "utf8"), titlesBefore);
  assert.ok(!logs.some((line) => line.includes(token)), "the console token is never logged");

  console.log("verify-console-projects: ok");
} finally {
  for (const server of servers) {
    try {
      await server.stop();
    } catch {
      // already stopped
    }
  }
  for (const directory of sandboxes) {
    rmSync(directory, { recursive: true, force: true });
  }
}
