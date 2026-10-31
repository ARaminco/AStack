import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../runtime/astack-runtime.mjs";
import { ConsoleServer } from "../console/server.mjs";
import { AccountError, ClaudeAccounts, KEYCHAIN_SERVICE, USAGE_URL, countLiveTurns, findTopLevelSpan, listClaudeProcesses, replaceTopLevelValue, turnsFilePath, writeTurnsFile } from "../console/accounts.mjs";
import { CHAT_STATE_DENIES, ChatManager, accountsDirectoryDenies } from "../console/chats.mjs";
import { runAccountCommand } from "../cli/account-cli.mjs";
import { createLocalization } from "../localization-engine/service.mjs";

// Everything here runs against temporary fake Claude homes with fake tokens
// ("tok-A", "ref-A"…). The real ~/.claude/.credentials.json and ~/.claude.json
// are never read, and the real usage endpoint is never called (stub fetch).

const repoRoot = process.cwd();
const sandboxes = [];
const servers = [];
function sandbox(prefix = "astack-accounts-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  sandboxes.push(directory);
  return directory;
}
const read = (path) => readFileSync(path, "utf8");
const readJson = (path) => JSON.parse(read(path));
const FUTURE = Date.now() + 6 * 3600 * 1000;
const noTokens = (value, what) => assert.ok(!/tok-|ref-/.test(typeof value === "string" ? value : JSON.stringify(value)), "no token value in " + what);

function accountRaw(email, organization) {
  const text = JSON.stringify({ accountUuid: "uuid-" + email, emailAddress: email, organizationName: organization }, null, 2);
  return text.split("\n").map((line, index) => (index ? "  " + line : line)).join("\r\n");
}
// A .claude.json with the awkward parts a surgical edit must survive: CRLF, a
// decoy "oauthAccount" key one level down, braces and quotes inside strings,
// unicode, numbers, arrays after the span.
function claudeJson(raw) {
  return [
    "{",
    '  "numStartups": 412,',
    '  "note": "decoy { \\"oauthAccount\\": 1 } and } braces",',
    '  "projects": {',
    '    "oauthAccount": { "decoy": true },',
    '    "C:\\\\work\\\\site": { "allowedTools": [], "history": ["a { b", "c } d"] }',
    "  },",
    '  "oauthAccount": ' + raw + ",",
    '  "tail": [1, 2.5, {"a": "}"}, null, true],',
    '  "unicode": "فارسی ✓"',
    "}",
    ""
  ].join("\r\n");
}
function credentials(access, refresh, plan = "max", expiresAt = FUTURE) {
  return { claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt, scopes: ["user:inference"], subscriptionType: plan }, mcpOAuth: { server: { accessToken: "mcp-keep" } } };
}

function fakeHome() {
  const home = sandbox("astack-claude-home-");
  return { home, credentialsPath: join(home, ".credentials.json"), jsonPath: join(home, ".claude.json") };
}
function login(fake, email, org, access, refresh, plan = "max", expiresAt = FUTURE) {
  writeFileSync(fake.credentialsPath, JSON.stringify(credentials(access, refresh, plan, expiresAt)));
  const raw = accountRaw(email, org);
  writeFileSync(fake.jsonPath, claudeJson(raw));
  return raw;
}

const audits = [];
const auditRuntime = { audit: { record: (entry) => audits.push(entry) } };

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

