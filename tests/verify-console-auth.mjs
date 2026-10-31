import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signData } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRuntime } from "../runtime/astack-runtime.mjs";
import { ConsoleServer, resolveRemoteSettings } from "../console/server.mjs";
import { ConsoleAuth } from "../console/auth.mjs";
import { ConsoleUsers, MIN_PASSWORD_LENGTH, ROLES, STRONG_PASSWORD_LENGTH, normalizeUsername, passwordProblem, totp } from "../console/users.mjs";
import { AUTH_MODES, setConsoleAuth, withConsoleAuth } from "../console/config-edit.mjs";
import { discoverProjectFolders } from "../console/project-folders.mjs";
import { ChatManager } from "../console/chats.mjs";
import { claudeSlug } from "../search-engine/sources/sessions.mjs";

/**
 * Admin sign-in for the Aramis console: the first administrator, username and
 * password sign-in, roles, last-admin protection, changing one's own password
 * and TOTP, the local-only user routes, `console.auth`, and
 * `console.chats.projects: all`. Every workspace, password and Claude home here
 * is a throwaway in the temp folder; nothing real is read or written.
 */
const repoRoot = process.cwd();
const sandboxes = [];
const servers = [];
const closers = [];
function sandbox(prefix = "astack-auth-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  sandboxes.push(directory);
  return directory;
}
function workspace() {
  const directory = sandbox();
  cpSync(join(repoRoot, "context-engine", "lenses.json"), join(directory, "context-engine", "lenses.json"));
  return directory;
}

