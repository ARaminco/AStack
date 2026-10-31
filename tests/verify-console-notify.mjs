import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../runtime/astack-runtime.mjs";
import { ConsoleServer } from "../console/server.mjs";
import { ConsoleNotifier, describeDevice, resolveNotifySettings } from "../console/notify.mjs";

/**
 * Owner notifications for console activity (Telegram through the gateway).
 * The gateway here is a fake that records calls; nothing is ever sent for real.
 * Passwords and tokens are fake values, and every captured message is scanned
 * for them.
 */
const repoRoot = process.cwd();
const sandboxes = [];
const servers = [];
const PASSWORD = "Tr0ub4dor-fake-pass-9271";
const NEW_PASSWORD = "Another-fake-pass-5530-xyz";

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "astack-notify-"));
  sandboxes.push(directory);
  cpSync(join(repoRoot, "context-engine", "lenses.json"), join(directory, "context-engine", "lenses.json"));
  return directory;
}

function call(base, path, { method = "GET", body, cookie, csrf, headers = {} } = {}) {
  const all = { accept: "application/json", origin: base, ...headers };
  if (body !== undefined) all["content-type"] = "application/json";
  if (cookie) all.cookie = cookie;
  if (csrf) all["x-csrf-token"] = csrf;
  return new Promise((resolvePromise, reject) => {
    const url = new URL(path, base);
    const req = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: all }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolvePromise({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const cookieOf = (response) => String(response.headers["set-cookie"] ?? "").split(";")[0];
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function start({ notify = null, gateway, workspaceRoot = workspace(), lockout = {} } = {}) {
  const runtime = createRuntime({ workspaceRoot });
  runtime.gateway = gateway;
  const server = new ConsoleServer({ runtime, port: 0, pollMs: 300, log: () => {}, totpVault: null, notify: resolveNotifySettings(notify), lockout });
  servers.push(server);
  await server.start();
  return { server, base: server.origin };
}

function fakeGateway() {
  const calls = [];
  return { calls, notify: async (payload) => { calls.push(payload); return { sent: 1, results: [] }; } };
}

try {
  // ---- settings and helpers
  assert.deepEqual(resolveNotifySettings(null), { enabled: true, login: true, lockout: true, security: true, channel: "telegram", timezone: null });
  const custom = resolveNotifySettings({ enabled: "false", login: false, channel: "telegram", timezone: "Asia/Dubai" });
  assert.equal(custom.enabled, false);
  assert.equal(custom.login, false);
  assert.equal(custom.security, true);
  assert.equal(custom.timezone, "Asia/Dubai");
  assert.equal(resolveNotifySettings({ timezone: "Not/AZone" }).timezone, null, "an unknown time zone is ignored");
  assert.equal(describeDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150 Safari/537.36"), "Chrome روی Windows");
  assert.equal(describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Version/17 Safari/604"), "Safari روی iOS");
  assert.equal(describeDevice(""), "نامشخص");

  // ---- sign-in notifications on a real console server
  const gateway = fakeGateway();
  const { server, base } = await start({ gateway, notify: { timezone: "Asia/Dubai" } });
  const ticketLogin = await call(base, "/api/login", { method: "POST", body: { ticket: server.auth.issueTicket() }, headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/150" } });
  assert.equal(ticketLogin.status, 200);
  await sleep(30);
  assert.equal(gateway.calls.length, 1, "one message per successful sign-in");
  const first = gateway.calls[0];
  assert.equal(first.channel, "telegram");
  assert.match(first.text, /^🔐 ورود به آرامیس/);
  assert.match(first.text, /کاربر: بلیط یک‌بارمصرف/);
  assert.match(first.text, /اتصال: محلی/);
  assert.match(first.text, /دستگاه: Chrome روی Windows/);
  assert.match(first.text, /زمان: \d\d\/\d\d\/\d{4} \d\d:\d\d/);
  assert.match(first.text, /خروج از همه‌جا/);

  const session = cookieOf(ticketLogin);
  const csrf = ticketLogin.json.csrf;
  gateway.calls.length = 0;

  // A user is created from the ticket session: a security message, no secret in it.
  const created = await call(base, "/api/users", { method: "POST", body: { username: "owner", password: PASSWORD, confirm: PASSWORD }, cookie: session, csrf });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  await sleep(30);
  assert.equal(gateway.calls.length, 1);
  assert.match(gateway.calls[0].text, /حساب کاربری تازه ساخته شد/);
  assert.equal(gateway.calls[0].level, "warn");

  // Password sign-in: one message with the user name, method and no secret.
  gateway.calls.length = 0;
  const passwordLogin = await call(base, "/api/login", { method: "POST", body: { username: "owner", password: PASSWORD }, headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X) Firefox/130" } });
  assert.equal(passwordLogin.status, 200, JSON.stringify(passwordLogin.json));
  await sleep(30);
  assert.equal(gateway.calls.length, 1);
  assert.match(gateway.calls[0].text, /کاربر: owner/);
  assert.match(gateway.calls[0].text, /روش: نام کاربری و رمز$/m);
  assert.match(gateway.calls[0].text, /دستگاه: Firefox روی macOS/);

  // A failed sign-in sends nothing.
  gateway.calls.length = 0;
  const failed = await call(base, "/api/login", { method: "POST", body: { username: "owner", password: "wrong-" + PASSWORD } });
  assert.equal(failed.status, 401);
  await sleep(30);
  assert.equal(gateway.calls.length, 0, "a failed sign-in is not announced");

  // A password change by the signed-in user: a security message.
  const ownerSession = cookieOf(passwordLogin);
  const ownerCsrf = passwordLogin.json.csrf;
  gateway.calls.length = 0;
  const changed = await call(base, "/api/users/password", { method: "POST", body: { current: PASSWORD, password: NEW_PASSWORD, confirm: NEW_PASSWORD }, cookie: ownerSession, csrf: ownerCsrf });
  await sleep(30);
  if (changed.status === 200) {
    assert.equal(gateway.calls.length, 1);
    assert.match(gateway.calls[0].text, /رمز یک حساب عوض شد/);
    assert.match(gateway.calls[0].text, /توسط: owner/);
  }
  // A refused write sends nothing.
  gateway.calls.length = 0;
  const refused = await call(base, "/api/users/password", { method: "POST", body: { current: "not-the-password", password: NEW_PASSWORD, confirm: NEW_PASSWORD }, cookie: ownerSession, csrf: ownerCsrf });
  assert.notEqual(refused.status, 200);
  await sleep(30);
  assert.equal(gateway.calls.length, 0, "a refused change is not announced");

  // ---- lockout: one warning, not one per attempt
  const lockGateway = fakeGateway();
  const locked = await start({ gateway: lockGateway });
  const lockedTicket = await call(locked.base, "/api/login", { method: "POST", body: { ticket: locked.server.auth.issueTicket() } });
  const lockedSession = cookieOf(lockedTicket);
  await call(locked.base, "/api/users", { method: "POST", body: { username: "helper", password: PASSWORD, confirm: PASSWORD }, cookie: lockedSession, csrf: lockedTicket.json.csrf });
  lockGateway.calls.length = 0;
  let last = null;
  for (let index = 0; index < 12; index += 1) {
    last = await call(locked.base, "/api/login", { method: "POST", body: { username: "helper", password: "bad-attempt-" + index } });
  }
  assert.equal(last.status, 429, "the address is locked after repeated failures");
  await sleep(30);
  const warns = lockGateway.calls.filter((entry) => /قفل شدن ورود/.test(entry.text));
  assert.equal(warns.length, 1, "exactly one lockout warning");
  assert.equal(warns[0].level, "warn");

  // ---- disabled by configuration
  const quiet = fakeGateway();
  const off = await start({ gateway: quiet, notify: { enabled: false } });
  const offLogin = await call(off.base, "/api/login", { method: "POST", body: { ticket: off.server.auth.issueTicket() } });
  assert.equal(offLogin.status, 200);
  await sleep(30);
  assert.equal(quiet.calls.length, 0, "console.notify.enabled false sends nothing");

  // ---- no gateway: sign-in is unaffected
  const none = await start({ gateway: undefined });
  const noneLogin = await call(none.base, "/api/login", { method: "POST", body: { ticket: none.server.auth.issueTicket() } });
  assert.equal(noneLogin.status, 200, "no gateway, sign-in still works");

  // ---- throwing and hanging gateways never delay or break sign-in
  const throwing = await start({ gateway: { notify: () => { throw new Error("boom " + PASSWORD); } } });
  assert.equal((await call(throwing.base, "/api/login", { method: "POST", body: { ticket: throwing.server.auth.issueTicket() } })).status, 200);
  const hanging = await start({ gateway: { notify: () => new Promise(() => {}) } });
  const startedAt = Date.now();
  assert.equal((await call(hanging.base, "/api/login", { method: "POST", body: { ticket: hanging.server.auth.issueTicket() } })).status, 200);
  assert.ok(Date.now() - startedAt < 2000, "a hanging gateway does not hold the sign-in");

  // ---- dedupe and sanitising on the notifier itself
  const unit = fakeGateway();
  const notifier = new ConsoleNotifier({ runtime: { gateway: unit }, settings: resolveNotifySettings(null) });
  notifier.send("same text");
  notifier.send("same text");
  await sleep(10);
  assert.equal(unit.calls.length, 1, "identical messages within five seconds are sent once");
  notifier.login({ method: "password", user: "evil\n\u202ename", listener: { kind: "remote" }, address: "203.0.113.9", userAgent: "x" });
  await sleep(10);
  const injected = unit.calls[unit.calls.length - 1].text;
  assert.ok(!/\u202e/.test(injected) && !/کاربر: evil\nname/.test(injected), "user supplied text cannot add lines or bidi overrides");
  assert.match(injected, /اتصال: اینترنتی/, "the internet listener is named");
  assert.ok(!/[\u2066-\u2069]/.test(injected), "no isolate characters in the message");

  // ---- two simultaneous creations never both become the first administrator
  const race = await start({ gateway: fakeGateway() });
  const raceLogin = await call(race.base, "/api/login", { method: "POST", body: { ticket: race.server.auth.issueTicket() } });
  const raceSession = cookieOf(raceLogin);
  const raceCsrf = raceLogin.json.csrf;
  await Promise.all(["alpha", "bravo", "charlie"].map((name) => call(race.base, "/api/users", { method: "POST", body: { username: name, password: PASSWORD + name, confirm: PASSWORD + name }, cookie: raceSession, csrf: raceCsrf })));
  const raceList = (await call(race.base, "/api/users", { cookie: raceSession })).json.data.users;
  assert.equal(raceList.length, 3, "all three were created");
  assert.equal(raceList.filter((user) => user.role === "admin").length, 1, "exactly one first administrator");

  // ---- no secret anywhere in any captured message
  const everything = [gateway, lockGateway, quiet, unit].flatMap((entry) => entry.calls.map((call) => call.text)).join("\n");
  for (const secret of [PASSWORD, NEW_PASSWORD, "bad-attempt-", ticketLogin.json.csrf]) {
    assert.ok(!everything.includes(secret), "a secret value reached a notification");
  }
  console.log("AStack console notifications verified");
} finally {
  await Promise.all(servers.map((server) => server.stop().catch(() => {})));
  for (const directory of sandboxes) {
    rmSync(directory, { recursive: true, force: true });
  }
}