try {
  // =================================================================== JSON text surgery
  const raw0 = accountRaw("x@example.com", "X");
  const text0 = claudeJson(raw0);
  const span0 = findTopLevelSpan(text0, "oauthAccount");
  assert.equal(text0.slice(span0.start, span0.end), raw0, "the real top-level span is found, not the decoy or the string");
  assert.equal(findTopLevelSpan(text0, "missing"), null);
  assert.equal(findTopLevelSpan(text0, "allowedTools"), null, "nested keys are not top-level");
  const replaced = replaceTopLevelValue(text0, "oauthAccount", '{"emailAddress":"y@example.com"}');
  assert.equal(replaced, text0.replace(raw0, '{"emailAddress":"y@example.com"}'), "everything outside the span is byte-identical");
  JSON.parse(replaced);
  const added = replaceTopLevelValue('{\r\n  "a": 1\r\n}\r\n', "oauthAccount", '{"emailAddress":"z@example.com"}');
  assert.deepEqual(JSON.parse(added), { a: 1, oauthAccount: { emailAddress: "z@example.com" } }, "a missing key is appended as valid JSON");
  assert.deepEqual(JSON.parse(replaceTopLevelValue("{}", "oauthAccount", "{}")), { oauthAccount: {} });

  // =================================================================== two profiles, switch, byte-identical rest
  const fake = fakeHome();
  const directory = join(sandbox("astack-profiles-"), "accounts");
  let turns = 0;
  let processes = [];
  const accounts = new ClaudeAccounts({ runtime: auditRuntime, claudeHome: fake.home, directory, chatTurns: () => turns, listProcesses: async () => processes, usageTtlMs: 0 });

  const rawA = login(fake, "a@example.com", "Org A", "tok-A", "ref-A", "max");
  assert.equal(accounts.activeEmail(), "a@example.com");
  let state = await accounts.list();
  assert.deepEqual(state.active, { email: "a@example.com", plan: "max", profileId: null });
  assert.deepEqual(state.accounts, []);
  assert.equal(state.chatTurnsRunning, 0);
  assert.ok(!existsSync(directory), "reading never creates the profile folder");

  const savedA = accounts.save({ label: "Work" });
  assert.equal(savedA.id, "a@example.com");
  assert.equal(savedA.label, "Work");
  assert.equal(savedA.active, true);
  noTokens(savedA, "save result");
  assert.equal(readJson(join(directory, "a@example.com.json")).credentials.accessToken, "tok-A", "the profile file holds the login");
  assert.equal(readJson(join(directory, "a@example.com.json")).oauthAccountRaw, rawA);
  if (process.platform !== "win32") {
    assert.equal(statSync(directory).mode & 0o777, 0o700, "owner-only folder");
    assert.equal(statSync(join(directory, "a@example.com.json")).mode & 0o777, 0o600, "owner-only profile");
  }
  assert.equal(accounts.save().label, "Work", "saving again keeps the label and updates in place");
  assert.equal(readdirSync(directory).filter((name) => name.endsWith(".json")).length, 1);

  const rawB = login(fake, "b@example.com", "Org B {x}", "tok-B", "ref-B", "pro");
  const savedB = accounts.save({ label: "Home" });
  assert.equal(savedB.id, "b@example.com");
  assert.equal(savedB.plan, "pro");
  state = await accounts.list();
  assert.deepEqual(state.accounts.map((entry) => [entry.id, entry.active]), [["a@example.com", false], ["b@example.com", true]]);
  noTokens(state, "list");
  assert.equal(state.active.profileId, "b@example.com");

  // switch B -> A
  processes = [{ pid: 4242, name: "claude" }];
  const beforeSwitch = read(fake.jsonPath);
  const switched = await accounts.switch("a@example.com");
  assert.equal(switched.active.email, "a@example.com");
  assert.equal(switched.active.profileId, "a@example.com");
  assert.ok(switched.warnings.includes("running-sessions"), "running claude processes are reported");
  noTokens(switched, "switch result");
  assert.equal(read(fake.jsonPath), beforeSwitch.replace(rawB, rawA), "only the oauthAccount span changed; every other byte (CRLF, decoys, unicode) is identical");
  const liveCredentials = readJson(fake.credentialsPath);
  assert.equal(liveCredentials.claudeAiOauth.accessToken, "tok-A");
  assert.equal(liveCredentials.claudeAiOauth.refreshToken, "ref-A");
  assert.equal(liveCredentials.mcpOAuth.server.accessToken, "mcp-keep", "other keys of the credentials file stay");
  const backup = readJson(join(directory, ".backups", "live-login.json"));
  assert.equal(backup.credentialsFile.claudeAiOauth.accessToken, "tok-B", "the rolling backup holds the previous live login");
  assert.equal(backup.oauthAccountRaw, rawB);
  assert.equal(accounts.activeEmail(), "a@example.com", "the cached active email follows the file");
  processes = [];

  // sync-back of a token Claude Code rotated while A was live
  writeFileSync(fake.credentialsPath, JSON.stringify(credentials("tok-A2", "ref-A2", "max")));
  const toB = await accounts.switch("b@example.com");
  assert.equal(toB.active.email, "b@example.com");
  assert.ok(toB.warnings.includes("login-unverified"), "an email-only match is reported as unverified");
  assert.equal(readJson(join(directory, "a@example.com.json")).previousCredentials.refreshToken, "ref-A", "the profile's previous login is kept as a fallback");
  assert.equal(readJson(join(directory, "a@example.com.json")).credentials.accessToken, "tok-A2", "the rotated token was written back to A's profile first");
  assert.equal(readJson(join(directory, "a@example.com.json")).credentials.refreshToken, "ref-A2");
  assert.equal(readJson(join(directory, ".backups", "live-login.json")).credentialsFile.claudeAiOauth.accessToken, "tok-A2", "one rolling backup, overwritten");
  assert.equal(readdirSync(join(directory, ".backups")).length, 1);
  await accounts.switch("a@example.com");
  assert.equal(readJson(fake.credentialsPath).claudeAiOauth.accessToken, "tok-A2", "switching back applies the rotated token");

  // switching to the account that is already live is a no-op with a note
  const same = await accounts.switch("a@example.com");
  assert.ok(same.warnings.includes("already-active"));

  // refusal while a chat turn runs
  turns = 1;
  const frozenCredentials = read(fake.credentialsPath);
  const frozenJson = read(fake.jsonPath);
  await assert.rejects(() => accounts.switch("b@example.com"), (error) => error instanceof AccountError && error.status === 409 && error.details.chatTurnsRunning === 1);
  assert.equal(read(fake.credentialsPath), frozenCredentials, "a refused switch changes nothing");
  assert.equal(read(fake.jsonPath), frozenJson);
  const forced = await accounts.switch("b@example.com", { force: true });
  assert.ok(forced.warnings.includes("chat-turns-running"));
  assert.equal(forced.active.email, "b@example.com");
  turns = 0;

  // a failed read-back restores the previous login
  const profileA = readJson(join(directory, "a@example.com.json"));
  writeFileSync(join(directory, "a@example.com.json"), JSON.stringify({ ...profileA, email: "someone-else@example.com" }));
  const beforeFail = { credentials: read(fake.credentialsPath), json: read(fake.jsonPath) };
  await assert.rejects(() => accounts.switch("a@example.com"), /could not be verified/);
  assert.equal(read(fake.credentialsPath), JSON.stringify(JSON.parse(beforeFail.credentials)), "credentials restored after a failed switch");
  assert.equal(read(fake.jsonPath), beforeFail.json, ".claude.json restored byte for byte");
  writeFileSync(join(directory, "a@example.com.json"), JSON.stringify(profileA));

  // unknown and hostile ids
  for (const bad of ["nobody@example.com", "../outside", "a/b", "", null, "..\\x", ".hidden"]) {
    await assert.rejects(() => accounts.switch(bad), (error) => error instanceof AccountError && error.status === 404, "id " + JSON.stringify(bad));
  }

  // an unsaved live login is reported, not lost silently
  login(fake, "c@example.com", "Org C", "tok-C", "ref-C", "free");
  const fromUnsaved = await accounts.switch("a@example.com");
  assert.ok(fromUnsaved.warnings.includes("unsaved-previous-login"));
  assert.equal(readJson(join(directory, ".backups", "live-login.json")).credentialsFile.claudeAiOauth.accessToken, "tok-C", "the backup holds the unsaved login");

  // label
  assert.equal(accounts.label("a@example.com", "  Work\u0000 laptop  ").label, "Work  laptop");

  // =================================================================== usage (stub fetch, never the real endpoint)
  const requests = [];
  const stub = (responder) => async (url, init) => {
    requests.push({ url, headers: init.headers, hasSignal: Boolean(init.signal) });
    return responder(url, init);
  };
  const okUsage = { five_hour: { utilization: 37.5, resets_at: "2026-10-31T15:00:00Z" }, seven_day: { utilization: 12, resets_at: "2026-11-05T00:00:00Z" } };
  accounts.fetchImplementation = stub(async () => ({ ok: true, status: 200, json: async () => okUsage }));
  const usage = await accounts.usage("a@example.com");
  assert.deepEqual(usage, { fiveHour: { pct: 37.5, resetsAt: "2026-10-31T15:00:00Z" }, sevenDay: { pct: 12, resetsAt: "2026-11-05T00:00:00Z" } });
  assert.equal(requests[0].url, USAGE_URL);
  assert.equal(requests[0].headers.authorization, "Bearer tok-A2", "the live token is used for the live account");
  assert.equal(requests[0].headers["anthropic-version"], "2023-06-01");
  assert.equal(requests[0].headers["anthropic-beta"], "oauth-2025-04-20");
  assert.ok(requests[0].hasSignal, "a timeout signal is set");
  noTokens(usage, "usage result");
  await accounts.usage("b@example.com");
  assert.equal(requests[1].headers.authorization, "Bearer tok-B", "a saved account uses its saved token");
  assert.deepEqual((await accounts.usage()).fiveHour.pct, 37.5, "no id means the active account");
  accounts.fetchImplementation = stub(async () => ({ ok: false, status: 429, json: async () => ({}) }));
  const limited = await accounts.usage("a@example.com");
  assert.match(limited.error, /429/);
  accounts.fetchImplementation = stub(async () => {
    throw new Error("connect ECONNRESET with Bearer tok-A2");
  });
  const failed = await accounts.usage("a@example.com");
  assert.ok(failed.error && !/tok-/.test(JSON.stringify(failed)), "a failure is an error object without the token");
  assert.deepEqual(await accounts.usage("nobody@example.com"), { error: "unknown account", code: "unknown" });
  // expired saved login: no request is made
  const profileB = readJson(join(directory, "b@example.com.json"));
  writeFileSync(join(directory, "b@example.com.json"), JSON.stringify({ ...profileB, credentials: { ...profileB.credentials, expiresAt: Date.now() - 1000 } }));
  const before = requests.length;
  accounts.fetchImplementation = stub(async () => ({ ok: true, status: 200, json: async () => okUsage }));
  const expired = await accounts.usage("b@example.com");
  assert.equal(expired.expired, true);
  assert.equal(requests.length, before, "no call is made with an expired login");
  // answers are cached briefly so a polling UI does not hammer the endpoint
  const cached = new ClaudeAccounts({ runtime: auditRuntime, claudeHome: fake.home, directory, usageTtlMs: 60000, listProcesses: async () => [] });
  let hits = 0;
  cached.fetchImplementation = async () => {
    hits += 1;
    return { ok: true, status: 200, json: async () => okUsage };
  };
  await cached.usage("a@example.com");
  await cached.usage("a@example.com");
  assert.equal(hits, 1);
  // a hanging endpoint ends with an error, not a hang (abort signal honoured)
  const slow = new ClaudeAccounts({ runtime: auditRuntime, claudeHome: fake.home, directory, usageTtlMs: 0, listProcesses: async () => [] });
  slow.fetchImplementation = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms === 6000 ? 20 : ms, ...rest);
  try {
    assert.match((await slow.usage("a@example.com")).error, /timed out/);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }

  // =================================================================== remove
  const liveBeforeRemove = read(fake.credentialsPath);
  assert.deepEqual(accounts.remove("b@example.com"), { removed: true, backupCleared: false }, "the backup holds the unsaved login of c, not b: it stays");
  assert.ok(!existsSync(join(directory, "b@example.com.json")));
  assert.equal(read(fake.credentialsPath), liveBeforeRemove, "removing a profile never touches the live login");
  assert.throws(() => accounts.remove("b@example.com"), (error) => error.status === 404);
  assert.equal((await accounts.list()).accounts.length, 1);

  // =================================================================== audit
  const actions = audits.map((entry) => entry.action);
  for (const action of ["claude-account-save", "claude-account-switch", "claude-account-remove", "claude-account-label"]) {
    assert.ok(actions.includes(action), "audited: " + action);
  }
  assert.ok(audits.every((entry) => entry.actor === "owner@console"));
  noTokens(audits, "audit records");

  // =================================================================== macOS keychain (stubbed `security`)
  {
    const mac = fakeHome();
    const store = { value: JSON.stringify(credentials("tok-K1", "ref-K1")) };
    const securityCalls = [];
    const argvSeen = [];
    const security = (args, input) => {
      argvSeen.push(...args);
      securityCalls.push(args[0] === "-i" ? "add-generic-password" : args[0]);
      if (args[0] === "find-generic-password") return store.value + "\n";
      // writes: `security -i`, the command (with the secret, hex encoded) on stdin only
      assert.deepEqual(args, ["-i"]);
      assert.match(input, /^add-generic-password -U -s "Claude Code-credentials" -a "[^"]*" -X [0-9a-f]+\n$/);
      assert.ok(input.includes('"' + KEYCHAIN_SERVICE + '"'));
      store.value = Buffer.from(/ -X ([0-9a-f]+)\n$/.exec(input)[1], "hex").toString("utf8");
      return "";
    };
    writeFileSync(mac.jsonPath, claudeJson(accountRaw("k1@example.com", "K1")));
    const macDirectory = join(sandbox("astack-profiles-"), "accounts");
    const macAccounts = new ClaudeAccounts({ runtime: auditRuntime, claudeHome: mac.home, directory: macDirectory, platform: "darwin", security, listProcesses: async () => [], harden: false });
    macAccounts.save({ label: "K1" });
    store.value = JSON.stringify(credentials("tok-K2", "ref-K2"));
    writeFileSync(mac.jsonPath, claudeJson(accountRaw("k2@example.com", "K2")));
    macAccounts.save({ label: "K2" });
    await macAccounts.switch("k1@example.com");
    assert.equal(JSON.parse(store.value).claudeAiOauth.accessToken, "tok-K1", "the keychain entry was rewritten");
    assert.ok(!existsSync(mac.credentialsPath), "no credentials file is created on macOS when the keychain holds the login");
    assert.equal(macAccounts.activeEmail(), "k1@example.com");
    assert.ok(securityCalls.includes("add-generic-password"));
    assert.ok(!/tok-|ref-/.test(argvSeen.join(" ")), "no token value ever appears in the arguments of `security`");
  }

  // =================================================================== processes
  const listed = await listClaudeProcesses();
  assert.ok(Array.isArray(listed) && listed.every((entry) => Number.isInteger(entry.pid) && typeof entry.name === "string"), "the real process lister answers a list");

  // =================================================================== CLI (Persian)
  {
    const cliFake = fakeHome();
    login(cliFake, "a@example.com", "Org A", "tok-A", "ref-A", "max");
    const cliDirectory = join(sandbox("astack-profiles-"), "accounts");
    const savedEnv = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, ASTACK_ACCOUNTS_DIR: process.env.ASTACK_ACCOUNTS_DIR };
    process.env.CLAUDE_CONFIG_DIR = cliFake.home;
    process.env.ASTACK_ACCOUNTS_DIR = cliDirectory;
    const i18n = createLocalization();
    const lines = [];
    const realLog = console.log;
    const cli = async (...tokens) => {
      lines.length = 0;
      console.log = (line) => lines.push(String(line));
      try {
        await runAccountCommand({ runtime: auditRuntime, i18n, tokens });
      } finally {
        console.log = realLog;
      }
      return lines.join("\n");
    };
    try {
      assert.match(await cli("list"), /a@example\.com/);
      assert.match(await cli("save", "--label", "Work"), /a@example\.com/);
      login(cliFake, "b@example.com", "Org B", "tok-B", "ref-B", "pro");
      await cli("save");
      const switchedText = await cli("switch", "Work");
      assert.match(switchedText, /a@example\.com/);
      assert.equal(JSON.parse(read(cliFake.credentialsPath)).claudeAiOauth.accessToken, "tok-A");
      const listText = await cli("list");
      assert.match(listText, /\* a@example\.com \(Work\)/);
      assert.match(listText, /[\u0600-\u06FF]/, "Persian output by default");
      await assert.rejects(() => cli("switch", "nobody"), /nobody/);
      assert.match(await cli("label", "b@example.com", "Home"), /b@example\.com/);
      assert.match(await cli("remove", "b@example.com"), /b@example\.com/);
      assert.match(await cli("bogus"), /astack account/);
      noTokens(listText + switchedText, "CLI output");
    } finally {
      for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  // =================================================================== HTTP endpoints through the console server
  const apiFake = fakeHome();
  const apiDirectory = join(sandbox("astack-profiles-"), "accounts");
  const apiRawA = login(apiFake, "a@example.com", "Org A", "tok-A", "ref-A", "max");
  const previousDirectory = process.env.ASTACK_ACCOUNTS_DIR;
  process.env.ASTACK_ACCOUNTS_DIR = apiDirectory;
  const workspace = sandbox("astack-accounts-ws-");
  cpSync(join(repoRoot, "context-engine", "lenses.json"), join(workspace, "context-engine", "lenses.json"));
  const runtime = createRuntime({ workspaceRoot: workspace });
  const server = new ConsoleServer({ runtime, port: 0, pollMs: 300, log: () => {}, claudeHome: apiFake.home, chats: { projects: [workspace] } });
  process.env.ASTACK_ACCOUNTS_DIR = previousDirectory ?? "";
  if (previousDirectory === undefined) delete process.env.ASTACK_ACCOUNTS_DIR;
  server.accounts.listProcessesImplementation = async () => [];
  server.accounts.usageTtlMs = 0;
  servers.push(server);
  await server.start();
  const base = server.origin;
  const token = read(join(workspace, ".astack", "console", "token")).trim();
  const signIn = await call(base, "/api/login", { method: "POST", body: { token }, origin: base });
  const cookie = String(signIn.headers["set-cookie"]).split(";")[0];
  const csrf = signIn.json.csrf;
  const get = (path) => call(base, path, { cookie });
  const post = (path, body) => call(base, path, { method: "POST", body, cookie, csrf, origin: base });
  const responses = [];
  const track = (response) => {
    responses.push(response.text);
    return response;
  };

  assert.equal((await call(base, "/api/accounts")).status, 401, "sign-in required");
  assert.equal((await call(base, "/api/accounts/save", { method: "POST", body: {}, origin: base })).status, 401);
  const listed0 = track(await get("/api/accounts"));
  assert.equal(listed0.status, 200);
  assert.equal(listed0.json.ok, true);
  assert.equal(listed0.json.data.active.email, "a@example.com");
  assert.deepEqual(listed0.json.data.accounts, []);
  assert.equal(typeof listed0.json.data.platform, "string");
  assert.equal(listed0.json.data.chatTurnsRunning, 0);

  const savedApi = track(await post("/api/accounts/save", { label: "Work" }));
  assert.equal(savedApi.status, 200, savedApi.text);
  assert.equal(savedApi.json.data.id, "a@example.com");
  assert.equal((await post("/api/accounts/save", { label: "x" })).status, 200);
  assert.equal((await call(base, "/api/accounts/save", { method: "POST", body: {}, cookie, origin: base })).status, 403, "writes need the CSRF token");
  login(apiFake, "b@example.com", "Org B", "tok-B", "ref-B", "pro");
  track(await post("/api/accounts/save", { label: "Home" }));
  track(await post("/api/accounts/label", { id: "b@example.com", label: "Home office" }));

  assert.equal(server.chats.accountEmail(), "b@example.com", "chat turns learn which account they run on");
  const switchedApi = track(await post("/api/accounts/switch", { id: "a@example.com" }));
  assert.equal(switchedApi.status, 200, switchedApi.text);
  assert.equal(switchedApi.json.data.active.email, "a@example.com");
  assert.deepEqual(switchedApi.json.data.warnings, []);
  assert.equal(read(apiFake.jsonPath).includes(apiRawA), true);
  assert.equal(server.chats.accountEmail(), "a@example.com");
  assert.equal((await post("/api/accounts/switch", { id: "nobody@example.com" })).status, 404);
  assert.equal((await post("/api/accounts/switch", {})).status, 404);

  // a chat turn is running: refused with 409, force goes through
  server.chats.turns.set("session-1", { sessionId: "session-1", id: "turn-1", startedAt: new Date().toISOString(), project: { name: "demo" } });
  const busy = track(await post("/api/accounts/switch", { id: "b@example.com" }));
  assert.equal(busy.status, 409);
  assert.equal(busy.json.ok, false);
  assert.equal(track(await get("/api/accounts")).json.data.chatTurnsRunning, 1);
  const forcedApi = track(await post("/api/accounts/switch", { id: "b@example.com", force: true }));
  assert.equal(forcedApi.status, 200);
  assert.deepEqual(forcedApi.json.data.warnings, ["chat-turns-running"]);
  server.chats.turns.delete("session-1");

  server.accounts.fetchImplementation = async () => ({ ok: true, status: 200, json: async () => okUsage });
  const usageApi = track(await get("/api/accounts/usage?id=" + encodeURIComponent("a@example.com")));
  assert.equal(usageApi.status, 200);
  assert.equal(usageApi.json.data.fiveHour.pct, 37.5);
  server.accounts.fetchImplementation = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const usageFail = track(await get("/api/accounts/usage?id=" + encodeURIComponent("a@example.com")));
  assert.equal(usageFail.status, 200);
  assert.match(usageFail.json.data.error, /401/);
  assert.equal((await get("/api/accounts/bogus")).status, 404);

  const removed = track(await post("/api/accounts/remove", { id: "a@example.com" }));
  assert.deepEqual(removed.json.data, { removed: true, backupCleared: true });
  assert.equal((await post("/api/accounts/remove", { id: "a@example.com" })).status, 404);

  // the remote (internet) listener may look, never change
  const remoteListener = { kind: "remote" };
  assert.ok(await server.accountsRoute("GET", null, {}, {}, remoteListener), "reading is allowed remotely");
  for (const action of ["save", "switch", "remove", "label"]) {
    await assert.rejects(() => server.accountsRoute("POST", action, {}, { id: "b@example.com" }, remoteListener), (error) => error.status === 403, "remote " + action);
  }

  // no token value in any response, and none in the audit log
  for (const text of responses) noTokens(text, "an API response");
  const auditText = JSON.stringify(runtime.audit.list({}));
  noTokens(auditText, "the console audit log");
  assert.ok(runtime.audit.list({ action: "claude-account-switch" }).length >= 2, "switches are audited");
  assert.ok(runtime.audit.list({ action: "claude-account-save" }).length >= 1);

  // =================================================================== default Claude layout (the console's own wiring)
  {
    // ~/.claude.json sits BESIDE ~/.claude. The console always hands ClaudeAccounts its (default) home;
    // that must still resolve the same .claude.json as the CLI.
    const fakeUser = sandbox("astack-user-");
    mkdirSync(join(fakeUser, ".claude"));
    const savedEnv = {};
    for (const name of ["USERPROFILE", "HOME", "CLAUDE_CONFIG_DIR", "ASTACK_ACCOUNTS_DIR"]) savedEnv[name] = process.env[name];
    process.env.USERPROFILE = fakeUser;
    process.env.HOME = fakeUser;
    delete process.env.CLAUDE_CONFIG_DIR;
    process.env.ASTACK_ACCOUNTS_DIR = join(sandbox("astack-profiles-"), "accounts");
    try {
      const besideJson = join(fakeUser, ".claude.json");
      const credentialsFile = join(fakeUser, ".claude", ".credentials.json");
      writeFileSync(credentialsFile, JSON.stringify(credentials("tok-A", "ref-A", "max")));
      writeFileSync(besideJson, claudeJson(accountRaw("a@example.com", "Org A")));
      const cliStyle = new ClaudeAccounts({ runtime: auditRuntime, listProcesses: async () => [], harden: false });
      const consoleStyle = new ConsoleServer({ runtime, port: 0, log: () => {}, chats: { projects: [workspace] } });
      consoleStyle.accounts.listProcessesImplementation = async () => [];
      assert.equal(consoleStyle.chats.home, join(fakeUser, ".claude"), "the console's Claude home is the default folder");
      assert.equal(consoleStyle.accounts.claudeJsonPath, besideJson, "the console finds ~/.claude.json beside the default folder");
      assert.equal(consoleStyle.accounts.claudeJsonPath, cliStyle.claudeJsonPath, "console and CLI agree");
      assert.equal(new ClaudeAccounts({ claudeHome: join(fakeUser, ".claude") }).claudeJsonPath, besideJson);
      assert.equal(new ClaudeAccounts({ claudeHome: join(fakeUser, "elsewhere") }).claudeJsonPath, join(fakeUser, "elsewhere", ".claude.json"), "a custom home keeps it inside");
      assert.equal(consoleStyle.accounts.activeEmail(), "a@example.com");
      assert.equal(consoleStyle.chats.accountEmail(), "a@example.com", "turns learn their account");
      assert.equal(consoleStyle.accounts.save({ label: "A" }).id, "a@example.com", "save works with the default layout");
      writeFileSync(credentialsFile, JSON.stringify(credentials("tok-B", "ref-B", "pro")));
      writeFileSync(besideJson, claudeJson(accountRaw("b@example.com", "Org B")));
      consoleStyle.accounts.save({ label: "B" });
      const switchedDefault = await consoleStyle.accounts.switch("a@example.com");
      assert.deepEqual(switchedDefault.warnings, [], "no 'no-claude-json' half switch");
      assert.equal(readJson(besideJson).oauthAccount.emailAddress, "a@example.com", "the identity moved with the tokens");
      assert.equal(readJson(credentialsFile).claudeAiOauth.accessToken, "tok-A");
      assert.ok(!existsSync(join(fakeUser, ".claude", ".claude.json")), "no stray file inside the folder");
      // CLAUDE_CONFIG_DIR set: the file lives inside it
      process.env.CLAUDE_CONFIG_DIR = join(fakeUser, ".claude");
      assert.equal(new ClaudeAccounts({ claudeHome: join(fakeUser, ".claude") }).claudeJsonPath, join(fakeUser, ".claude", ".claude.json"));
    } finally {
      for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  // =================================================================== hardening of the switch
  {
    const make = (extra = {}) => {
      const f = fakeHome();
      const dir = join(sandbox("astack-profiles-"), "accounts");
      const acc = new ClaudeAccounts({ runtime: auditRuntime, claudeHome: f.home, directory: dir, listProcesses: async () => [], env: {}, harden: false, usageTtlMs: 0, ...extra });
      return { f, dir, acc };
    };
    const setup = () => {
      const ctx = make();
      login(ctx.f, "a@x.com", "Org A", "tok-A", "ref-A", "max");
      ctx.acc.save();
      login(ctx.f, "b@x.com", "Org B", "tok-B", "ref-B", "pro");
      ctx.acc.save();
      return ctx;
    };

    // --- foreign token under B's email: neither profile loses its own login
    {
      const { f, dir, acc } = setup();
      await acc.switch("a@x.com");
      writeFileSync(f.credentialsPath, JSON.stringify(credentials("tok-B2", "ref-B2", "pro")));
      const second = await acc.switch("a@x.com");
      assert.ok(second.warnings.includes("login-unverified"), "an email-only match is flagged");
      const profileA = readJson(join(dir, "a@x.com.json"));
      assert.equal(profileA.previousCredentials.accessToken, "tok-A", "A's own login survives as the previous generation");
      assert.equal(profileA.previousCredentials.refreshToken, "ref-A");
      assert.equal(readJson(join(dir, "b@x.com.json")).credentials.accessToken, "tok-B", "B was not touched");
    }
    // --- the live tokens belong to another account while B's oauthAccount is shown: B's login is kept
    {
      const { f, dir, acc } = setup(); // live is B
      writeFileSync(f.credentialsPath, JSON.stringify(credentials("tok-A2", "ref-A2", "max")));
      const toA = await acc.switch("a@x.com");
      assert.equal(toA.active.email, "a@x.com", "the switch itself still happens");
      assert.ok(toA.warnings.includes("login-unverified"));
      const profileB = readJson(join(dir, "b@x.com.json"));
      assert.equal(profileB.previousCredentials.refreshToken, "ref-B", "B's real refresh token is still on disk");
      assert.equal(readJson(f.credentialsPath).claudeAiOauth.accessToken, "tok-A");
    }
    // --- save() keeps the replaced login too
    {
      const { f, dir, acc } = setup(); // live is B
      writeFileSync(f.credentialsPath, JSON.stringify(credentials("tok-B3", "ref-B3", "pro")));
      acc.save();
      assert.equal(readJson(join(dir, "b@x.com.json")).previousCredentials.refreshToken, "ref-B");
      assert.equal(readJson(join(dir, "b@x.com.json")).credentials.refreshToken, "ref-B3");
    }
    // --- a half-applied switch (tokens B, account A) is repaired, never answered with 'already-active'
    {
      const { f, acc } = setup();
      await acc.switch("a@x.com");
      await acc.switch("b@x.com");
      const rawOfA = accountRaw("a@x.com", "Org A");
      writeFileSync(f.jsonPath, claudeJson(rawOfA)); // crash between the two writes, or an outside rewrite
      assert.equal(acc.activeEmail(), "a@x.com");
      const repaired = await acc.switch("b@x.com");
      assert.ok(!repaired.warnings.includes("already-active"));
      assert.ok(repaired.warnings.includes("login-repaired"));
      assert.equal(acc.activeEmail(), "b@x.com");
      assert.equal(readJson(f.jsonPath).oauthAccount.emailAddress, "b@x.com");
      const again = await acc.switch("b@x.com");
      assert.ok(again.warnings.includes("already-active"), "consistent logins still short-circuit");
    }
    // --- sync-back never copies another account's oauthAccount into a profile
    {
      const { f, dir, acc } = setup();
      await acc.switch("b@x.com"); // live B, consistent
      const before = readJson(join(dir, "b@x.com.json")).oauthAccountRaw;
      writeFileSync(f.credentialsPath, JSON.stringify(credentials("tok-B", "ref-B-rotated", "pro")));
      writeFileSync(f.jsonPath, claudeJson(accountRaw("a@x.com", "Org A")));
      await acc.switch("a@x.com");
      assert.equal(readJson(join(dir, "b@x.com.json")).oauthAccountRaw, before, "B keeps its own oauthAccount");
      assert.equal(readJson(join(dir, "b@x.com.json")).credentials.refreshToken, "ref-B-rotated", "the rotated tokens were still saved");
    }
    // --- a missing .claude.json: nothing is changed (no half switch)
    {
      const { f, acc } = setup();
      await acc.switch("a@x.com");
      rmSync(f.jsonPath);
      const frozen = read(f.credentialsPath);
      await assert.rejects(() => acc.switch("b@x.com"), (error) => error instanceof AccountError && error.status === 409 && error.code === "no-claude-json");
      assert.equal(read(f.credentialsPath), frozen, "the tokens were not swapped alone");
    }
    // --- a concurrent writer of .claude.json: its change survives, the stale copy is never written back
    {
      const { f, acc } = setup();
      await acc.switch("a@x.com");
      const original = ClaudeAccounts.prototype.storeCredentialsObject;
      acc.storeCredentialsObject = function (object, source) {
        const text = read(f.jsonPath).replace('"numStartups": 412', '"numStartups": 999, "added": true');
        writeFileSync(f.jsonPath, text);
        return original.call(this, object, source);
      };
      await acc.switch("b@x.com");
      const merged = readJson(f.jsonPath);
      assert.equal(merged.added, true, "the concurrent change is kept");
      assert.equal(merged.oauthAccount.emailAddress, "b@x.com");
    }
    {
      // the credentials write fails after somebody else changed .claude.json: restore leaves it alone
      const { f, acc } = setup();
      await acc.switch("a@x.com");
      acc.storeCredentialsObject = function () {
        writeFileSync(f.jsonPath, read(f.jsonPath).replace('"numStartups": 412', '"numStartups": 7'));
        throw new Error("disk full");
      };
      await assert.rejects(() => acc.switch("b@x.com"));
      assert.equal(readJson(f.jsonPath).numStartups, 7, "the other writer's change was not rolled back");
    }
    {
      // an empty .claude.json (caught mid-write) is never written back or replaced
      const { f, acc } = setup();
      await acc.switch("a@x.com");
      const original = ClaudeAccounts.prototype.storeCredentialsObject;
      acc.storeCredentialsObject = function (object, source) {
        writeFileSync(f.jsonPath, "");
        return original.call(this, object, source);
      };
      await assert.rejects(() => acc.switch("b@x.com"), (error) => error instanceof AccountError && error.code === "claude-json-unreadable");
      assert.equal(read(f.jsonPath), "", "the empty file was not overwritten with a stale copy");
      assert.equal(readJson(f.credentialsPath).claudeAiOauth.accessToken, "tok-A", "the credentials were restored");
    }

    // --- removing an account scrubs it from the rolling backup; another account's backup stays
    {
      const { f, dir, acc } = setup(); // live B
      await acc.switch("a@x.com");
      await acc.switch("b@x.com"); // the backup now holds A's login
      assert.equal(readJson(join(dir, ".backups", "live-login.json")).credentialsFile.claudeAiOauth.accessToken, "tok-A");
      const removedA = acc.remove("a@x.com");
      assert.equal(removedA.backupCleared, true);
      const backupText = existsSync(join(dir, ".backups", "live-login.json")) ? read(join(dir, ".backups", "live-login.json")) : "";
      assert.ok(!/tok-A|ref-A|a@x\.com/.test(backupText), "the removed login is gone from the backup");
      assert.equal(readJson(join(dir, "b@x.com.json")).credentials.accessToken, "tok-B", "the other profile is untouched");
      assert.equal(readJson(f.credentialsPath).claudeAiOauth.accessToken, "tok-B");
    }
    {
      const { dir, acc } = setup(); // live B
      await acc.switch("a@x.com"); // the backup holds B's login
      assert.equal(acc.remove("a@x.com").backupCleared, false, "the backup belongs to B");
      assert.equal(readJson(join(dir, ".backups", "live-login.json")).credentialsFile.claudeAiOauth.accessToken, "tok-B");
    }

    // --- usage: an email-only match uses the profile's own saved login while it is valid
    {
      const { f, acc } = setup(); // live B
      writeFileSync(f.credentialsPath, JSON.stringify(credentials("tok-X", "ref-X", "pro")));
      const seen = [];
      acc.fetchImplementation = async (url, init) => {
        seen.push(init.headers.authorization);
        return { ok: true, status: 200, json: async () => okUsage };
      };
      await acc.usage("b@x.com");
      assert.equal(seen.pop(), "Bearer tok-B", "an unverified live token is not attributed to the saved account");
      await acc.usage();
      assert.equal(seen.pop(), "Bearer tok-X", "the active account always uses the live login");
    }
  }

  // =================================================================== unattended processes may not change the login
  {
    const f = fakeHome();
    const dir = join(sandbox("astack-profiles-"), "accounts");
    login(f, "a@x.com", "Org A", "tok-A", "ref-A");
    const owner = new ClaudeAccounts({ runtime: auditRuntime, claudeHome: f.home, directory: dir, listProcesses: async () => [], env: {}, harden: false });
    owner.save();
    login(f, "b@x.com", "Org B", "tok-B", "ref-B");
    owner.save();
    const frozen = { credentials: read(f.credentialsPath), json: read(f.jsonPath), profiles: readdirSync(dir).sort().join() };
    const child = new ClaudeAccounts({ runtime: auditRuntime, claudeHome: f.home, directory: dir, listProcesses: async () => [], env: { ASTACK_UNATTENDED: "1" }, harden: false });
    assert.equal((await child.list()).accounts.length, 2, "looking is allowed");
    for (const attempt of [() => child.save(), () => child.switch("a@x.com", { force: true }), () => child.label("a@x.com", "x"), () => child.remove("a@x.com")]) {
      await assert.rejects(async () => attempt(), (error) => error instanceof AccountError && error.status === 403 && error.code === "unattended");
    }
    assert.equal(read(f.credentialsPath), frozen.credentials);
    assert.equal(read(f.jsonPath), frozen.json);
    assert.equal(readdirSync(dir).sort().join(), frozen.profiles);

    // the CLI reaches the same service (Persian message, nothing changed)
    const savedEnv = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, ASTACK_ACCOUNTS_DIR: process.env.ASTACK_ACCOUNTS_DIR, ASTACK_UNATTENDED: process.env.ASTACK_UNATTENDED };
    process.env.CLAUDE_CONFIG_DIR = f.home;
    process.env.ASTACK_ACCOUNTS_DIR = dir;
    process.env.ASTACK_UNATTENDED = "1";
    const i18n = createLocalization();
    const quietLog = console.log;
    try {
      console.log = () => {};
      for (const tokens of [["switch", "a@x.com", "--force"], ["remove", "b@x.com"], ["save"], ["label", "a@x.com", "x"]]) {
        await assert.rejects(() => runAccountCommand({ runtime: auditRuntime, i18n, tokens }), (error) => /[؀-ۿ]/.test(error.message) && !/unattended/i.test(error.message), tokens.join(" "));
      }
      await runAccountCommand({ runtime: auditRuntime, i18n, tokens: ["list"] }); // reading still works
    } finally {
      console.log = quietLog;
      for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    assert.equal(read(f.credentialsPath), frozen.credentials, "the CLI changed nothing");
    assert.equal(readdirSync(dir).sort().join(), frozen.profiles);
  }

  // =================================================================== CLI errors are Persian; the CLI sees running chat turns
  {
    const f = fakeHome();
    const dir = join(sandbox("astack-profiles-"), "accounts");
    const savedEnv = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, ASTACK_ACCOUNTS_DIR: process.env.ASTACK_ACCOUNTS_DIR, ASTACK_UNATTENDED: process.env.ASTACK_UNATTENDED };
    process.env.CLAUDE_CONFIG_DIR = f.home;
    process.env.ASTACK_ACCOUNTS_DIR = dir;
    delete process.env.ASTACK_UNATTENDED;
    const i18n = createLocalization();
    const stateRoot = sandbox("astack-turns-");
    const cliRuntime = { audit: auditRuntime.audit, workspaceRoot: stateRoot };
    const lines = [];
    const realLog = console.log;
    const cli = async (...tokens) => {
      lines.length = 0;
      console.log = (line) => lines.push(String(line));
      try {
        await runAccountCommand({ runtime: cliRuntime, i18n, tokens });
      } finally {
        console.log = realLog;
      }
      return lines.join("\n");
    };
    try {
      await assert.rejects(() => cli("save"), (error) => /[؀-ۿ]/.test(error.message) && !/no Claude login/.test(error.message), "a missing login is explained in Persian");
      assert.match(await cli("usage"), /[؀-ۿ]/);
      assert.ok(!/no login/.test(lines.join("\n")), "the usage error is localized too");
      login(f, "a@x.com", "Org A", "tok-A", "ref-A");
      await cli("save");
      login(f, "b@x.com", "Org B", "tok-B", "ref-B");
      await cli("save");
      // a running console turn, recorded on disk by a live console process
      const turnsFile = turnsFilePath(cliRuntime);
      writeTurnsFile(turnsFile, [{ sessionId: "s1", startedAt: new Date().toISOString() }]);
      assert.equal(countLiveTurns(turnsFile), 1);
      assert.match(await cli("list"), /پاسخ‌های در حال اجرا: 1/);
      const frozen = read(f.credentialsPath);
      await assert.rejects(() => cli("switch", "a@x.com"), (error) => /--force/.test(error.message) && /[؀-ۿ]/.test(error.message), "the CLI refuses while a console turn runs");
      assert.equal(read(f.credentialsPath), frozen);
      assert.match(await cli("switch", "a@x.com", "--force"), /a@x\.com/);
      // a stale file of a console that is gone counts as nothing
      writeFileSync(turnsFile, JSON.stringify({ serverPid: 2147483000, updatedAt: new Date().toISOString(), turns: [{ sessionId: "old" }] }));
      assert.equal(countLiveTurns(turnsFile), 0);
      writeFileSync(turnsFile, JSON.stringify({ serverPid: process.pid, updatedAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(), turns: [{ sessionId: "old" }] }));
      assert.equal(countLiveTurns(turnsFile), 0, "an old file is ignored");
      assert.equal(countLiveTurns(join(stateRoot, "missing.json")), 0);
      assert.equal(countLiveTurns(null), 0);
      await cli("switch", "b@x.com");
      // the console's ChatManager keeps the file current
      const chatRuntime = { ...cliRuntime };
      const writer = new ChatManager({ runtime: chatRuntime, config: {}, home: f.home });
      writer.turns.set("s9", { sessionId: "s9", startedAt: new Date().toISOString() });
      writer.persistTurns();
      assert.equal(countLiveTurns(turnsFile), 1);
      writer.turns.delete("s9");
      writer.persistTurns();
      assert.equal(countLiveTurns(turnsFile), 0);
    } finally {
      for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  // =================================================================== chat integration
  assert.ok(CHAT_STATE_DENIES.includes("Read(//**/.astack/accounts/**)"), "a chat can never read the saved accounts");
  assert.ok(CHAT_STATE_DENIES.includes("Edit(//**/.astack/accounts/**)"));
  assert.ok(CHAT_STATE_DENIES.includes("Bash(*.astack/accounts*)"));
  assert.ok(CHAT_STATE_DENIES.includes("Read(//**/.credentials.json)"));
  // the live login through a shell (best effort text rules), both shells
  for (const tool of ["Bash", "PowerShell"]) {
    for (const pattern of ["*.credentials.json*", "*.cred*", "*Claude Code-credentials*", "*find-generic-password*"]) {
      assert.ok(CHAT_STATE_DENIES.includes(tool + "(" + pattern + ")"), tool + " denies " + pattern);
    }
    for (const verb of ["save", "switch", "remove", "rm", "label"]) {
      assert.ok(CHAT_STATE_DENIES.includes(tool + "(*astack* account* " + verb + "*)"), tool + " denies account " + verb);
      assert.ok(CHAT_STATE_DENIES.includes(tool + "(*astack.mjs* account* " + verb + "*)"));
    }
  }
  assert.ok(CHAT_STATE_DENIES.includes("PowerShell(*.astack*)"), "PowerShell mirrors the mandatory Bash(*.astack*) rule");
  assert.equal(accountsDirectoryDenies({ ASTACK_ACCOUNTS_DIR: join(tmpdir(), "acc") }).length, 2);
  assert.deepEqual(accountsDirectoryDenies({}), []);
  if (process.platform === "win32") {
    assert.deepEqual(accountsDirectoryDenies({ ASTACK_ACCOUNTS_DIR: "D:\\acc\\" }), ["Read(//d/acc/**)", "Edit(//d/acc/**)"], "a moved accounts folder is denied too");
  }
  const manager = new ChatManager({ runtime, config: {}, home: apiFake.home, accountEmail: () => "z@example.com" });
  assert.equal(manager.activeAccount(), "z@example.com");
  const quiet = new ChatManager({ runtime, config: {}, home: apiFake.home, accountEmail: () => {
    throw new Error("boom");
  } });
  assert.equal(quiet.activeAccount(), null, "a failing lookup never blocks a chat turn");
  assert.equal(new ChatManager({ runtime, config: {}, home: apiFake.home }).activeAccount(), null);

  // ---- add another account without touching the live login (a fake `claude auth login`)
  {
    const { EventEmitter } = await import("node:events");
    const { PassThrough } = await import("node:stream");
    const f = fakeHome();
    const dir = sandbox("astack-accounts-add-");
    login(f, "first@x.com", "Org One", "tok-ONE", "ref-ONE");
    const liveBefore = { credentials: readFileSync(f.credentialsPath, "utf8"), json: readFileSync(f.jsonPath, "utf8") };
    let started = null;
    const fakeLogin = (outcome) => (args, env) => {
      started = { args, configDir: env.CLAUDE_CONFIG_DIR };
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 0;
      child.exitCode = null;
      setTimeout(() => {
        child.stdout.write("Opening browser to sign in…\nIf it does not open, visit: https://claude.ai/oauth/authorize?code=true&client_id=abc\n");
      }, 20);
      setTimeout(() => {
        if (outcome === "ok") {
          // what the real command leaves in its own CLAUDE_CONFIG_DIR
          writeFileSync(join(env.CLAUDE_CONFIG_DIR, ".credentials.json"), JSON.stringify(credentials("tok-TWO", "ref-TWO", "pro")));
          writeFileSync(join(env.CLAUDE_CONFIG_DIR, ".claude.json"), claudeJson(accountRaw("second@x.com", "Org Two")));
        }
        child.exitCode = outcome === "ok" ? 0 : 1;
        child.emit("close", child.exitCode);
      }, 120);
      return child;
    };
    const acc = new ClaudeAccounts({ runtime: auditRuntime, claudeHome: f.home, directory: dir, listProcesses: async () => [], env: {}, harden: false, startLogin: fakeLogin("ok") });
    acc.save();
    const began = acc.startAddLogin({ email: "second@x.com", label: "Work" });
    assert.equal(began.state, "running");
    assert.deepEqual(started.args, ["auth", "login", "--claudeai", "--email", "second@x.com"]);
    assert.notEqual(started.configDir, f.home, "the sign-in runs in its own throw-away config folder");
    assert.throws(() => acc.startAddLogin({}), (error) => error.code === "login-running", "one sign-in at a time");
    await new Promise((done) => setTimeout(done, 60));
    assert.match(acc.loginView().url, /^https:\/\/claude\.ai\/oauth\/authorize/, "the sign-in link is picked up from the command output");
    await new Promise((done) => setTimeout(done, 200));
    const done = acc.loginView();
    assert.equal(done.state, "done", JSON.stringify(done));
    assert.equal(done.account.email, "second@x.com");
    assert.equal(done.account.label, "Work");
    assert.equal(readFileSync(f.credentialsPath, "utf8"), liveBefore.credentials, "the live login credentials were not touched");
    assert.equal(readFileSync(f.jsonPath, "utf8"), liveBefore.json, "the live .claude.json was not touched");
    assert.ok(!existsSync(started.configDir), "the throw-away folder with the new tokens is deleted");
    const listed = await acc.list();
    assert.equal(listed.accounts.length, 2, "both accounts are saved: the first one and the added one");
    assert.ok(!JSON.stringify([acc.loginView(), listed]).includes("tok-TWO"), "no token in what the API shows");
    assert.ok(audits.some((entry) => entry.action === "claude-account-add" && !JSON.stringify(entry).includes("tok-")), "added accounts are audited without secrets");
    // switching to the added account works like any other profile
    const switched = await acc.switch(done.account.id, { force: true });
    assert.ok(switched.active.email === "second@x.com" || switched.active?.profileId === done.account.id);

    // a failed or cancelled sign-in leaves nothing behind
    const bad = new ClaudeAccounts({ runtime: auditRuntime, claudeHome: f.home, directory: dir, listProcesses: async () => [], env: {}, harden: false, startLogin: fakeLogin("fail") });
    bad.startAddLogin({});
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    assert.equal(bad.loginView().state, "failed");
    assert.equal(bad.loginView().code, "login-failed");
    assert.ok(!existsSync(started.configDir), "the folder of a failed sign-in is deleted");
    assert.throws(() => bad.startAddLogin({ email: "not an email" }), (error) => error.code === "bad-email");
    const gone = new ClaudeAccounts({ runtime: auditRuntime, claudeHome: f.home, directory: dir, listProcesses: async () => [], env: {}, harden: false, startLogin: () => { throw new AccountError(409, "Claude Code was not found on this computer", null, "no-claude"); } });
    assert.throws(() => gone.startAddLogin({}), (error) => error.code === "no-claude");
    assert.equal(readdirSync(dir).filter((name) => name.startsWith(".login-")).length, 0, "no sign-in folder is left in the profile folder");
    // unattended processes may never start a sign-in
    const robot = new ClaudeAccounts({ runtime: auditRuntime, claudeHome: f.home, directory: dir, listProcesses: async () => [], env: { ASTACK_UNATTENDED: "1" }, harden: false, startLogin: fakeLogin("ok") });
    assert.throws(() => robot.startAddLogin({}), (error) => error.code === "unattended");
  }

  console.log("verify-console-accounts: ok");
} finally {
  for (const server of servers) {
    await server.stop?.().catch?.(() => {});
  }
  for (const directory of sandboxes) {
    rmSync(directory, { recursive: true, force: true });
  }
}