// The responses and logs of the whole run, scanned for secrets at the end.
const seen = [];
function call(base, path, { method = "GET", body, cookie, csrf, origin, host, headers = {} } = {}) {
  const all = { accept: "application/json", ...headers };
  if (body !== undefined) all["content-type"] = "application/json";
  if (cookie) all.cookie = cookie;
  if (csrf) all["x-csrf-token"] = csrf;
  if (origin) all.origin = origin;
  if (host) all.host = host;
  return new Promise((resolvePromise, reject) => {
    const url = new URL(path, base);
    const req = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: all }, (res) => {
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
        seen.push({ path, text });
        resolvePromise({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const logs = [];
async function start(options) {
  const server = new ConsoleServer({ port: 0, pollMs: 300, log: (line) => logs.push(line), totpVault: null, ...options });
  servers.push(server);
  await server.start();
  return server;
}
const cookieOf = (response) => String(response.headers["set-cookie"] ?? "").split(";")[0];

// A fake clock: sign-in lockouts and TOTP steps move with it.
let now = Date.parse("2026-10-14T10:00:00Z");
const clock = () => new Date(now);
const tick = (ms = 30000) => {
  now += ms;
};
// Past every lockout window (15 minutes) and per-minute counter.
const calm = () => tick(16 * 60 * 1000);

// Test-only secrets. They must never show up in a response, an audit record, a log or a state file.
const PW = {
  first: "Orchard-Lantern-4471",
  second: "Granite-Meadow-8830",
  helper: "Willow-Compass-2257",
  changed: "Copper-Harbor-9162",
  fresh: "Juniper-Anvil-3548",
  remote: "Saffron-Bridge-7719",
  plain: "Cobalt-Ferry-6604"
};

try {
  // ======================================================== pure: passwords
  assert.equal(STRONG_PASSWORD_LENGTH, 12);
  assert.ok(MIN_PASSWORD_LENGTH <= STRONG_PASSWORD_LENGTH, "the command line keeps its shorter minimum");
  assert.deepEqual(ROLES, ["admin", "user"]);
  assert.equal(passwordProblem("short1", "ali"), "short", "fewer than 12 characters");
  assert.equal(passwordProblem("", "ali"), "short");
  assert.equal(passwordProblem(undefined, "ali"), "short");
  assert.equal(passwordProblem("x".repeat(257) + "y", "ali"), "long");
  assert.equal(passwordProblem("123456789012345", "ali"), "digits", "digits only");
  assert.equal(passwordProblem("longusername01", "longusername01"), "username", "same as the username");
  assert.equal(passwordProblem("LongUserName01", "longusername01"), "username", "the username in another case");
  assert.equal(passwordProblem("long.user-name01", "longusername01"), "username", "the username with punctuation");
  assert.equal(passwordProblem("aaaaaaaaaaaaaaaa", "ali"), "repeated", "one repeated character");
  assert.equal(passwordProblem("abababababababab", "ali"), "repeated", "two characters only");
  assert.equal(passwordProblem("Administrator", "ali"), "common", "a well-known password");
  assert.equal(passwordProblem("P@ssw0rd1234", "ali"), "common", "a well-known password with symbols");
  assert.equal(passwordProblem(PW.first, "owner"), null, "a long passphrase with words and digits is accepted");
  assert.equal(normalizeUsername(" Ali.Ramin "), "ali.ramin");
  assert.equal(normalizeUsername("!bad name"), null);
  assert.equal(normalizeUsername("a"), null);

  // ========================================================= pure: roles
  const usersDirectory = sandbox("astack-auth-users-");
  const unit = new ConsoleUsers(usersDirectory, { clock, vault: null });
  await unit.set("legacy", PW.first);
  // A record from before roles existed carries none, and is an administrator.
  assert.equal(unit.get("legacy").role, undefined);
  assert.equal(unit.roleOf("legacy"), "admin", "a user without a role is an administrator");
  assert.equal(unit.list()[0].role, "admin");
  assert.equal(unit.isAdmin("legacy"), true);
  assert.equal(unit.adminCount(), 1);
  assert.equal(unit.roleOf("nobody"), null);
  await unit.set("member", PW.second, { role: "user" });
  assert.equal(unit.roleOf("member"), "user");
  assert.equal(unit.isAdmin("member"), false);
  await assert.rejects(() => unit.set("odd", PW.second, { role: "root" }), /admin or user/);
  assert.throws(() => unit.setRole("legacy", "user"), /last administrator/, "the last administrator cannot be demoted");
  assert.throws(() => unit.setRole("member", "root"), /admin or user/);
  assert.throws(() => unit.setRole("ghost", "user"), /Unknown/);
  unit.setRole("member", "admin");
  assert.equal(unit.adminCount(), 2);
  unit.setRole("legacy", "user");
  assert.equal(unit.roleOf("legacy"), "user");
  assert.throws(() => unit.setRole("member", "user"), /last administrator/);
  // touchLogin remembers the time and leaves the credentials alone.
  const versionBefore = unit.credentialVersion("member");
  assert.equal(unit.get("member").lastLoginAt, undefined);
  unit.touchLogin("member");
  assert.equal(unit.get("member").lastLoginAt, new Date(now).toISOString());
  assert.equal(unit.credentialVersion("member"), versionBefore, "signing in does not change the credential version");
  unit.touchLogin("ghost");
  assert.equal(unit.count(), 2, "touching an unknown user creates nothing");
  // set() keeps an existing role when none is given.
  await unit.set("member", PW.helper);
  assert.equal(unit.roleOf("member"), "admin", "changing a password keeps the role");
  assert.notEqual(unit.credentialVersion("member"), versionBefore, "but changes the credential version");

  // =============================================== pure: ConsoleAuth sessions
  const authDirectory = sandbox("astack-auth-sessions-");
  const sessionsAuth = new ConsoleAuth(authDirectory, { clock });
  const tokenSession = sessionsAuth.createSession({});
  const otherUser = sessionsAuth.createSession({ user: "bea", credentialVersion: "v1", method: "password" });
  const mineOne = sessionsAuth.createSession({ user: "cleo", credentialVersion: "v1", method: "password" });
  const mineTwo = sessionsAuth.createSession({ user: "cleo", credentialVersion: "v1", method: "password" });
  const mineThree = sessionsAuth.createSession({ user: "cleo", credentialVersion: "v1", method: "password" });
  const keptKey = sessionsAuth.session(mineTwo.id).key;
  assert.equal(sessionsAuth.keepOnlySession("Cleo", keptKey, "v2"), 2, "the other sessions of that user end");
  assert.ok(sessionsAuth.session(mineTwo.id), "the session in use stays");
  assert.equal(sessionsAuth.session(mineTwo.id).credentialVersion, "v2", "and is bound to the new credential version");
  assert.equal(sessionsAuth.session(mineOne.id), null);
  assert.equal(sessionsAuth.session(mineThree.id), null);
  assert.ok(sessionsAuth.session(otherUser.id), "another user's session is untouched");
  assert.ok(sessionsAuth.session(tokenSession.id), "a token session is untouched");
  assert.equal(sessionsAuth.session(otherUser.id).credentialVersion, "v1");
  assert.equal(sessionsAuth.keepOnlySession("cleo", keptKey, null), 0, "nothing else to end");
  assert.equal(sessionsAuth.session(mineTwo.id).credentialVersion, "v2", "no new version given: the old one stays");
  assert.equal(sessionsAuth.destroyUserSessions("cleo"), 1);

  // ========================================== pure: console.auth text edit
  const sample = [
    "# AStack configuration",
    "language:",
    "  ui: fa   # interface",
    "",
    "console:",
    "  # who may sign in",
    "  port: 7717",
    "  chats:",
    "    enabled: true",
    "  # trailing note about remote access",
    "",
    "other:",
    "  value: 1",
    ""
  ];
  const crlfSample = sample.join("\r\n");
  const lfSample = sample.join("\n");
  const inserted = withConsoleAuth(crlfSample, "password");
  assert.ok(inserted.text, "a plain console section is edited");
  assert.ok(inserted.text.includes("  auth: password\r\n"), "the line is added");
  assert.ok(!/[^\r]\n/.test(inserted.text), "every line break is still CRLF");
  const insertedLines = inserted.text.split("\r\n");
  assert.equal(insertedLines.indexOf("  auth: password"), insertedLines.indexOf("    enabled: true") + 1, "inserted after the last setting, above the trailing comment");
  assert.ok(insertedLines.indexOf("  # trailing note about remote access") > insertedLines.indexOf("  auth: password"), "the trailing comment stays below");
  for (const line of ["# AStack configuration", "  ui: fa   # interface", "  # who may sign in", "other:", "  value: 1"]) {
    assert.ok(insertedLines.includes(line), "untouched: " + line);
  }
  assert.equal(insertedLines.length, sample.length + 1, "exactly one line was added");
  const insertedLf = withConsoleAuth(lfSample, "both");
  assert.ok(!insertedLf.text.includes("\r"), "an LF file stays LF");
  // Replace in place, keep the comment and the indent.
  const changed = withConsoleAuth("console:\r\n    port: 1\r\n    auth: token   # keep this note\r\n", "both");
  assert.equal(changed.text, "console:\r\n    port: 1\r\n    auth: both   # keep this note\r\n", "the existing line is replaced, comment and four-space indent kept");
  assert.equal(withConsoleAuth("console:\n  auth : token\n", "password").text, "console:\n  auth: password\n", "auth with a space before the colon is replaced, not duplicated");
  assert.equal(withConsoleAuth(changed.text, "both").text, changed.text, "the same mode changes nothing");
  // No console section: appended, newline style followed, file without a final newline handled.
  const appended = withConsoleAuth("language:\r\n  ui: fa", "password");
  assert.equal(appended.text, "language:\r\n  ui: fa\r\n\r\nconsole:\r\n  auth: password\r\n");
  assert.equal(withConsoleAuth("language:\n  ui: fa\n", "both").text, "language:\n  ui: fa\n\nconsole:\n  auth: both\n");
  assert.equal(withConsoleAuth("", "password").text, "\nconsole:\n  auth: password\n");
  // A commented heading is still the section; a nested auth key elsewhere is not ours.
  assert.equal(withConsoleAuth("console:   # the console\n  port: 1\nremote:\n  auth: x\n", "password").text, "console:   # the console\n  port: 1\n  auth: password\nremote:\n  auth: x\n");
  // Unusual shapes: nothing is guessed.
  for (const odd of ["console: { port: 7717 }\n", "console: {}\n", "console:   null\n"]) {
    assert.deepEqual(withConsoleAuth(odd, "password"), { manual: true }, "unusual shape: " + odd.trim());
  }
  assert.deepEqual(AUTH_MODES, ["token", "password", "both"]);

  // ================================== pure: setConsoleAuth on a temp config
  const editRoot = sandbox("astack-auth-config-");
  const configPath = join(editRoot, "astack.config.yaml");
  const backupsRoot = join(editRoot, ".astack", "backups");
  writeFileSync(configPath, crlfSample);
  assert.throws(() => setConsoleAuth({ configPath, backupsRoot, mode: "open" }), /token, password or both/);
  assert.equal(readFileSync(configPath, "utf8"), crlfSample, "a refused mode writes nothing");
  assert.deepEqual(setConsoleAuth({ configPath: null, backupsRoot, mode: "password" }), { persisted: false, line: "console:\n  auth: password", reason: "no astack.config.yaml" });
  assert.equal(setConsoleAuth({ configPath: join(editRoot, "missing.yaml"), backupsRoot, mode: "password" }).persisted, false);
  const saved = setConsoleAuth({ configPath, backupsRoot, mode: "password", clock });
  assert.equal(saved.persisted, true);
  assert.equal(saved.changed, true);
  assert.equal(readFileSync(configPath, "utf8"), inserted.text, "the file is exactly the pure edit");
  assert.ok(saved.backup && saved.backup.startsWith(backupsRoot), "the backup lives under .astack/backups");
  assert.match(saved.backup, /console-auth-\d{8}T\d{6}$/);
  assert.equal(readFileSync(join(saved.backup, "astack.config.yaml"), "utf8"), crlfSample, "the backup is the file as it was, CRLF included");
  assert.ok(!readdirSync(editRoot).some((name) => name.endsWith(".tmp")), "no temporary file is left");
  const again = setConsoleAuth({ configPath, backupsRoot, mode: "password", clock });
  assert.deepEqual({ persisted: again.persisted, changed: again.changed, backup: again.backup }, { persisted: true, changed: false, backup: undefined }, "the same mode again writes and backs up nothing");
  assert.equal(readdirSync(backupsRoot).length, 1);
  const second = setConsoleAuth({ configPath, backupsRoot, mode: "both", clock });
  assert.notEqual(second.backup, saved.backup, "a second change in the same second gets its own backup");
  assert.equal(readFileSync(join(saved.backup, "astack.config.yaml"), "utf8"), crlfSample, "and the first backup is not overwritten");
  assert.equal(readFileSync(join(second.backup, "astack.config.yaml"), "utf8"), inserted.text);
  assert.equal(readFileSync(configPath, "utf8"), withConsoleAuth(inserted.text, "both").text);
  writeFileSync(configPath, inserted.text);
  // An unusual shape: the exact line comes back and the file is untouched.
  const oddPath = join(editRoot, "odd.yaml");
  const oddText = "language:\r\n  ui: fa\r\nconsole: { port: 7717 }\r\n";
  writeFileSync(oddPath, oddText);
  const manual = setConsoleAuth({ configPath: oddPath, backupsRoot: join(editRoot, "odd-backups"), mode: "both" });
  assert.equal(manual.persisted, false);
  assert.equal(manual.line, "console:\n  auth: both", "the manual line to add by hand");
  assert.match(manual.reason, /unusual shape/);
  assert.equal(readFileSync(oddPath, "utf8"), oddText, "nothing is written");
  assert.ok(!existsSync(join(editRoot, "odd-backups")), "and no backup is made");

  // =========================================================== fake workspaces
  // A fake Claude home with two live projects and one deleted project folder.
  const claudeHome = sandbox("astack-auth-claude-");
  const projectA = sandbox("astack-auth-project-a-");
  const projectB = sandbox("astack-auth-project-b-");
  const projectGone = sandbox("astack-auth-project-gone-");
  const line = (entry) => JSON.stringify(entry);
  function transcript(projectPath, id, prompt) {
    const folder = join(claudeHome, "projects", claudeSlug(resolve(projectPath)));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, id + ".jsonl"), [
      line({ type: "user", uuid: "u-" + id, sessionId: id, timestamp: "2026-10-10T08:00:00.000Z", cwd: resolve(projectPath), message: { role: "user", content: prompt } }),
      line({ type: "assistant", uuid: "a-" + id, sessionId: id, timestamp: "2026-10-10T08:00:05.000Z", message: { id: "m-" + id, role: "assistant", content: [{ type: "text", text: "ok" }] } })
    ].join("\n") + "\n");
  }
  transcript(projectA, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "first project question");
  transcript(projectB, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "second project question");
  transcript(projectGone, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "this project folder is deleted");
  rmSync(projectGone, { recursive: true, force: true });
  assert.ok(!existsSync(projectGone));

  const discovered = discoverProjectFolders(claudeHome);
  assert.deepEqual(discovered.map((entry) => resolve(entry.path).toLowerCase()).sort(), [resolve(projectA).toLowerCase(), resolve(projectB).toLowerCase()].sort(), "discovery lists the two live projects and skips the deleted folder");

  // The runtime reads its configuration from the repository; point it at a
  // throwaway file so the console never edits the real astack.config.yaml.
  function fakeConfiguration(runtime, path) {
    const real = runtime.configuration;
    runtime.configuration = { path, section: (name, fallback) => real.section(name, fallback), get: (key, fallback) => real.get(key, fallback) };
  }

  // ----------------------------------------- console.chats.projects: all (unit)
  const unitWorkspace = workspace();
  const unitRuntime = createRuntime({ workspaceRoot: unitWorkspace });
  const wide = new ChatManager({ runtime: unitRuntime, config: { projects: "all" }, home: claudeHome });
  assert.equal(wide.allProjects(), true);
  const wideList = wide.projects();
  assert.equal(wideList.length, 3, "all: the workspace and both live projects");
  assert.deepEqual(wideList.map((entry) => entry.index), [0, 1, 2]);
  assert.equal(resolve(wideList[0].path), resolve(unitWorkspace));
  assert.ok(wideList.every((entry) => entry.exists), "a deleted project folder is skipped");
  assert.ok(!wideList.some((entry) => entry.path.toLowerCase().includes("gone")));
  assert.equal(new ChatManager({ runtime: unitRuntime, config: { projects: ["all"] }, home: claudeHome }).projects().length, 3, "a list holding all works too");
  assert.equal(new ChatManager({ runtime: unitRuntime, config: { projects: "*" }, home: claudeHome }).projects().length, 3, "so does *");
  assert.deepEqual(wide.projects({ restricted: true }).map((entry) => resolve(entry.path)), [resolve(unitWorkspace)], "restricted (internet listener or non-admin): the workspace only");
  const mixed = new ChatManager({ runtime: unitRuntime, config: { projects: [projectA, "all"] }, home: claudeHome });
  assert.deepEqual(mixed.projects({ restricted: true }).map((entry) => resolve(entry.path)), [resolve(projectA)], "restricted keeps the explicit entries, not the discovered ones");
  assert.equal(mixed.projects().length, 3, "an explicit entry that discovery also finds is listed once");
  const plain = new ChatManager({ runtime: unitRuntime, config: {}, home: claudeHome });
  assert.equal(plain.allProjects(), false);
  assert.deepEqual(plain.projects().map((entry) => resolve(entry.path)), [resolve(unitWorkspace)], "without all: the workspace only, as before");
  const wideListing = wide.list({});
  assert.deepEqual(wideListing.projects.map((entry) => entry.sessions), [0, 1, 1]);
  assert.equal(wide.list({ restricted: true }).projects.length, 1);
  assert.equal(wide.list({ restricted: true }).items.length, 0, "a restricted listing sees no session of another project");
  assert.ok(wide.locate("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), "an admin can open a session of a discovered project");
  assert.equal(wide.locate("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { restricted: true }), null, "a restricted caller cannot");

  // ================================================= local server, first run
  const workspaceOne = workspace();
  const runtimeOne = createRuntime({ workspaceRoot: workspaceOne });
  const configOne = join(workspaceOne, "astack.config.yaml");
  writeFileSync(configOne, crlfSample);
  fakeConfiguration(runtimeOne, configOne);
  const server = await start({ runtime: runtimeOne, clock, lockout: { attempts: 4, minutes: 15 }, claudeHome, chats: { projects: "all" } });
  const base = server.origin;
  const token = readFileSync(join(workspaceOne, ".astack", "console", "token"), "utf8").trim();
  const sessionOf = (response) => ({ cookie: cookieOf(response), csrf: response.json.csrf });
  const get = (session, path) => call(base, path, { cookie: session?.cookie });
  const post = (session, path, body = {}) => call(base, path, { method: "POST", body, cookie: session?.cookie, csrf: session?.csrf, origin: base });
  const loginWith = (body, headers = {}) => call(base, "/api/login", { method: "POST", body, origin: base, headers });

  const firstScreen = (await call(base, "/api/session")).json;
  assert.equal(firstScreen.authenticated, false);
  assert.equal(firstScreen.login.firstRun, true, "no user yet: the login screen offers the first administrator");
  assert.deepEqual(firstScreen.login.methods, ["token"]);
  assert.equal(server.authMode(), "token");

  // Nothing is reachable without a session.
  assert.equal((await call(base, "/api/users")).status, 401);
  assert.equal((await call(base, "/api/users", { method: "POST", body: { username: "intruder", password: PW.first }, origin: base })).status, 401, "no session, no first administrator");
  assert.equal((await call(base, "/api/users/auth-mode", { method: "POST", body: { mode: "password" }, origin: base })).status, 401);
  assert.equal(server.users.count(), 0);

  // The first administrator comes from a one-time ticket session on this computer.
  const ticketLogin = await loginWith({ ticket: server.auth.issueTicket() });
  assert.equal(ticketLogin.status, 200);
  const ticket = sessionOf(ticketLogin);
  const setup = (await get(ticket, "/api/users")).json.data;
  assert.equal(setup.setup.needed, true);
  assert.equal(setup.setup.canCreate, true);
  assert.deepEqual(setup.users, []);
  assert.equal(setup.me.admin, true, "the machine owner's token or ticket session acts as an administrator");
  assert.equal(setup.me.username, null);
  assert.equal(setup.local, true);
  assert.equal(setup.minPassword, 12);
  assert.deepEqual(setup.roles, ["admin", "user"]);
  assert.equal(setup.canRequirePassword, false, "no administrator yet: token sign-in cannot be turned off");
  assert.equal(setup.authMode, "token");

  // Weak and malformed choices are refused with the right code, and create nothing.
  const refused = async (body, status, reason) => {
    const response = await post(ticket, "/api/users", body);
    assert.equal(response.status, status, JSON.stringify({ ...body, password: "…" }) + " -> " + response.text.replace(/"password":"[^"]*"/, ""));
    assert.equal(response.json.ok, false);
    assert.equal(response.json.reason, reason);
    assert.equal(server.users.count(), 0, "nothing was created");
  };
  await refused({ username: "ali", password: "short1" }, 400, "short");
  await refused({ username: "ali", password: "123456789012345" }, 400, "digits");
  await refused({ username: "longusername01", password: "longusername01" }, 400, "username");
  await refused({ username: "ali", password: "aaaaaaaaaaaaaaaa" }, 400, "repeated");
  await refused({ username: "ali", password: "Administrator" }, 400, "common");
  await refused({ username: "ali", password: "x".repeat(300) }, 400, "long");
  await refused({ username: "ali", password: 12345678901234 }, 400, "short");
  await refused({ username: "ali" }, 400, "short");
  await refused({ username: "ali", password: PW.first, confirm: PW.second }, 400, "mismatch");
  await refused({ username: "!bad name", password: PW.first }, 400, "username-format");
  await refused({ password: PW.first }, 400, "username-format");
  assert.ok(!existsSync(join(workspaceOne, ".astack", "console", "users.json")), "refused choices never reach the disk");

  // Turning token sign-in off needs an administrator who can sign in instead.
  const noAdmin = await post(ticket, "/api/users/auth-mode", { mode: "password" });
  assert.equal(noAdmin.status, 409);
  assert.equal(noAdmin.json.reason, "no-admin");
  assert.equal(server.authMode(), "token");
  assert.equal(readFileSync(configOne, "utf8"), crlfSample, "a refused change writes nothing");

  // The first administrator.
  const created = await post(ticket, "/api/users", { username: "Owner", password: PW.first, confirm: PW.first });
  assert.equal(created.status, 200, created.text);
  assert.deepEqual(created.json.data, { username: "owner", role: "admin", created: true, firstAdmin: true, authMode: "both" });
  assert.equal(server.users.roleOf("owner"), "admin");
  assert.equal(server.users.count(), 1);
  const stored = readFileSync(join(workspaceOne, ".astack", "console", "users.json"), "utf8");
  assert.ok(!stored.includes(PW.first), "the password is stored only as a salted hash");
  assert.match(JSON.parse(stored).users.owner.hash, /^scrypt\$131072\$8\$1\$/);
  assert.equal((await post(ticket, "/api/users", { username: "owner", password: PW.second })).status, 409, "a taken username");
  assert.equal((await post(ticket, "/api/users", { username: "owner", password: PW.second })).json.reason, "exists");
  assert.equal((await get(ticket, "/api/users")).json.data.setup.needed, false, "the first-run screen is gone");
  assert.equal((await get(ticket, "/api/users")).json.data.setup.canCreate, false);
  assert.equal((await call(base, "/api/session")).json.login.firstRun, false);
  assert.deepEqual((await call(base, "/api/session")).json.login.methods, ["password", "token"], "with a user, both sign-in methods are offered");

  // ----------------------------------------------------- username + password sign-in
  const wrongPassword = await loginWith({ username: "owner", password: "not-the-password-1" });
  const unknownUser = await loginWith({ username: "nobody", password: "not-the-password-1" });
  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownUser.status, 401);
  assert.equal(wrongPassword.text, unknownUser.text, "a wrong password and an unknown user get the very same answer");
  assert.equal(wrongPassword.json.error, "invalid credentials");
  assert.equal((await loginWith({ username: "owner" })).status, 401, "no password");
  assert.equal((await loginWith({ username: "owner", password: PW.first }, {})).status, 200, "a forgotten session, ended later with the others");
  assert.equal((await call(base, "/api/login", { method: "POST", body: { username: "owner", password: PW.first }, origin: "http://evil.example" })).status, 403, "cross-origin sign-in refused");
  calm();

  const ownerLogin = await loginWith({ username: "owner", password: PW.first });
  assert.equal(ownerLogin.status, 200);
  assert.match(String(ownerLogin.headers["set-cookie"]), /HttpOnly/);
  const owner = sessionOf(ownerLogin);
  const me = (await get(owner, "/api/session")).json;
  assert.equal(me.authenticated, true);
  assert.equal(me.user, "owner");
  assert.equal(me.role, "admin");
  assert.equal(me.method, "password");
  assert.ok(server.users.get("owner").lastLoginAt, "the last sign-in time is remembered");
  const tokenMe = (await get(ticket, "/api/session")).json;
  assert.equal(tokenMe.role, "admin", "a token session without a user is the machine owner");
  assert.equal(tokenMe.user, null);

  // -------------------------------------------------------- roles and users
  const view = (await get(owner, "/api/users")).json.data;
  assert.equal(view.me.username, "owner");
  assert.equal(view.me.admin, true);
  assert.deepEqual(view.users.map((user) => [user.username, user.role, user.current]), [["owner", "admin", true]]);
  const badRole = await post(owner, "/api/users", { username: "x9", password: PW.fresh, role: "root" });
  assert.equal(badRole.status, 400);
  assert.equal(badRole.json.reason, "role");
  assert.equal(server.users.get("x9"), null);
  const helperCreate = await post(owner, "/api/users", { username: "helper", password: PW.helper });
  assert.equal(helperCreate.status, 200, helperCreate.text);
  assert.equal(helperCreate.json.data.role, "user", "a user added later is a plain user unless made an administrator");
  assert.equal(helperCreate.json.data.firstAdmin, false);
  const secondAdmin = await post(owner, "/api/users", { username: "second", password: PW.second, role: "admin" });
  assert.equal(secondAdmin.json.data.role, "admin");
  assert.equal(server.users.adminCount(), 2);
  assert.equal((await post(ticket, "/api/users", { username: "viatoken", password: PW.fresh })).status, 200, "the machine owner's token session can add users too");
  await post(ticket, "/api/users/remove", { username: "viatoken" });

  // A plain user: sees only themselves, manages nobody.
  const helperLogin = await loginWith({ username: "helper", password: PW.helper });
  assert.equal(helperLogin.status, 200);
  const helper = sessionOf(helperLogin);
  assert.equal((await get(helper, "/api/session")).json.role, "user");
  const helperView = (await get(helper, "/api/users")).json.data;
  assert.equal(helperView.me.admin, false);
  assert.deepEqual(helperView.users.map((user) => user.username), ["helper"], "a plain user sees only themselves");
  assert.equal(helperView.canRequirePassword, false);
  for (const [path, body] of [["/api/users", { username: "x1", password: PW.fresh }], ["/api/users/remove", { username: "second" }], ["/api/users/role", { username: "helper", role: "admin" }], ["/api/users/auth-mode", { mode: "password" }]]) {
    const attempt = await post(helper, path, body);
    assert.equal(attempt.status, 403, path + " is for administrators");
  }
  assert.equal(server.users.get("x1"), null);
  assert.equal(server.users.roleOf("helper"), "user", "a user cannot promote themselves");
  assert.equal(server.authMode(), "both");

  // Last-admin protection.
  calm();
  assert.equal((await post(owner, "/api/users/role", { username: "second", role: "user" })).status, 200, "with two administrators one can be demoted");
  assert.equal(server.users.adminCount(), 1);
  const demoteLast = await post(owner, "/api/users/role", { username: "owner", role: "user" });
  assert.equal(demoteLast.status, 409);
  assert.equal(demoteLast.json.reason, "last-admin");
  const removeLast = await post(owner, "/api/users/remove", { username: "owner" });
  assert.equal(removeLast.status, 409);
  assert.equal(removeLast.json.reason, "last-admin");
  assert.equal(server.users.roleOf("owner"), "admin");
  assert.ok(server.users.get("owner"));
  assert.equal((await post(owner, "/api/users/role", { username: "ghost", role: "user" })).status, 404);
  assert.equal((await post(owner, "/api/users/role", { username: "second", role: "root" })).status, 400);
  assert.equal((await post(owner, "/api/users/remove", { username: "ghost" })).status, 404);
  assert.equal((await post(owner, "/api/users/nonsense", {})).status, 404, "an unknown users route is a 404");
  // Promote, then removing one of two administrators is fine, and ends that user's sessions.
  assert.equal((await post(owner, "/api/users/role", { username: "second", role: "admin" })).status, 200);
  const secondLogin = sessionOf(await loginWith({ username: "second", password: PW.second }));
  assert.equal((await get(secondLogin, "/api/users")).json.data.users.length, 3, "an administrator sees every user");
  const removed = await post(owner, "/api/users/remove", { username: "second" });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.json.data, { username: "second", removed: true, self: false });
  assert.equal((await get(secondLogin, "/api/session")).json.authenticated, false, "a removed user's session ends");
  assert.equal((await loginWith({ username: "second", password: PW.second })).status, 401);

  // ------------------------------------------------- console.chats.projects: all
  const adminChats = (await get(owner, "/api/chats")).json.data;
  assert.equal(adminChats.projects.length, 3, "an administrator on this computer sees the workspace and both projects");
  assert.deepEqual(adminChats.projects.map((entry) => entry.sessions), [0, 1, 1]);
  assert.equal(adminChats.items.length, 2);
  assert.ok(adminChats.projects.every((entry) => entry.exists));
  const tokenChats = (await get(ticket, "/api/chats")).json.data;
  assert.equal(tokenChats.projects.length, 3, "the token session is the machine owner");
  const helperChats = (await get(helper, "/api/chats")).json.data;
  assert.equal(helperChats.projects.length, 1, "a non-administrator keeps to the workspace");
  assert.equal(helperChats.items.length, 0);
  const sessionA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert.equal((await get(owner, "/api/chats/" + sessionA)).status, 200, "an administrator opens a conversation of a discovered project");
  assert.equal((await get(helper, "/api/chats/" + sessionA)).status, 404, "a non-administrator cannot");
  assert.equal((await post(helper, "/api/chats/" + sessionA + "/messages", { prompt: "hello" })).status, 404, "nor send to it");
  const fromHelper = await post(helper, "/api/chats", { project: 1, prompt: "hello" });
  assert.equal(fromHelper.status, 400, "nor start one there by index");
  assert.match(fromHelper.json.error, /configured projects/);

  // ------------------------------------------- change password and TOTP (step-up)
  calm();
  const ownerAgain = sessionOf(await loginWith({ username: "owner", password: PW.first }));
  assert.equal((await get(ownerAgain, "/api/session")).json.authenticated, true);
  assert.equal((await post(ticket, "/api/users/password", { current: PW.first, password: PW.changed })).status, 403, "a token session has no password to change");
  assert.equal((await post(ticket, "/api/users/totp", { action: "enable", current: PW.first })).status, 403);
  const noCurrent = await post(owner, "/api/users/password", { password: PW.changed });
  assert.equal(noCurrent.status, 422, "no current password: 422, not 401, so the screen stays signed in");
  assert.equal(noCurrent.json.reason, "current");
  const wrongCurrent = await post(owner, "/api/users/password", { current: "definitely-not-it-1", password: PW.changed, confirm: PW.changed });
  assert.equal(wrongCurrent.status, 422);
  assert.equal(wrongCurrent.json.reason, "current");
  assert.equal((await post(owner, "/api/users/totp", { action: "enable", current: "definitely-not-it-1" })).status, 422);
  assert.equal((await post(owner, "/api/users/totp", { action: "enable" })).status, 422);
  assert.equal((await get(owner, "/api/session")).json.authenticated, true, "a wrong current password does not sign the user out");
  assert.equal(server.users.hasTotp("owner"), false);
  calm();
  const weakNew = await post(owner, "/api/users/password", { current: PW.first, password: "short1" });
  assert.equal(weakNew.status, 400);
  assert.equal(weakNew.json.reason, "short");
  const sameNew = await post(owner, "/api/users/password", { current: PW.first, password: PW.first });
  assert.equal(sameNew.status, 400);
  assert.equal(sameNew.json.reason, "same");
  assert.equal((await post(owner, "/api/users/password", { current: PW.first, password: PW.changed, confirm: PW.second })).json.reason, "mismatch");
  const versionOld = server.users.credentialVersion("owner");
  const changedPassword = await post(owner, "/api/users/password", { current: PW.first, password: PW.changed, confirm: PW.changed });
  assert.equal(changedPassword.status, 200, changedPassword.text);
  assert.deepEqual(changedPassword.json.data, { username: "owner", changed: true, otherSessionsEnded: 2 });
  assert.notEqual(server.users.credentialVersion("owner"), versionOld);
  assert.equal((await get(owner, "/api/session")).json.authenticated, true, "the session that changed the password stays (keepOnlySession)");
  assert.equal((await get(owner, "/api/users")).status, 200);
  assert.equal((await get(ownerAgain, "/api/session")).json.authenticated, false, "the owner's other session ended");
  assert.equal((await get(helper, "/api/session")).json.authenticated, true, "another user's session is untouched");
  assert.equal((await loginWith({ username: "owner", password: PW.first })).status, 401, "the old password no longer works");
  calm();
  assert.equal((await loginWith({ username: "owner", password: PW.changed })).status, 200, "the new one does");

  // TOTP: unchanged behaviour, now behind the current password.
  calm();
  const enrol = await post(owner, "/api/users/totp", { action: "enable", current: PW.changed });
  assert.equal(enrol.status, 200, enrol.text);
  assert.equal(enrol.json.data.totp, true);
  const secret = enrol.json.data.secret;
  assert.match(secret, /^[A-Z2-7]{32}$/, "the enrolment secret is shown once");
  assert.match(enrol.json.data.uri, /^otpauth:\/\/totp\/Aramis:owner\?secret=/);
  assert.equal((await get(owner, "/api/session")).json.authenticated, true, "the session stays after turning TOTP on");
  assert.equal(server.users.hasTotp("owner"), true);
  assert.ok(!(await get(owner, "/api/users")).text.includes(secret), "the secret is never shown again");
  assert.equal((await call(base, "/api/session")).json.login.totp, "optional", "helper has no TOTP, owner does");
  calm();
  assert.equal((await loginWith({ username: "owner", password: PW.changed })).status, 401, "TOTP on: a password alone is no longer enough");
  assert.equal((await loginWith({ username: "owner", password: PW.changed, code: "000000" })).status, 401);
  calm();
  const withCode = await loginWith({ username: "owner", password: PW.changed, code: totp(secret, { time: now }) });
  assert.equal(withCode.status, 200, withCode.text);
  const replay = await loginWith({ username: "owner", password: PW.changed, code: totp(secret, { time: now }) });
  assert.equal(replay.status, 401, "a code works once");
  tick(31000);
  const ownerTotp = sessionOf(await loginWith({ username: "owner", password: PW.changed, code: totp(secret, { time: now }) }));
  assert.equal((await get(ownerTotp, "/api/session")).json.authenticated, true);
  calm();
  assert.equal((await post(ownerTotp, "/api/users/totp", { action: "disable", current: "definitely-not-it-1" })).status, 422);
  assert.equal((await post(ownerTotp, "/api/users/totp", { action: "sideways", current: PW.changed })).status, 400);
  const disabled = await post(ownerTotp, "/api/users/totp", { action: "disable", current: PW.changed });
  assert.equal(disabled.status, 200, disabled.text);
  assert.equal(disabled.json.data.totp, false);
  assert.equal(server.users.hasTotp("owner"), false);
  assert.equal((await get(ownerTotp, "/api/session")).json.authenticated, true, "the session that turned TOTP off stays");
  assert.equal((await get(owner, "/api/session")).json.authenticated, false, "other sessions end when the second factor changes");
  calm();
  const afterTotp = sessionOf(await loginWith({ username: "owner", password: PW.changed }));
  assert.equal((await get(afterTotp, "/api/session")).json.authenticated, true);

  // ------------------------------------------------------------- lockout
  calm();
  for (let index = 0; index < 4; index += 1) {
    assert.equal((await loginWith({ username: "ghost", password: "not-the-password-" + index })).status, 401);
  }
  const locked = await loginWith({ username: "owner", password: PW.changed });
  assert.equal(locked.status, 429, "four failures lock the address, even for the right password");
  assert.ok(Number(locked.headers["retry-after"]) > 0);
  assert.ok(locked.json.retryAfterSeconds > 0);
  assert.ok(server.runtime.audit.list({ action: "console-login-locked", limit: 20 }).length >= 1, "the lockout is audited");
  assert.equal((await loginWith({ token })).status, 429, "the token is behind the same lock");
  calm();
  assert.equal((await loginWith({ username: "owner", password: PW.changed })).status, 200, "the lock lifts after its time");
  // The lock also follows the username across addresses.
  calm();
  for (let index = 0; index < 4; index += 1) {
    await call(base, "/api/login", { method: "POST", body: { username: "helper", password: "not-the-password-" + index }, origin: base });
  }
  assert.ok(server.guard.check(["user:helper"]).retryAfterMs > 0, "four wrong passwords lock that username");
  calm();

  // ----------------------------------------------- console.auth, applied live and saved
  const adminSession = sessionOf(await loginWith({ username: "owner", password: PW.changed }));
  const modeView = (await get(adminSession, "/api/users")).json.data;
  assert.equal(modeView.canRequirePassword, true, "an administrator exists, so token sign-in may be turned off");
  assert.equal((await post(helper, "/api/users/auth-mode", { mode: "password" })).status, 403);
  assert.equal((await post(adminSession, "/api/users/auth-mode", { mode: "token" })).status, 400, "token-only is not set from the screen");
  assert.equal((await post(adminSession, "/api/users/auth-mode", { mode: "open" })).status, 400);
  assert.equal((await post(adminSession, "/api/users/auth-mode", {})).status, 400);
  assert.equal(readFileSync(configOne, "utf8"), crlfSample, "refused changes write nothing");
  const toPassword = await post(adminSession, "/api/users/auth-mode", { mode: "password" });
  assert.equal(toPassword.status, 200, toPassword.text);
  assert.equal(toPassword.json.data.authMode, "password", "applied live");
  assert.equal(toPassword.json.data.persisted, true);
  assert.equal(toPassword.json.data.reason, null);
  assert.equal(server.authMode(), "password");
  assert.equal(readFileSync(configOne, "utf8"), inserted.text, "saved in astack.config.yaml: only the one line added, CRLF and comments kept");
  const backups = readdirSync(join(workspaceOne, ".astack", "backups"));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(workspaceOne, ".astack", "backups", backups[0], "astack.config.yaml"), "utf8"), crlfSample, "the old file is backed up first");
  const passwordOnly = (await call(base, "/api/session")).json.login;
  assert.deepEqual(passwordOnly.methods, ["password"]);
  const tokenOff = await loginWith({ token });
  assert.equal(tokenOff.status, 403, "token sign-in is off");
  assert.match(tokenOff.json.error, /turned off/);
  // A one-time ticket is issued from this computer by `console open`; console.auth does not govern it.
  assert.equal((await loginWith({ ticket: server.auth.issueTicket() })).status, 200, "the one-time link from this computer still works");
  assert.equal((await loginWith({ username: "owner", password: PW.changed })).status, 200, "the username and password still work");
  assert.equal((await post(adminSession, "/api/users/auth-mode", { mode: "both" })).json.data.authMode, "both");
  assert.equal((await post(adminSession, "/api/users/auth-mode", { mode: "both" })).json.data.persisted, true, "the same mode again is fine");
  assert.ok(readFileSync(configOne, "utf8").includes("  auth: both\r\n"));
  assert.equal(readdirSync(join(workspaceOne, ".astack", "backups")).length, 2, "one backup per real change");
  assert.deepEqual((await call(base, "/api/session")).json.login.methods, ["password", "token"]);
  assert.equal((await loginWith({ token })).status, 200, "token sign-in is back");

  // Unusual config: applied for this run, never written, the manual line comes back.
  const oddWorkspace = workspace();
  const oddRuntime = createRuntime({ workspaceRoot: oddWorkspace });
  const oddConfig = join(oddWorkspace, "astack.config.yaml");
  writeFileSync(oddConfig, oddText);
  fakeConfiguration(oddRuntime, oddConfig);
  const oddUsers = new ConsoleUsers(join(oddWorkspace, ".astack", "console"), { clock, vault: null });
  await oddUsers.set("boss", PW.remote, { role: "admin" });
  const oddServer = await start({ runtime: oddRuntime, clock });
  const oddBase = oddServer.origin;
  const oddToken = readFileSync(join(oddWorkspace, ".astack", "console", "token"), "utf8").trim();
  const oddLogin = await call(oddBase, "/api/login", { method: "POST", body: { token: oddToken }, origin: oddBase });
  const oddSession = { cookie: cookieOf(oddLogin), csrf: oddLogin.json.csrf };
  const oddResult = await call(oddBase, "/api/users/auth-mode", { method: "POST", body: { mode: "password" }, cookie: oddSession.cookie, csrf: oddSession.csrf, origin: oddBase });
  assert.equal(oddResult.status, 200, oddResult.text);
  assert.equal(oddResult.json.data.persisted, false);
  assert.equal(oddResult.json.data.line, "console:\n  auth: password", "the exact line to add by hand");
  assert.match(oddResult.json.data.reason, /unusual shape/);
  assert.equal(oddResult.json.data.authMode, "password", "still applied for this run");
  assert.equal(readFileSync(oddConfig, "utf8"), oddText, "the config is untouched");
  assert.ok(!existsSync(join(oddWorkspace, ".astack", "backups")), "and no backup was made");
  await oddServer.stop();

  // No config file at all: same story.
  const bareWorkspace = workspace();
  const bareRuntime = createRuntime({ workspaceRoot: bareWorkspace });
  fakeConfiguration(bareRuntime, join(bareWorkspace, "astack.config.yaml"));
  assert.equal(existsSync(join(bareWorkspace, "astack.config.yaml")), false);
  const bareUsers = new ConsoleUsers(join(bareWorkspace, ".astack", "console"), { clock, vault: null });
  await bareUsers.set("boss", PW.remote);
  const bareServer = await start({ runtime: bareRuntime, clock });
  const bareToken = readFileSync(join(bareWorkspace, ".astack", "console", "token"), "utf8").trim();
  const bareLogin = await call(bareServer.origin, "/api/login", { method: "POST", body: { token: bareToken }, origin: bareServer.origin });
  const bareResult = await call(bareServer.origin, "/api/users/auth-mode", { method: "POST", body: { mode: "both" }, cookie: cookieOf(bareLogin), csrf: bareLogin.json.csrf, origin: bareServer.origin });
  assert.equal(bareResult.json.data.persisted, false);
  assert.match(bareResult.json.data.reason, /no astack\.config\.yaml/);
  assert.equal(existsSync(join(bareWorkspace, "astack.config.yaml")), false, "no config file is invented");
  await bareServer.stop();

  // `console.auth: password` in the config with no administrator falls back to the token.
  const lonely = new ConsoleServer({ runtime: runtimeOne, clock, authMode: "password", totpVault: null, port: 0, log: () => {} });
  const lonelyDirectory = sandbox("astack-auth-lonely-");
  lonely.users = new ConsoleUsers(lonelyDirectory, { clock, vault: null });
  assert.equal(lonely.authMode(), "token", "password-only with nobody to sign in falls back to the token, so the owner is never locked out");
  await lonely.users.set("someone", PW.second);
  assert.equal(lonely.authMode(), "password");

  // =========================================================== remote listener
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const certs = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((done) => certs.listen(0, "127.0.0.1", done));
  closers.push(() => new Promise((done) => certs.close(done)));
  const certsUrl = "http://127.0.0.1:" + certs.address().port + "/cdn-cgi/access/certs";
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = (claims) => {
    const head = b64({ alg: "RS256", kid: "k1", typ: "JWT" }) + "." + b64(claims);
    return head + "." + signData("RSA-SHA256", Buffer.from(head), privateKey).toString("base64url");
  };
  const seconds = () => Math.floor(now / 1000);
  const claims = () => ({ aud: ["AUD123"], iss: "https://testteam.cloudflareaccess.com", exp: seconds() + 600, iat: seconds() });

  const workspaceTwo = workspace();
  const runtimeTwo = createRuntime({ workspaceRoot: workspaceTwo });
  const configTwo = join(workspaceTwo, "astack.config.yaml");
  writeFileSync(configTwo, crlfSample);
  fakeConfiguration(runtimeTwo, configTwo);
  const remoteUsers = new ConsoleUsers(join(workspaceTwo, ".astack", "console"), { clock, vault: null });
  await remoteUsers.set("boss", PW.remote, { role: "admin" });
  await remoteUsers.set("plain", PW.plain, { role: "user" });
  const remoteServer = await start({
    runtime: runtimeTwo,
    clock,
    accessCertsUrl: certsUrl,
    claudeHome,
    chats: { projects: "all" },
    remote: resolveRemoteSettings({ enabled: true, hostname: "console.example.test", port: 0, chat: true, totp: false, access: { team: "testteam", aud: "AUD123" } })
  });
  const remoteInfo = remoteServer.describe().remote;
  assert.equal(remoteInfo.running, true, remoteInfo.error ?? "remote listener running");
  const HOST = "console.example.test";
  const ORIGIN = "https://" + HOST;
  const rcall = (path, options = {}) => call(remoteInfo.url, path, { host: HOST, ...options, headers: { "cf-access-jwt-assertion": jwt(claims()), ...(options.headers ?? {}) } });
  const rlogin = (body) => rcall("/api/login", { method: "POST", body, origin: ORIGIN });
  assert.deepEqual((await rcall("/api/session")).json.login, { methods: ["password"], totp: "off", remote: true });
  assert.equal((await rcall("/api/users")).status, 401, "signed out: 401 first");
  assert.equal((await rcall("/api/users", { method: "POST", body: { username: "x1", password: PW.fresh }, origin: ORIGIN })).status, 401);

  const bossLogin = await rlogin({ username: "boss", password: PW.remote });
  assert.equal(bossLogin.status, 200, bossLogin.text);
  const boss = { cookie: cookieOf(bossLogin), csrf: bossLogin.json.csrf };
  assert.equal((await rcall("/api/session", { cookie: boss.cookie })).json.role, "admin");
  const plainLogin = await rlogin({ username: "plain", password: PW.plain });
  assert.equal(plainLogin.status, 200, plainLogin.text);
  const plainSession = { cookie: cookieOf(plainLogin), csrf: plainLogin.json.csrf };

  const usersBefore = JSON.stringify(remoteUsers.read());
  const configBefore = readFileSync(configTwo, "utf8");
  const remoteWrite = (who, path, body) => rcall(path, { method: "POST", body, cookie: who.cookie, csrf: who.csrf, origin: ORIGIN });
  for (const who of [boss, plainSession]) {
    const reading = await rcall("/api/users", { cookie: who.cookie });
    assert.equal(reading.status, 403, "GET /api/users is not served over the internet listener");
    assert.equal(reading.json.ok, false);
    assert.ok(!/boss|plain|scrypt|role/i.test(reading.text), "and says nothing about users");
    for (const [path, body] of [
      ["/api/users", { username: "x1", password: PW.fresh, role: "admin" }],
      ["/api/users/create", { username: "x2", password: PW.fresh }],
      ["/api/users/password", { current: who === boss ? PW.remote : PW.plain, password: PW.fresh, confirm: PW.fresh }],
      ["/api/users/totp", { action: "enable", current: who === boss ? PW.remote : PW.plain }],
      ["/api/users/remove", { username: "plain" }],
      ["/api/users/role", { username: "plain", role: "admin" }],
      ["/api/users/auth-mode", { mode: "password" }]
    ]) {
      const attempt = await remoteWrite(who, path, body);
      assert.equal(attempt.status, 403, "POST " + path + " is refused over the internet listener");
      assert.equal(attempt.json.ok, false);
    }
  }
  assert.equal(JSON.stringify(remoteUsers.read()), usersBefore, "no user, password, role or TOTP changed");
  assert.equal(readFileSync(configTwo, "utf8"), configBefore, "console.auth was not touched");
  assert.equal(remoteServer.users.count(), 2);
  assert.equal((await remoteWrite(boss, "/api/users/nonsense", {})).status, 403, "even an unknown users route answers 403 remotely");

  // console.chats.projects: all never widens the internet listener, even for an administrator.
  const remoteChats = await rcall("/api/chats", { cookie: boss.cookie });
  assert.equal(remoteChats.status, 200, remoteChats.text);
  assert.equal(remoteChats.json.data.projects.length, 1, "the internet listener sees the workspace only");
  assert.equal(remoteChats.json.data.items.length, 0);
  assert.equal((await rcall("/api/chats/" + sessionA, { cookie: boss.cookie })).status, 404, "and cannot open a discovered project's conversation");
  const localLogin = await call(remoteServer.origin, "/api/login", { method: "POST", body: { username: "boss", password: PW.remote }, origin: remoteServer.origin });
  assert.equal(localLogin.status, 200);
  const localChats = await call(remoteServer.origin, "/api/chats", { cookie: cookieOf(localLogin) });
  assert.equal(localChats.json.data.projects.length, 3, "the same administrator on the local listener sees all projects");
  const localPlain = await call(remoteServer.origin, "/api/login", { method: "POST", body: { username: "plain", password: PW.plain }, origin: remoteServer.origin });
  assert.equal((await call(remoteServer.origin, "/api/chats", { cookie: cookieOf(localPlain) })).json.data.projects.length, 1, "and a plain user on the local listener sees the workspace only");
  await remoteServer.stop();

  // ====================================================== nothing secret leaks
  const everySecret = [...Object.values(PW), token, oddToken, bareToken, secret];
  const exempt = new Set([enrol.text]);
  for (const entry of seen) {
    if (exempt.has(entry.text)) {
      continue;
    }
    for (const value of everySecret) {
      assert.ok(!entry.text.includes(value), "no secret in the response of " + entry.path);
    }
    assert.ok(!/scrypt\$|"hash"|credentialVersion|"password":/i.test(entry.text), "no hash, credential version or password field in " + entry.path);
  }
  const stateText = [
    join(workspaceOne, ".astack", "console", "sessions.json"),
    join(workspaceOne, ".astack", "console", "lockouts.json")
  ].filter((path) => existsSync(path)).map((path) => readFileSync(path, "utf8")).join("\n");
  for (const value of everySecret) {
    assert.ok(!stateText.includes(value), "no secret in the session or lockout files");
    assert.ok(!logs.some((entry) => String(entry).includes(value)), "no secret in the console log");
  }
  for (const runtime of [runtimeOne, runtimeTwo]) {
    const auditText = JSON.stringify(runtime.audit.list({ limit: 100000 }));
    for (const value of everySecret) {
      assert.ok(!auditText.includes(value), "no secret in the audit trail");
    }
    assert.ok(!/scrypt\$/.test(auditText));
  }
  const actions = new Set(runtimeOne.audit.list({ limit: 100000 }).map((entry) => entry.action));
  for (const action of ["console-user-created", "console-user-removed", "console-user-role", "console-user-secret-changed", "console-user-totp", "console-auth-mode", "console-login", "console-login-failed", "console-user-reauth-failed"]) {
    assert.ok(actions.has(action), "audited: " + action);
  }
  assert.equal(runtimeOne.audit.list({ action: "console-user-created", limit: 20 })[0].result.includes("first administrator") || runtimeOne.audit.list({ action: "console-user-created", limit: 20 }).some((entry) => /first administrator/.test(entry.result)), true, "the first administrator is audited as such");

  console.log("AStack console admin sign-in verification passed");
} finally {
  for (const server of servers) {
    await server.stop().catch(() => {});
  }
  for (const close of closers) {
    await close().catch(() => {});
  }
  for (const directory of sandboxes) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}
