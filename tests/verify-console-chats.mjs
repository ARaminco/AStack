import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signData } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { createRuntime } from "../runtime/astack-runtime.mjs";
import { ConsoleServer, HEARTBEAT_MS, hasProxyHeaders, resolveConsoleSettings, resolveRemoteSettings } from "../console/server.mjs";
import { ConsoleUsers, LoginGuard, SCRYPT_PARAMS, base32Decode, base32Encode, hashPassword, hotp, needsRehash, totp, verifyPassword, verifyTotp } from "../console/users.mjs";
import { AccessVerifier } from "../console/access.mjs";
import { CHAT_STATE_DENIES, ChatManager, PERMISSION_TOOL, parseTranscript, remoteChatDenies, summarizeTranscript, transcriptDirectories, windowItems } from "../console/chats.mjs";
import { redactSecretsStrict } from "../lib/text.mjs";
import { createMcpHandler, mcpTools, requestToolPermission } from "../interop-engine/mcp-server.mjs";
import { ApprovalEngine } from "../trust-engine/approvals.mjs";
import { MANDATORY_CLAUDE_DENIED } from "../runner-engine/engines.mjs";
import { claudeSlug } from "../search-engine/sources/sessions.mjs";
import { runConsoleCommand } from "../console/cli.mjs";
import { createLocalization } from "../localization-engine/service.mjs";

const repoRoot = process.cwd();
const sandboxes = [];
const servers = [];
const closers = [];
function sandbox(prefix = "astack-chats-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  sandboxes.push(directory);
  return directory;
}
function workspace() {
  const directory = sandbox();
  cpSync(join(repoRoot, "context-engine", "lenses.json"), join(directory, "context-engine", "lenses.json"));
  return directory;
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitFor(check, { timeoutMs = 15000, every = 50, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) {
      return value;
    }
    await sleep(every);
  }
  throw new Error("timed out waiting for " + what);
}

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
        resolvePromise({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function openStream(base, cookie, { host, headers = {} } = {}) {
  const events = [];
  return new Promise((resolvePromise, reject) => {
    const url = new URL("/api/events", base);
    const req = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname, headers: { cookie, accept: "text/event-stream", ...(host ? { host } : {}), ...headers } }, (res) => {
      res.setEncoding("utf8");
      let buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk;
        let index = buffer.indexOf("\n\n");
        while (index !== -1) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const type = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (type && data) {
            try {
              events.push({ type, data: JSON.parse(data) });
            } catch {
              // ignore
            }
          }
          index = buffer.indexOf("\n\n");
        }
      });
      resolvePromise({ req, events, status: res.statusCode });
    });
    req.on("error", reject);
    req.end();
  });
}

async function start(options) {
  const server = new ConsoleServer({ port: 0, pollMs: 300, log: () => {}, ...options });
  servers.push(server);
  await server.start();
  return server;
}

const cookieOf = (response) => String(response.headers["set-cookie"] ?? "").split(";")[0];

try {
  // =================================================================== users
  const stored = await hashPassword("correct horse battery");
  const [scheme, N, r, p] = stored.split("$");
  assert.equal(scheme, "scrypt");
  assert.ok(Number(N) >= 2 ** 17, "3.1.1: scrypt cost N >= 2^17 for new hashes");
  assert.equal(SCRYPT_PARAMS.N, 2 ** 17);
  assert.equal(Number(r), 8);
  assert.equal(Number(p), 1);
  assert.notEqual(stored, await hashPassword("correct horse battery"), "every hash has its own salt");
  assert.equal(await verifyPassword("correct horse battery", stored), true);
  assert.equal(await verifyPassword("correct horse batterY", stored), false);
  assert.equal(await verifyPassword("x", "garbage"), false);
  // An older 2^15 hash still verifies and is rehashed on the next successful sign-in.
  const oldHash = await hashPassword("correct horse battery", { N: 2 ** 15 });
  assert.equal(needsRehash(oldHash), true);
  assert.equal(needsRehash(stored), false);
  assert.equal(await verifyPassword("correct horse battery", oldHash), true, "old hashes still verify");
  const rehashDir = join(sandbox("astack-rehash-"), ".astack", "console");
  mkdirSync(rehashDir, { recursive: true });
  writeFileSync(join(rehashDir, "users.json"), JSON.stringify({ version: 1, users: { old: { hash: oldHash, createdAt: "2026-01-01T00:00:00.000Z" } } }));
  const rehashUsers = new ConsoleUsers(rehashDir, { vault: null });
  assert.equal(await rehashUsers.checkPassword("old", "wrong password!"), null);
  assert.equal(rehashUsers.get("old").hash, oldHash, "a failed sign-in never rewrites the hash");
  assert.equal(await rehashUsers.checkPassword("old", "correct horse battery"), "old");
  assert.equal(rehashUsers.get("old").hash.split("$")[1], String(2 ** 17), "rehashed to N=2^17 after a good sign-in");
  assert.equal(await rehashUsers.checkPassword("old", "correct horse battery"), "old", "the new hash verifies");

  // ===================================== labelled base32 (TOTP) redaction
  assert.equal(redactSecretsStrict("TOTP secret: JBSW Y3DP EHPK 3PXP ABCD").includes("Y3DP"), false, "a grouped secret after a label is redacted");
  assert.match(redactSecretsStrict("2fa seed JBSWY3DPEHPK3PXP"), /\[redacted/);
  assert.match(redactSecretsStrict("Key: GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ"), /\[redacted/, "the CLI's enrolment line is redacted");
  assert.ok(!redactSecretsStrict("otpauth://totp/Aramin:a?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Aramin").includes("GEZDGNBV"));
  assert.equal(redactSecretsStrict("JBSWY3DPEHPK3PXP alone"), "JBSWY3DPEHPK3PXP alone", "an unlabelled base32 run is left alone");
  assert.equal(redactSecretsStrict("the AUTHENTICATIONSERVICE is up"), "the AUTHENTICATIONSERVICE is up", "upper-case words are not secrets");
  assert.equal(redactSecretsStrict("SELECT ABCDEFGHIJKLMNOPQRSTUV2 FROM t"), "SELECT ABCDEFGHIJKLMNOPQRSTUV2 FROM t");
  assert.equal(redactSecretsStrict("the totp step is 30 seconds"), "the totp step is 30 seconds");

  // RFC 6238 appendix B (SHA-1, 8 digits) — the last 6 digits are the 6-digit code.
  const rfcSecret = Buffer.from("12345678901234567890");
  assert.equal(hotp(rfcSecret, Math.floor(59 / 30), 8), "94287082");
  assert.equal(hotp(rfcSecret, Math.floor(1111111109 / 30), 8), "07081804");
  assert.equal(hotp(rfcSecret, Math.floor(20000000000 / 30), 8), "65353130");
  assert.equal(base32Decode(base32Encode(rfcSecret)).toString(), "12345678901234567890");
  assert.equal(base32Encode(rfcSecret), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  const secret32 = base32Encode(rfcSecret);
  assert.equal(totp(secret32, { time: 59000 }), "287082");
  assert.equal(verifyTotp(secret32, "287082", { time: 59000 }), 1);
  assert.equal(verifyTotp(secret32, "287082", { time: 59000 + 30000 }), 1, "one step of drift is accepted");
  assert.equal(verifyTotp(secret32, "287082", { time: 59000 + 90000 }), null, "an old code is refused");
  assert.equal(verifyTotp(secret32, "287082", { time: 59000, lastCounter: 1 }), null, "a used step cannot be replayed");
  assert.equal(verifyTotp(secret32, "12345", { time: 59000 }), null);

  let guardNow = Date.parse("2026-10-14T10:00:00Z");
  const guard = new LoginGuard({ attempts: 5, windowMs: 15 * 60000, lockMs: 15 * 60000, clock: () => new Date(guardNow) });
  for (let i = 0; i < 4; i += 1) guard.fail(["ip:a", "user:x"]);
  assert.equal(guard.check(["ip:a"]).allowed, true);
  guard.fail(["ip:a", "user:x"]);
  assert.equal(guard.check(["ip:a"]).allowed, false, "5 failures lock the address");
  assert.equal(guard.check(["ip:b", "user:x"]).allowed, false, "and the username, from any address");
  assert.equal(guard.check(["ip:b", "user:y"]).allowed, true);
  guardNow += 15 * 60000 + 1;
  assert.equal(guard.check(["ip:a", "user:x"]).allowed, true, "the lock ends after 15 minutes");

  // 3.1.1: lockouts survive a restart; keys are stored hashed with an expiry.
  const lockPath = join(sandbox("astack-lockouts-"), "lockouts.json");
  const persisted = new LoginGuard({ attempts: 5, windowMs: 15 * 60000, lockMs: 15 * 60000, clock: () => new Date(guardNow), path: lockPath });
  for (let i = 0; i < 5; i += 1) persisted.fail(["ip:203.0.113.1", "user:victim"]);
  persisted.fail(["ip:198.51.100.2"]);
  const lockFile = readFileSync(lockPath, "utf8");
  assert.ok(!lockFile.includes("203.0.113.1") && !lockFile.includes("victim"), "only hashed keys reach the disk");
  assert.ok(Object.values(JSON.parse(lockFile).entries).every((entry) => entry.expiresAt > guardNow), "every entry carries an expiry");
  const restarted = new LoginGuard({ attempts: 5, windowMs: 15 * 60000, lockMs: 15 * 60000, clock: () => new Date(guardNow), path: lockPath });
  assert.equal(restarted.check(["ip:203.0.113.1"]).allowed, false, "a restart does not reset a lock");
  assert.equal(restarted.check(["user:victim"]).allowed, false);
  for (let i = 0; i < 4; i += 1) restarted.fail(["ip:198.51.100.2"]);
  assert.equal(restarted.check(["ip:198.51.100.2"]).allowed, false, "failure counts survive too (1 before + 4 after)");
  restarted.succeed(["ip:198.51.100.2"]);
  const expired = new LoginGuard({ attempts: 5, windowMs: 15 * 60000, lockMs: 15 * 60000, clock: () => new Date(guardNow + 16 * 60000), path: lockPath });
  assert.equal(expired.check(["ip:203.0.113.1"]).allowed, true, "expired entries are dropped on load");
  writeFileSync(lockPath, "{not json");
  assert.equal(new LoginGuard({ path: lockPath }).check(["ip:x"]).allowed, true, "a damaged file starts empty");

  // ====================================== TOTP secret storage (vault)
  const memory = new Map();
  const memVault = { source: "vault:windows", write: (name, value) => memory.set(name, value), read: (name) => memory.get(name) ?? null, remove: (name) => memory.delete(name) };
  const vaultDir = join(sandbox("astack-totp-vault-"), ".astack", "console");
  let vaultNow = Date.parse("2026-10-14T10:00:00Z");
  const vaultClock = () => new Date(vaultNow);
  const fileUsers = new ConsoleUsers(vaultDir, { clock: vaultClock, vault: null });
  await fileUsers.set("vic", "a-long-enough-password");
  const plainEnrol = fileUsers.enableTotp("vic");
  assert.equal(plainEnrol.store, "file", "without a vault the secret stays in users.json (non-Windows)");
  assert.ok(readFileSync(join(vaultDir, "users.json"), "utf8").includes(plainEnrol.secret));
  const vaultUsers = new ConsoleUsers(vaultDir, { clock: vaultClock, vault: memVault });
  vaultNow += 30000;
  assert.equal(vaultUsers.useTotp("vic", totp(plainEnrol.secret, { time: vaultNow })), true);
  assert.ok(!readFileSync(join(vaultDir, "users.json"), "utf8").includes(plainEnrol.secret), "a plaintext secret moves into the vault at the next sign-in");
  assert.equal(vaultUsers.get("vic").totp.store, "vault:windows");
  assert.equal(memory.get("vic"), plainEnrol.secret);
  vaultNow += 30000;
  assert.equal(new ConsoleUsers(vaultDir, { clock: vaultClock, vault: memVault }).useTotp("vic", totp(plainEnrol.secret, { time: vaultNow })), true, "codes verify from the vault");
  assert.equal(new ConsoleUsers(vaultDir, { clock: vaultClock, vault: null }).useTotp("vic", totp(plainEnrol.secret, { time: vaultNow + 30000 })), false, "without the vault a vault-held secret cannot be read");
  const versionBefore = vaultUsers.credentialVersion("vic");
  const reset = vaultUsers.enableTotp("vic");
  assert.equal(reset.store, "vault:windows");
  assert.equal(memory.get("vic"), reset.secret);
  assert.ok(!readFileSync(join(vaultDir, "users.json"), "utf8").includes(reset.secret), "a new secret goes straight into the vault");
  assert.notEqual(vaultUsers.credentialVersion("vic"), versionBefore, "a TOTP reset bumps the credential version");
  vaultUsers.disableTotp("vic");
  assert.equal(memory.has("vic"), false, "disabling TOTP removes the vault entry");
  vaultUsers.enableTotp("vic");
  vaultUsers.remove("vic");
  assert.equal(memory.has("vic"), false, "removing the user removes the vault entry");

  // `astack console user set` reads the password from stdin (BOM-safe) and keeps only the hash.
  const cliWorkspace = workspace();
  const cliRuntime = createRuntime({ workspaceRoot: cliWorkspace });
  const i18n = createLocalization({ locale: "en" });
  const printed = [];
  const originalLog = console.log;
  console.log = (line) => printed.push(String(line));
  try {
    await runConsoleCommand({ runtime: cliRuntime, i18n, tokens: ["user", "set", "Alice"], stdin: Readable.from([Buffer.from("\uFEFFs3cret-Passw0rd!\n")]) });
    await runConsoleCommand({ runtime: cliRuntime, i18n, tokens: ["user", "totp", "alice"] });
    await runConsoleCommand({ runtime: cliRuntime, i18n, tokens: ["user", "list"] });
  } finally {
    console.log = originalLog;
  }
  const usersFile = readFileSync(join(cliWorkspace, ".astack", "console", "users.json"), "utf8");
  assert.ok(!usersFile.includes("s3cret-Passw0rd!"), "the password never reaches the disk");
  const cliUsers = new ConsoleUsers(join(cliWorkspace, ".astack", "console"));
  assert.equal(await cliUsers.checkPassword("alice", "s3cret-Passw0rd!"), "alice", "the BOM is not part of the password");
  assert.ok(printed.some((line) => /^otpauth:\/\/totp\/Aramin:alice\?secret=[A-Z2-7]+&issuer=Aramin/.test(line)), "totp prints the otpauth URI");
  assert.ok(printed.some((line) => line.startsWith("- alice") && line.includes("totp: on")));
  assert.ok(cliRuntime.audit.list({ action: "console-user-set" }).length === 1);
  await assert.rejects(() => cliUsers.set("bob", "short"), /at least 10/);
  await assert.rejects(() => cliUsers.set("../evil", "long-enough-password"), /username/i);
  // The secret is printed at enrolment only, and on Windows it is kept with DPAPI.
  const cliSecret = /secret=([A-Z2-7]+)/.exec(printed.find((line) => line.startsWith("otpauth://")))[1];
  if (process.platform === "win32") {
    assert.ok(!usersFile.includes(cliSecret), "Windows: the TOTP secret never reaches users.json");
    assert.equal(JSON.parse(usersFile).users.alice.totp.store, "vault:windows");
    const dpapiFile = join(cliWorkspace, ".astack", "vault", "console-totp.alice.dpapi");
    assert.ok(existsSync(dpapiFile), "Windows: the secret is DPAPI-encrypted under .astack/vault");
    assert.ok(!readFileSync(dpapiFile, "utf8").includes(cliSecret));
    assert.ok(printed.some((line) => line.includes("vault:windows")));
  } else {
    assert.ok(usersFile.includes(cliSecret), "other platforms: the secret stays in users.json");
  }
  assert.equal(cliUsers.useTotp("alice", totp(cliSecret, { time: Date.now() })), true, "the stored secret verifies codes");
  // Unattended processes (runner children, conversations) never manage sign-in.
  const unattendedBefore = process.env.ASTACK_UNATTENDED;
  process.env.ASTACK_UNATTENDED = "1";
  try {
    for (const tokens of [["token"], ["token", "--rotate"], ["user", "set", "mallory"], ["user", "remove", "alice"], ["user", "totp", "alice"], ["user", "totp", "alice", "--disable"]]) {
      await assert.rejects(() => runConsoleCommand({ runtime: cliRuntime, i18n, tokens, stdin: Readable.from([Buffer.from("another-long-password\n")]) }), /unattended/i, "refused when unattended: " + tokens.join(" "));
    }
    console.log = () => {};
    await runConsoleCommand({ runtime: cliRuntime, i18n, tokens: ["user", "list"] });
  } finally {
    console.log = originalLog;
    if (unattendedBefore === undefined) delete process.env.ASTACK_UNATTENDED;
    else process.env.ASTACK_UNATTENDED = unattendedBefore;
  }
  assert.equal(new ConsoleUsers(join(cliWorkspace, ".astack", "console")).hasTotp("alice"), true, "nothing changed while unattended");
  // `console status` names the reason the internet listener would not start.
  const statusLines = [];
  console.log = (line) => statusLines.push(String(line));
  try {
    await runConsoleCommand({ runtime: { ...cliRuntime, configuration: { section: () => ({ remote: { enabled: true, hostname: "console.example.test" } }), get: () => null } }, i18n, tokens: ["status"] });
  } finally {
    console.log = originalLog;
  }
  assert.ok(statusLines.some((line) => /access\.team/.test(line)), "console status explains the missing Cloudflare Access settings");

  // ================================================ Cloudflare Access (JWT)
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  let certFetches = 0;
  const certs = createServer((req, res) => {
    certFetches += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((done) => certs.listen(0, "127.0.0.1", done));
  closers.push(() => new Promise((done) => certs.close(done)));
  const certsUrl = "http://127.0.0.1:" + certs.address().port + "/cdn-cgi/access/certs";
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = (claims, { key = privateKey, kid = "k1", alg = "RS256" } = {}) => {
    const head = b64({ alg, kid, typ: "JWT" }) + "." + b64(claims);
    return head + "." + signData("RSA-SHA256", Buffer.from(head), key).toString("base64url");
  };

  // ========================================================= local listener
  let now = Date.parse("2026-10-14T10:00:00Z");
  const clock = () => new Date(now);
  const tick = (ms = 30000) => {
    now += ms;
  };
  const localWorkspace = workspace();
  const localRuntime = createRuntime({ workspaceRoot: localWorkspace });
  const users = new ConsoleUsers(join(localWorkspace, ".astack", "console"), { clock });
  await users.set("owner", "a-long-owner-password");
  const settings = resolveConsoleSettings({
    allowed_hosts: ["aramin.lan", "console.example.test"],
    session_idle: "2h",
    remote: { enabled: true, hostname: "Console.Example.Test", port: 0, access: { team: "testteam", aud: "AUD123", emails: ["Owner@Example.com"] } }
  });
  assert.deepEqual(settings.remote.access.emails, ["owner@example.com"], "the Access allowlist is compared without case");
  assert.equal(settings.remote.runner, false, "console.remote.runner defaults to off");
  assert.match(resolveRemoteSettings({ enabled: true, hostname: "console.example.test" }).error, /access\.team and console\.remote\.access\.aud are required/, "3.1.1: no internet listener without Cloudflare Access");
  assert.match(resolveRemoteSettings({ enabled: true, hostname: "console.example.test", access: { team: "testteam" } }).error, /aud/);
  assert.match(resolveRemoteSettings({ enabled: true, hostname: "console.example.test", access: { team: "bad/team", aud: "x" } }).error, /team/);
  assert.deepEqual(settings.allowedHosts, ["aramin.lan"], "the public host name is never a local allowed host");
  assert.ok(settings.warnings.some((line) => /console\.example\.test/.test(line)));
  assert.equal(settings.sessionIdleMs, 2 * 3600 * 1000);
  assert.equal(settings.remote.hostname, "console.example.test");
  assert.equal(resolveRemoteSettings({ enabled: true, hostname: "console.example.test", host: "0.0.0.0" }).error ? true : false, true, "the remote listener binds loopback only");
  assert.ok(resolveRemoteSettings({ enabled: true, hostname: "not a host" }).error);
  assert.equal(resolveRemoteSettings({ enabled: false, hostname: "x.example" }), null);
  assert.ok(resolveRemoteSettings({ enabled: true, hostname: "x.example", session_hours: 48, access: { team: "t", aud: "a" } }).sessionMs <= 12 * 3600 * 1000, "remote sessions last 12 hours at most");
  assert.ok(HEARTBEAT_MS <= 30000, "SSE keep-alives at least every 30 seconds");

  // No TOTP user yet: the remote listener refuses to start; the local one runs.
  const local = await start({ runtime: localRuntime, clock, ...settings, port: 0, accessCertsUrl: certsUrl });
  const base = local.origin;
  assert.equal(local.describe().remote.running, false, "no remote listener without a TOTP user");
  assert.match(local.describe().remote.error, /two-factor/);
  const serverRecord = JSON.parse(readFileSync(join(localWorkspace, ".astack", "console", "server.json"), "utf8"));
  assert.equal(serverRecord.remote.running, false, "console status sees the remote listener state");
  // Without Access settings the internet listener refuses to start, and says why.
  const accessLog = [];
  const noAccess = await start({ runtime: localRuntime, clock, remote: resolveRemoteSettings({ enabled: true, hostname: "console.example.test", port: 0 }), log: (line) => accessLog.push(line) });
  assert.equal(noAccess.describe().remote.running, false);
  assert.match(noAccess.describe().remote.error, /access\.team/);
  assert.ok(accessLog.some((line) => /remote listener not started: .*access\.team/.test(line)), "the log names the missing Access settings");
  await noAccess.stop();

  // The local listener never answers the public host name — also when bound beyond loopback.
  assert.equal((await call(base, "/api/health", { host: "console.example.test" })).status, 421);
  assert.equal((await call(base, "/api/health", { host: "Console.Example.Test:443" })).status, 421);
  assert.equal((await call(base, "/api/health", { host: "aramin.lan:" + local.port })).status, 200, "a LAN name in allowed_hosts still works");
  const boundHost = local.host;
  local.host = "0.0.0.0";
  assert.equal(local.hostAllowed("console.example.test"), false, "non-loopback bind: the public host name is still refused");
  assert.equal(local.hostAllowed("console.example.test:7717"), false);
  assert.equal(local.hostAllowed("192.168.1.10:7717"), true, "other names are the owner's chosen exposure");
  local.host = boundHost;
  // Port 7717 refuses anything a proxy or Cloudflare would add.
  for (const header of ["cf-connecting-ip", "cf-ray", "cf-access-jwt-assertion", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-forwarded-port", "forwarded"]) {
    const refused = await call(base, "/api/health", { headers: { [header]: header === "forwarded" ? "for=203.0.113.1" : "203.0.113.1" } });
    assert.equal(refused.status, 403, "local listener refuses " + header);
    assert.equal(refused.json.error, "request refused", "with a generic message");
  }
  assert.equal(hasProxyHeaders({ "X-Forwarded-Server": "x" }), true, "any x-forwarded-* header counts");
  assert.equal(hasProxyHeaders({ host: "127.0.0.1", cookie: "a=b" }), false);
  // A malformed %-escape is a 400, not a 500.
  assert.equal((await call(base, "/api/approvals/%E0%A4%A")).status, 401, "unauthenticated first");
  assert.equal((await call(base, "/api/session", { headers: { cookie: "aramin_sid=%E0%A4%A" } })).status, 400, "a malformed cookie is a 400");

  const session0 = (await call(base, "/api/session")).json;
  assert.deepEqual(session0.login.methods, ["password", "token"], "auth defaults to both once a user exists");
  assert.equal(session0.login.totp, "off");

  // Password login, uniform failures, lockout per address.
  const login = (body, extra = {}) => call(base, "/api/login", { method: "POST", body, origin: base, ...extra });
  const wrong = await login({ username: "owner", password: "nope-nope-nope" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error, "invalid credentials");
  assert.equal((await login({ username: "nobody", password: "nope-nope-nope" })).json.error, "invalid credentials", "unknown users get the same answer");
  const good = await login({ username: "Owner", password: "a-long-owner-password" });
  assert.equal(good.status, 200, good.text);
  assert.match(String(good.headers["set-cookie"]), /HttpOnly/);
  assert.doesNotMatch(String(good.headers["set-cookie"]), /Secure/, "plain http on loopback: no Secure flag");
  const ownerCookie = cookieOf(good);
  const ownerSession = (await call(base, "/api/session", { cookie: ownerCookie })).json;
  assert.equal(ownerSession.user, "owner");
  assert.equal(ownerSession.features.chats.enabled, true);
  const failures = localRuntime.audit.list({ action: "console-login-failed" });
  assert.ok(failures.length >= 2 && failures.every((entry) => !JSON.stringify(entry).includes("nope-nope-nope")), "failures are audited without the password");
  assert.ok(localRuntime.audit.list({ action: "console-login" }).some((entry) => /owner/.test(entry.result)));
  // Proxy headers are refused on the local listener, so a forged CF-Connecting-IP cannot even reach the lock.
  assert.equal((await login({ username: "ghost", password: "wrong-password-x" }, { headers: { "cf-connecting-ip": "203.0.113.10" } })).status, 403);
  for (let i = 0; i < 5; i += 1) {
    await login({ username: "ghost" + i, password: "wrong-password-x" });
  }
  const locked = await login({ username: "owner", password: "a-long-owner-password" });
  assert.equal(locked.status, 429, "5 failures lock the (socket) address for 15 minutes");
  assert.ok(existsSync(join(localWorkspace, ".astack", "console", "lockouts.json")), "the lock is persisted");
  tick(15 * 60000 + 1000);
  assert.equal((await login({ username: "owner", password: "a-long-owner-password" })).status, 200, "the lock ends");

  // TOTP for local sign-in once enabled.
  const enabled = users.enableTotp("owner");
  assert.equal((await call(base, "/api/session")).json.login.totp, "required");
  assert.equal((await login({ username: "owner", password: "a-long-owner-password" })).status, 401, "the code is required once TOTP is on");
  tick();
  const code1 = totp(enabled.secret, { time: now });
  assert.equal((await login({ username: "owner", password: "a-long-owner-password", code: code1 })).status, 200);
  assert.equal((await login({ username: "owner", password: "a-long-owner-password", code: code1 })).status, 401, "a TOTP code works once");

  // Token login and tickets keep working on the local listener.
  let token = readFileSync(join(localWorkspace, ".astack", "console", "token"), "utf8").trim();
  let tokenLogin = await login({ token });
  assert.equal(tokenLogin.status, 200);
  const ticket = local.auth.issueTicket();
  assert.equal((await login({ ticket }, { headers: { "x-forwarded-for": "203.0.113.5" } })).status, 403, "a ticket through a proxy is refused");
  assert.equal((await login({ ticket })).status, 200, "a ticket from this computer signs in");
  // console.auth: password turns the token off.
  local.authModeSetting = "password";
  assert.equal((await login({ token })).status, 403);
  local.authModeSetting = null;

  // 3.1.1: a password session is bound to the user's credential version.
  tick();
  const pwLogin = await login({ username: "owner", password: "a-long-owner-password", code: totp(enabled.secret, { time: now }) });
  assert.equal(pwLogin.status, 200, pwLogin.text);
  const pwCookie = cookieOf(pwLogin);
  const tokenSide = cookieOf(await login({ token }));
  assert.equal((await call(base, "/api/home", { cookie: pwCookie })).status, 200);
  const sessionsFile = () => JSON.parse(readFileSync(join(localWorkspace, ".astack", "console", "sessions.json"), "utf8"));
  assert.ok(Object.values(sessionsFile()).some((entry) => entry.user === "owner" && entry.credentialVersion), "the session records the credential version");
  // `astack console user set` (another process in real life) changes the password and ends that user's sessions.
  console.log = () => {};
  try {
    await runConsoleCommand({ runtime: localRuntime, i18n, tokens: ["user", "set", "owner"], stdin: Readable.from([Buffer.from("a-long-owner-password\n")]) });
  } finally {
    console.log = originalLog;
  }
  assert.ok(!Object.values(sessionsFile()).some((entry) => entry.user === "owner"), "the CLI revokes the user's sessions");
  assert.equal((await call(base, "/api/home", { cookie: pwCookie })).status, 401, "a session from before the password change is refused");
  assert.equal((await call(base, "/api/home", { cookie: tokenSide })).status, 200, "token sessions are not tied to a user");
  // A stale version alone is enough, even when the server still holds the session.
  tick();
  const pw2 = await login({ username: "owner", password: "a-long-owner-password", code: totp(enabled.secret, { time: now }) });
  const pw2Cookie = cookieOf(pw2);
  const data = JSON.parse(readFileSync(join(localWorkspace, ".astack", "console", "users.json"), "utf8"));
  data.users.owner.credentialVersion = "changed-elsewhere";
  writeFileSync(join(localWorkspace, ".astack", "console", "users.json"), JSON.stringify(data));
  assert.equal((await call(base, "/api/home", { cookie: pw2Cookie })).status, 401, "a stale credential version is refused");
  // `console token --rotate` still signs every device out.
  console.log = () => {};
  try {
    await runConsoleCommand({ runtime: localRuntime, i18n, tokens: ["token", "--rotate"] });
  } finally {
    console.log = originalLog;
  }
  assert.equal((await call(base, "/api/home", { cookie: tokenSide })).status, 401, "token rotation ends every session, even in a running server");
  const rotated = readFileSync(join(localWorkspace, ".astack", "console", "token"), "utf8").trim();
  assert.notEqual(rotated, token);
  token = rotated;

  // Idle timeout (console.session_idle: 2h) and sign out everywhere.
  const tokenCookie = cookieOf(tokenLogin);
  assert.equal((await call(base, "/api/home", { cookie: tokenCookie })).status, 401, "the earlier token session ended with the rotation");
  tokenLogin = await login({ token });
  const idleCookie = cookieOf(tokenLogin);
  tick(60 * 60000);
  assert.equal((await call(base, "/api/home", { cookie: idleCookie })).status, 200);
  tick(2 * 60 * 60000 + 1000);
  assert.equal((await call(base, "/api/home", { cookie: idleCookie })).status, 401, "an idle session ends");
  const fresh = await login({ token });
  const freshCookie = cookieOf(fresh);
  const second = cookieOf(await login({ token }));
  const everywhere = await call(base, "/api/logout-all", { method: "POST", body: {}, cookie: freshCookie, csrf: fresh.json.csrf, origin: base });
  assert.equal(everywhere.status, 200);
  assert.ok(everywhere.json.data.ended >= 2);
  assert.equal((await call(base, "/api/home", { cookie: second })).status, 401, "sign out everywhere ends every session");
  assert.ok(localRuntime.audit.list({ action: "console-logout-all" }).length === 1);
  await local.stop();

  // ======================================================== remote listener
  // Now a user has TOTP: the remote listener starts.
  const nowSeconds = () => Math.floor(now / 1000);
  const claims = (extra = {}) => ({ aud: ["AUD123"], iss: "https://testteam.cloudflareaccess.com", exp: nowSeconds() + 600, iat: nowSeconds(), email: "owner@example.com", ...extra });
  const fakeRuns = [];
  localRuntime.runner = {
    async execute({ objective, dryRun }) {
      const run = { id: "R-" + (fakeRuns.length + 1), objective, source: "console", status: dryRun ? "dry-run" : "completed", summary: dryRun ? "plan" : "done", output: "ok", approvals: [] };
      if (!dryRun) fakeRuns.push(run);
      return run;
    },
    list: () => fakeRuns,
    get: (id) => fakeRuns.find((run) => run.id === id) ?? null
  };
  const remoteServer = await start({ runtime: localRuntime, clock, ...settings, port: 0, accessCertsUrl: certsUrl });
  const remote = remoteServer.describe().remote;
  assert.equal(remote.running, true, remote.error ?? "remote listener running");
  assert.equal(remote.accessEmails, 1);
  const rbase = remote.url;
  const HOST = "console.example.test";
  const ORIGIN = "https://" + HOST;
  // Every internet request carries Cloudflare Access's assertion (a fresh one per call).
  const rcall = (path, options = {}) => call(rbase, path, { host: HOST, ...options, headers: { "cf-access-jwt-assertion": jwt(claims()), ...(options.headers ?? {}) } });
  // console.remote.access.emails: only the listed Access identity gets through.
  assert.equal((await rcall("/api/health", { headers: { "cf-access-jwt-assertion": jwt(claims({ email: "intruder@example.com" })) } })).status, 403, "an Access identity outside the allowlist is refused");
  assert.equal((await rcall("/api/health", { headers: { "cf-access-jwt-assertion": jwt(claims({ email: undefined })) } })).status, 403, "an assertion without an e-mail is refused when the allowlist is set");
  assert.equal((await rcall("/api/health", { headers: { "cf-access-jwt-assertion": jwt(claims({ email: "OWNER@example.com" })) } })).status, 200, "the e-mail is compared without case");
  assert.equal((await rcall("/api/health", { headers: { "cf-access-jwt-assertion": "" } })).status, 403, "no assertion, no answer");
  assert.equal((await call(rbase, "/api/health", { host: "127.0.0.1:" + remote.port })).status, 421, "the remote listener answers its public name only");
  assert.equal((await call(rbase, "/api/health", { host: "evil.example" })).status, 421);
  assert.equal((await rcall("/api/health")).status, 200);
  const rsession = (await rcall("/api/session")).json;
  assert.deepEqual(rsession.login, { methods: ["password"], totp: "required", remote: true });
  const rlogin = (body, headers = {}) => rcall("/api/login", { method: "POST", body, origin: ORIGIN, headers });
  assert.equal((await rcall("/api/session", { headers: { cookie: "__Host-aramin_sid=%ZZ" } })).status, 400, "remote: a malformed cookie is a 400");
  assert.equal((await rlogin({ token })).status, 403, "no token sign-in over the internet");
  assert.equal((await rlogin({ ticket: remoteServer.auth.issueTicket() })).status, 403, "no ticket sign-in over the internet");
  assert.equal((await rcall("/api/login", { method: "POST", body: { username: "owner", password: "a-long-owner-password", code: "000000" }, origin: rbase })).status, 403, "Origin must be https://<hostname>");
  tick();
  assert.equal((await rlogin({ username: "owner", password: "a-long-owner-password" })).status, 401, "TOTP is mandatory remotely");
  // Per-address lock with Cloudflare's client address; another address is unaffected.
  for (let i = 0; i < 5; i += 1) {
    await rlogin({ username: "stranger" + i, password: "wrong-password-x", code: "123456" }, { "cf-connecting-ip": "203.0.113.9" });
  }
  tick();
  assert.equal((await rlogin({ username: "owner", password: "a-long-owner-password", code: totp(enabled.secret, { time: now }) }, { "cf-connecting-ip": "203.0.113.9" })).status, 429, "CF-Connecting-IP is the client address on the remote listener");
  const remoteLogin = await rlogin({ username: "owner", password: "a-long-owner-password", code: totp(enabled.secret, { time: now }) }, { "cf-connecting-ip": "198.51.100.20" });
  assert.equal(remoteLogin.status, 200, remoteLogin.text);
  assert.ok(localRuntime.audit.list({ action: "console-login" }).some((entry) => /remote, access owner@example\.com/.test(entry.result)), "the login audit names the Access identity");
  assert.ok(localRuntime.audit.list({ action: "console-login-failed" }).some((entry) => /access owner@example\.com/.test(entry.result)), "failed remote logins too");
  const rcookieHeader = String(remoteLogin.headers["set-cookie"]);
  assert.match(rcookieHeader, /^__Host-aramin_sid=/);
  assert.match(rcookieHeader, /; HttpOnly/);
  assert.match(rcookieHeader, /; Secure/);
  assert.match(rcookieHeader, /SameSite=Strict/);
  assert.ok(Number(/Max-Age=(\d+)/.exec(rcookieHeader)[1]) <= 12 * 3600, "remote sessions last 12 hours at most");
  const rcookie = cookieOf(remoteLogin);
  const rcsrf = remoteLogin.json.csrf;
  const rme = (await rcall("/api/session", { cookie: rcookie })).json;
  assert.equal(rme.authenticated, true);
  assert.equal(rme.stepUp, "totp");
  assert.deepEqual(rme.features.chats, { enabled: false, reason: "remote" }, "conversations are off over the internet");
  // Sessions are bound to their listener.
  assert.equal((await call(base === remoteServer.origin ? base : remoteServer.origin, "/api/home", { cookie: rcookie.replace("__Host-aramin_sid", "aramin_sid") })).status, 401, "a remote session is not a local session");
  // Per-username lock across addresses.
  for (let i = 0; i < 5; i += 1) {
    await rlogin({ username: "owner", password: "wrong-password-x", code: "123456" }, { "cf-connecting-ip": "192.0.2." + (i + 1) });
  }
  tick();
  assert.equal((await rlogin({ username: "owner", password: "a-long-owner-password", code: totp(enabled.secret, { time: now }) }, { "cf-connecting-ip": "192.0.2.99" })).status, 429, "5 failures lock the username from every address");
  // Conversations: 403 on every chat endpoint remotely.
  assert.equal((await rcall("/api/chats", { cookie: rcookie })).status, 403);
  assert.equal((await rcall("/api/chats", { method: "POST", body: { prompt: "hi" }, cookie: rcookie, csrf: rcsrf, origin: ORIGIN })).status, 403);
  // Writes need Origin https://<hostname> and the CSRF token.
  const l4 = localRuntime.approvals.request({ action: "email.send", summary: "Send the quote", level: "L4", requestedBy: "test" });
  const l4code = (await rcall("/api/approvals/" + l4.id, { cookie: rcookie })).json.data.confirmCode;
  const rdecide = (body, extra = {}) => rcall("/api/approvals/" + l4.id + "/decide", { method: "POST", body, cookie: rcookie, csrf: rcsrf, origin: ORIGIN, ...extra });
  assert.equal((await rdecide({ decision: "approve", confirm: l4code }, { origin: "http://" + HOST })).status, 403, "http origin refused remotely");
  tick(16 * 60000);
  const noStepUp = await rdecide({ decision: "approve", confirm: l4code });
  assert.equal(noStepUp.status, 422);
  assert.equal(noStepUp.json.stepUpRequired, true, "L4 approval over the internet needs a fresh TOTP code");
  assert.equal(localRuntime.approvals.get(l4.id).state, "pending");
  tick();
  const stepped = await rdecide({ decision: "approve", confirm: l4code, totp: totp(enabled.secret, { time: now }) });
  assert.equal(stepped.status, 200, stepped.text);
  assert.equal(localRuntime.approvals.get(l4.id).state, "approved");
  const stepAudit = localRuntime.audit.list({ action: "console-step-up" });
  assert.equal(stepAudit.length, 1, "a successful step-up is audited");
  assert.match(stepAudit[0].result, /owner \(approval /);
  assert.ok(!JSON.stringify(stepAudit).includes(totp(enabled.secret, { time: now })), "never the code");
  const plain = localRuntime.approvals.request({ action: "report.draft", summary: "Draft", level: "L2", requestedBy: "test" });
  assert.equal((await rcall("/api/approvals/" + plain.id + "/decide", { method: "POST", body: { decision: "approve" }, cookie: rcookie, csrf: rcsrf, origin: ORIGIN })).status, 200, "a reversible approval needs no step-up");
  // Generic error text on the internet listener; the local one keeps its detail.
  const missing = await rcall("/api/approvals/AP-doesnotexist", { cookie: rcookie });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error, "not found", "no internal message over the internet");
  assert.equal((await rcall("/api/approvals/%E0%A4%A", { cookie: rcookie })).status, 400, "a malformed path escape is a 400");

  // ------------------------------------------ S2.1 runs and jobs over the internet
  const rpost = (path, body) => rcall(path, { method: "POST", body, cookie: rcookie, csrf: rcsrf, origin: ORIGIN });
  const preview = await rpost("/api/runs", { objective: "Draft the weekly report", dryRun: true });
  assert.equal(preview.status, 200, "a dry-run preview is allowed remotely");
  const realOff = await rpost("/api/runs", { objective: "Draft the weekly report", dryRun: false, previewId: preview.json.data.previewId });
  assert.equal(realOff.status, 403, "console.remote.runner off: no real run over the internet");
  assert.equal(realOff.json.remoteRunner, false);
  assert.equal(realOff.json.error, "forbidden");
  assert.equal((await rpost("/api/jobs/any-job/run", {})).status, 403, "and no run-now");
  assert.equal(fakeRuns.length, 0);
  assert.equal((await rcall("/api/session", { cookie: rcookie })).json.server.runner, false, "the app knows runs are off");
  remoteServer.remote.runner = true;
  const noCode = await rpost("/api/runs", { objective: "Draft the weekly report", dryRun: false, previewId: preview.json.data.previewId });
  assert.equal(noCode.status, 422, "a real remote run needs a step-up code");
  assert.equal(noCode.json.stepUpRequired, true);
  tick();
  const realOn = await rpost("/api/runs", { objective: "Draft the weekly report", dryRun: false, previewId: preview.json.data.previewId, totp: totp(enabled.secret, { time: now }) });
  assert.equal(realOn.status, 200, realOn.text);
  assert.equal(fakeRuns.length, 1);
  const jobNoCode = await rpost("/api/jobs/any-job/run", {});
  assert.equal(jobNoCode.status, 422, "run-now needs a step-up code too");
  tick();
  assert.equal((await rpost("/api/jobs/any-job/run", { totp: totp(enabled.secret, { time: now }) })).status, 404, "after the code, the job itself is looked up");
  remoteServer.remote.runner = false;

  // ------------------------- S2.2 conversation approvals stay out of the internet listener
  const rstream = await openStream(rbase, rcookie, { host: HOST, headers: { "cf-access-jwt-assertion": jwt(claims()) } });
  assert.equal(rstream.status, 200);
  const lcookie = cookieOf(await call(remoteServer.origin, "/api/login", { method: "POST", body: { token }, origin: remoteServer.origin }));
  const lstream = await openStream(remoteServer.origin, lcookie);
  await waitFor(() => rstream.events.some((event) => event.type === "hello") && lstream.events.some((event) => event.type === "hello"), { what: "both streams" });
  const chatApproval = localRuntime.approvals.request({ action: "claude.tool", summary: "Bash: git push", tool: "Bash", target: "git push", level: "L3", requestedBy: "console-chat:S-test" });
  await waitFor(() => lstream.events.some((event) => event.type === "notification" && event.data.ref === chatApproval.id), { what: "local notification" });
  assert.ok(lstream.events.some((event) => event.type === "activity" && event.data.payload?.id === chatApproval.id), "the local stream sees the request");
  await sleep(400);
  assert.ok(!JSON.stringify(rstream.events).includes(chatApproval.id), "the remote stream never sees a conversation's request (activity or notification)");
  const lastRemoteCounts = rstream.events.filter((event) => event.type === "counts").at(-1);
  const lastLocalCounts = lstream.events.filter((event) => event.type === "counts").at(-1);
  assert.ok(lastLocalCounts && lastLocalCounts.data.approvals === (lastRemoteCounts?.data.approvals ?? rstream.events.find((event) => event.type === "hello").data.counts.approvals) + 1, "remote badge counts leave it out");
  const rlist = (await rcall("/api/approvals?state=all", { cookie: rcookie })).json.data;
  assert.ok(!rlist.items.some((item) => item.id === chatApproval.id), "not in the remote list");
  const llist = (await call(remoteServer.origin, "/api/approvals?state=all", { cookie: lcookie })).json.data;
  assert.ok(llist.items.some((item) => item.id === chatApproval.id), "but in the local list");
  assert.equal(rlist.pending + 1, llist.pending, "pending count without it");
  assert.equal((await rcall("/api/approvals/" + chatApproval.id, { cookie: rcookie })).status, 404, "no remote detail");
  assert.equal((await rcall("/api/counts", { cookie: rcookie })).json.data.approvals + 1, (await call(remoteServer.origin, "/api/counts", { cookie: lcookie })).json.data.approvals);
  assert.ok(!(await rcall("/api/home", { cookie: rcookie })).json.data.approvals.some((item) => item.id === chatApproval.id), "not on the remote home screen");
  assert.ok(!(await rcall("/api/notifications", { cookie: rcookie })).json.data.items.some((item) => item.ref === chatApproval.id), "not in remote notifications");
  assert.ok(!JSON.stringify((await rcall("/api/search?q=git%20push", { cookie: rcookie })).json.data.approvals).includes(chatApproval.id), "not in remote search");
  tick();
  const remoteAllow = await rpost("/api/approvals/" + chatApproval.id + "/decide", { decision: "approve", totp: totp(enabled.secret, { time: now }) });
  assert.equal(remoteAllow.status, 403, "a conversation's tool use is never approved remotely while conversations are closed there");
  assert.equal(localRuntime.approvals.get(chatApproval.id).state, "pending");
  assert.equal((await rpost("/api/approvals/" + chatApproval.id + "/decide", { decision: "deny", note: "not from the phone" })).status, 200, "deny is allowed remotely");
  assert.equal(localRuntime.approvals.get(chatApproval.id).state, "rejected");
  await sleep(400);
  assert.ok(!JSON.stringify(rstream.events).includes(chatApproval.id), "nor its decision");
  rstream.req.destroy();
  lstream.req.destroy();

  // ------------------------------------- S2.5 remote sessions follow the credential version
  console.log = () => {};
  try {
    await runConsoleCommand({ runtime: localRuntime, i18n, tokens: ["user", "totp", "owner"] });
  } finally {
    console.log = originalLog;
  }
  assert.equal((await rcall("/api/home", { cookie: rcookie })).status, 401, "a TOTP reset ends the remote session");
  await remoteServer.stop();

  // ================================================ Cloudflare Access (JWT)
  const verifier = new AccessVerifier({ team: "testteam", aud: "AUD123", certsUrl, clock });
  assert.equal((await verifier.verify(jwt(claims()))).ok, true);
  assert.equal((await verifier.verify(jwt(claims({ aud: ["OTHER"] })))).reason, "wrong audience");
  assert.equal((await verifier.verify(jwt(claims({ iss: "https://evil.cloudflareaccess.com" })))).reason, "wrong issuer");
  assert.equal((await verifier.verify(jwt(claims({ exp: nowSeconds() - 3600 })))).reason, "expired");
  assert.equal((await verifier.verify(jwt(claims(), { key: other.privateKey }))).reason, "bad signature");
  assert.match((await verifier.verify(jwt(claims(), { alg: "HS256" }))).reason, /algorithm/);
  assert.equal((await verifier.verify("")).ok, false);
  assert.ok(certFetches <= 4, "keys are cached");
  assert.throws(() => new AccessVerifier({ team: "bad/team", aud: "x" }), /team/);

  const accessSettings = resolveConsoleSettings({ remote: { enabled: true, hostname: HOST, port: 0, access: { team: "testteam", aud: "AUD123" } } });
  const guarded = await start({ runtime: localRuntime, clock, ...accessSettings, port: 0, accessCertsUrl: certsUrl });
  const gremote = guarded.describe().remote;
  assert.equal(gremote.running, true, gremote.error ?? "");
  assert.equal(gremote.access, true);
  assert.equal((await call(gremote.url, "/api/health", { host: HOST })).status, 403, "no assertion, no answer");
  assert.equal((await call(gremote.url, "/", { host: HOST })).status, 403, "the shell is protected too");
  assert.equal((await call(gremote.url, "/api/health", { host: HOST, headers: { "cf-access-jwt-assertion": jwt(claims({ aud: "OTHER" })) } })).status, 403);
  assert.equal((await call(gremote.url, "/api/health", { host: HOST, headers: { "cf-access-jwt-assertion": jwt(claims()) } })).status, 200);
  assert.equal((await call(guarded.origin, "/api/health")).status, 200, "the local listener does not need Access");
  await guarded.stop();

  // 3.1.3: console.remote.totp: false (owner decision). Cloudflare Access stays
  // mandatory; the password signs in and is asked again for step-up.
  {
    const ws = workspace();
    const rt = createRuntime({ workspaceRoot: ws });
    await new ConsoleUsers(join(ws, ".astack", "console"), { clock }).set("plain", "a-long-plain-password");
    const noTotp = resolveConsoleSettings({ remote: { enabled: true, hostname: HOST, port: 0, totp: false, access: { team: "testteam", aud: "AUD123" } } });
    assert.equal(noTotp.remote.totp, false);
    assert.equal(resolveConsoleSettings({ remote: { enabled: true, hostname: HOST, port: 0, access: { team: "testteam", aud: "AUD123" } } }).remote.totp, true, "TOTP stays the default");
    const srv = await start({ runtime: rt, clock, ...noTotp, port: 0, accessCertsUrl: certsUrl });
    const rem = srv.describe().remote;
    assert.equal(rem.running, true, "the internet listener starts without a TOTP user when totp is off: " + (rem.error ?? ""));
    const pcall = (path, options = {}) => call(rem.url, path, { host: HOST, ...options, headers: { "cf-access-jwt-assertion": jwt(claims()), ...(options.headers ?? {}) } });
    assert.equal((await call(rem.url, "/api/health", { host: HOST })).status, 403, "Access is still required");
    assert.equal((await pcall("/api/session")).json.login.totp, "off");
    assert.equal((await pcall("/api/login", { method: "POST", body: { username: "plain", password: "wrong-password-x" }, origin: ORIGIN })).status, 401);
    const ok = await pcall("/api/login", { method: "POST", body: { username: "plain", password: "a-long-plain-password" }, origin: ORIGIN, headers: { "cf-connecting-ip": "198.51.100.77" } });
    assert.equal(ok.status, 200, ok.text);
    const pcookie = cookieOf(ok);
    const pcsrf = ok.json.csrf;
    assert.equal((await pcall("/api/session", { cookie: pcookie })).json.stepUp, "password", "step-up asks for the password");
    const item = rt.approvals.request({ action: "email.send", summary: "Send", level: "L4", requestedBy: "test" });
    const code = (await pcall("/api/approvals/" + item.id, { cookie: pcookie })).json.data.confirmCode;
    const decide = (body) => pcall("/api/approvals/" + item.id + "/decide", { method: "POST", body, cookie: pcookie, csrf: pcsrf, origin: ORIGIN, headers: { "cf-connecting-ip": "198.51.100.77" } });
    assert.equal((await decide({ decision: "approve", confirm: code })).status, 422, "an irreversible approval still needs a step-up");
    assert.equal((await decide({ decision: "approve", confirm: code, totp: "wrong-password-x" })).status, 422, "a wrong password is no step-up");
    const approved = await decide({ decision: "approve", confirm: code, totp: "a-long-plain-password" });
    assert.equal(approved.status, 200, approved.text);
    assert.equal(rt.approvals.get(item.id).state, "approved");
    await srv.stop();
  }

  // ================================================= transcripts and parsing
  const claudeHome = sandbox("astack-claude-home-");
  const project = sandbox("astack-chat-project-");
  const otherProject = sandbox("astack-chat-other-");
  const slug = claudeSlug(resolve(project));
  const flipped = /^[A-Za-z]--/.test(slug) ? (slug[0] === slug[0].toUpperCase() ? slug[0].toLowerCase() : slug[0].toUpperCase()) + slug.slice(1) : null;
  const dirA = join(claudeHome, "projects", slug);
  const dirB = flipped ? join(claudeHome, "projects", flipped) : dirA;
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  const line = (entry) => JSON.stringify(entry);
  const S1 = "11111111-1111-4111-8111-111111111111";
  const S2 = "22222222-2222-4222-8222-222222222222";
  const S3 = "33333333-3333-4333-8333-333333333333";
  const S4 = "44444444-4444-4444-8444-444444444444";
  const leakKey = "sk-ant-api03-" + "Z".repeat(40);
  writeFileSync(join(dirA, S1 + ".jsonl"), [
    line({ type: "summary", summary: "Fix the invoice export", leafUuid: "x" }),
    line({ type: "user", uuid: "u1", sessionId: S1, timestamp: "2026-10-10T08:00:00.000Z", gitBranch: "feature/export", cwd: project, message: { role: "user", content: "<ide_opened_file>The user opened a.js</ide_opened_file>Please fix the export, my key is " + leakKey } }),
    line({ type: "assistant", uuid: "a1", sessionId: S1, timestamp: "2026-10-10T08:00:05.000Z", message: { id: "m1", role: "assistant", content: [{ type: "thinking", thinking: "private chain of thought" }] } }),
    line({ type: "assistant", uuid: "a2", sessionId: S1, timestamp: "2026-10-10T08:00:06.000Z", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Reading the file." }] } }),
    line({ type: "assistant", uuid: "a3", sessionId: S1, timestamp: "2026-10-10T08:00:07.000Z", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "C:/repo/src/export.js" } }] } }),
    line({ type: "user", uuid: "u2", sessionId: S1, timestamp: "2026-10-10T08:00:08.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "const password = \"hunter2hunter2\";\nexport function run() {}" }] } }),
    line({ type: "assistant", uuid: "a4", sessionId: S1, timestamp: "2026-10-10T08:00:09.000Z", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "Done. Use `npm test`." }] } }),
    line({ type: "user", uuid: "u3", sessionId: S1, isMeta: true, timestamp: "2026-10-10T08:01:00.000Z", message: { role: "user", content: "<local-command-caveat>meta</local-command-caveat>" } }),
    line({ type: "user", uuid: "u4", sessionId: S1, timestamp: "2026-10-10T08:02:00.000Z", message: { role: "user", content: [{ type: "text", text: "<system-reminder>injected</system-reminder>" }, { type: "text", text: "ممنون، حالا تست‌ها را اجرا کن" }] } }),
    line({ type: "assistant", uuid: "a5", sessionId: S1, timestamp: "2026-10-10T08:02:10.000Z", message: { id: "m3", role: "assistant", content: [{ type: "text", text: "تست‌ها سبز شد." }] } })
  ].join("\n") + "\n");
  writeFileSync(join(dirB, S2 + ".jsonl"), [
    line({ type: "user", uuid: "v1", sessionId: S2, timestamp: "2026-10-12T09:00:00.000Z", message: { role: "user", content: "<system-reminder>ignore</system-reminder>   گزارش   ماهانه   را بساز    و بفرست" } }),
    line({ type: "assistant", uuid: "w1", sessionId: S2, timestamp: "2026-10-12T09:00:03.000Z", message: { id: "n1", role: "assistant", content: [{ type: "text", text: "باشه" }] } })
  ].join("\n") + "\n");
  // A sidechain-only transcript and an old-style agent file never reach the list.
  writeFileSync(join(dirA, S3 + ".jsonl"), line({ type: "user", isSidechain: true, sessionId: S3, timestamp: "2026-10-13T09:00:00.000Z", message: { role: "user", content: "sub-agent task" } }) + "\n");
  writeFileSync(join(dirA, "agent-abc123.jsonl"), line({ type: "user", isSidechain: true, message: { role: "user", content: "x" } }) + "\n");
  // Sub-agents of S1.
  mkdirSync(join(dirA, S1, "subagents"), { recursive: true });
  writeFileSync(join(dirA, S1, "subagents", "agent-a1.jsonl"), line({ type: "user", isSidechain: true, sessionId: S1, timestamp: "2026-10-10T08:00:30.000Z", message: { role: "user", content: "Review the export" } }) + "\n" + line({ type: "assistant", isSidechain: true, sessionId: S1, message: { id: "q", content: [{ type: "text", text: "Looks fine." }] } }) + "\n");
  writeFileSync(join(dirA, S1, "subagents", "agent-a1.meta.json"), JSON.stringify({ agentType: "reviewer", description: "Review the export" }));
  // A long session for paging.
  writeFileSync(join(dirA, S4 + ".jsonl"), Array.from({ length: 30 }, (_, i) => [
    line({ type: "user", uuid: "p" + i, sessionId: S4, timestamp: "2026-10-01T10:" + String(i).padStart(2, "0") + ":00.000Z", message: { role: "user", content: "question " + i } }),
    line({ type: "assistant", uuid: "r" + i, sessionId: S4, timestamp: "2026-10-01T10:" + String(i).padStart(2, "0") + ":30.000Z", message: { id: "rm" + i, role: "assistant", content: [{ type: "text", text: "answer " + i }] } })
  ].join("\n")).join("\n") + "\n");

  const dirs = transcriptDirectories(project, claudeHome);
  // On a case-insensitive file system both spellings are one folder.
  assert.equal(dirs.length, readdirSync(join(claudeHome, "projects")).length, "every casing of the project folder is read");
  const sum1 = summarizeTranscript(join(dirA, S1 + ".jsonl"));
  assert.equal(sum1.title, "Fix the invoice export");
  assert.equal(sum1.titleSource, "summary");
  assert.equal(sum1.branch, "feature/export");
  assert.equal(sum1.messages, 5, "two real user messages and three assistant replies");
  const sum2 = summarizeTranscript(join(dirB, S2 + ".jsonl"));
  assert.equal(sum2.title, "گزارش ماهانه را بساز و بفرست", "first real user message, injected tags stripped, trimmed");
  assert.equal(sum2.titleSource, "first-message");
  assert.equal(summarizeTranscript(join(dirA, S3 + ".jsonl")).sidechain, true);
  const items = parseTranscript(join(dirA, S1 + ".jsonl"));
  const serialized = JSON.stringify(items);
  assert.ok(!serialized.includes("private chain of thought"), "thinking is hidden");
  assert.ok(!serialized.includes("ide_opened_file") && !serialized.includes("injected"), "IDE and system tags are stripped");
  assert.ok(!serialized.includes(leakKey) && !serialized.includes("hunter2hunter2"), "secrets are redacted");
  assert.deepEqual(items.map((item) => item.kind), ["user", "assistant", "tool", "assistant", "user", "assistant"]);
  const chip = items.find((item) => item.kind === "tool");
  assert.equal(chip.name, "Read");
  assert.equal(chip.target, "C:/repo/src/export.js");
  assert.ok(chip.result && chip.result.error === false);
  const paged = windowItems(parseTranscript(join(dirA, S4 + ".jsonl")), { turns: 12 });
  assert.equal(paged.items.filter((item) => item.kind === "user").length, 12, "last 12 turns first");
  assert.equal(paged.hasMore, true);
  const earlier = windowItems(parseTranscript(join(dirA, S4 + ".jsonl")), { before: paged.start, turns: 12 });
  assert.equal(earlier.end, paged.start);
  assert.equal(earlier.items[0].text, "question 6");

  // ============================================ conversations over HTTP
  const fakeBin = sandbox("astack-fake-claude-");
  const fakeLog = join(fakeBin, "calls.jsonl");
  const fakeScript = join(fakeBin, "fake-claude.mjs");
  writeFileSync(fakeScript, [
    "#!/usr/bin/env node",
    "import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    "import { join } from 'node:path';",
    "import { createInterface } from 'node:readline';",
    "const argv = process.argv.slice(2);",
    "const after = (flag) => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1]; };",
    "const sessionId = after('--session-id') ?? after('--resume');",
    "const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
    "const sleep = (ms) => new Promise((done) => setTimeout(done, ms));",
    "const dir = join(process.env.FAKE_CLAUDE_HOME, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));",
    "const transcript = (entry) => { mkdirSync(dir, { recursive: true }); appendFileSync(join(dir, sessionId + '.jsonl'), JSON.stringify({ sessionId, timestamp: new Date().toISOString(), cwd: process.cwd(), gitBranch: 'main', ...entry }) + '\\n'); };",
    "async function askPermission(toolName, input) {",
    "  const config = JSON.parse(readFileSync(after('--mcp-config'), 'utf8'));",
    "  const [, server, tool] = after('--permission-prompt-tool').split('__');",
    "  const spec = config.mcpServers[server];",
    "  const child = spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'inherit'] });",
    "  const lines = createInterface({ input: child.stdout });",
    "  const waiting = new Map();",
    "  lines.on('line', (text) => { try { const message = JSON.parse(text); waiting.get(message.id)?.(message); } catch {} });",
    "  const rpc = (id, method, params) => new Promise((done) => { waiting.set(id, done); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n'); });",
    "  await rpc(1, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } });",
    "  const listed = await rpc(2, 'tools/list', {});",
    "  if (!listed.result.tools.some((entry) => entry.name === tool)) throw new Error('permission tool not listed');",
    "  const answer = await rpc(3, 'tools/call', { name: tool, arguments: { tool_name: toolName, input, tool_use_id: 'toolu_perm' } });",
    "  child.kill();",
    "  return JSON.parse(answer.result.content[0].text);",
    "}",
    "let input = '';",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', async () => {",
    "  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv, prompt: input, unattended: process.env.ASTACK_UNATTENDED ?? null, mcpTimeout: process.env.MCP_TOOL_TIMEOUT ?? null, cwd: process.cwd() }) + '\\n');",
    "  transcript({ type: 'user', uuid: 'u' + Date.now(), message: { role: 'user', content: input } });",
    "  out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model', permissionMode: after('--permission-mode') });",
    "  if (input.includes('[slow]')) await sleep(8000);",
    "  if (input.includes('[perm]')) {",
    "    const decision = await askPermission('Bash', { command: 'git push origin main' });",
    "    out({ type: 'assistant', message: { id: 'mt', content: [{ type: 'tool_use', id: 'toolu_perm', name: 'Bash', input: { command: 'git push origin main' } }] } });",
    "    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_perm', is_error: decision.behavior !== 'allow', content: decision.behavior === 'allow' ? 'pushed' : decision.message }] } });",
    "  }",
    "  out({ type: 'stream_event', event: { type: 'message_start' } });",
    "  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'سلام، ' } } });",
    "  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'the key is sk-ant-api03-" + "Q".repeat(40) + "' } } });",
    "  await sleep(200);",
    "  const text = 'سلام! the key is sk-ant-api03-" + "Q".repeat(40) + " (hidden).';",
    "  out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'thinking', thinking: 'secret thoughts' }, { type: 'text', text }] } });",
    "  transcript({ type: 'assistant', uuid: 'a' + Date.now(), message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text }] } });",
    "  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.0125, duration_ms: 420, num_turns: 1, result: 'ok', session_id: sessionId });",
    "});"
  ].join("\n"), "utf8");
  let fakeCommand = join(fakeBin, "fake-claude");
  if (process.platform === "win32") {
    writeFileSync(fakeCommand + ".cmd", "@\"%dp0%\\fake-claude.mjs\" %*\r\n", "utf8");
  } else {
    writeFileSync(fakeCommand, readFileSync(fakeScript, "utf8"), "utf8");
    chmodSync(fakeCommand, 0o755);
  }
  process.env.FAKE_CLAUDE_LOG = fakeLog;
  process.env.FAKE_CLAUDE_HOME = claudeHome;
  const calls = () => (existsSync(fakeLog) ? readFileSync(fakeLog, "utf8").split("\n").filter(Boolean).map((entry) => JSON.parse(entry)) : []);

  const chatWorkspace = workspace();
  const chatRuntime = createRuntime({ workspaceRoot: chatWorkspace });
  const notified = [];
  chatRuntime.gateway = { status: () => ({}), notify: async (message) => { notified.push(message); return { sent: 0 }; } };
  const chatConfig = { projects: [project, otherProject], command: fakeCommand, approval_poll_ms: 150 };
  // The automation policy decides whether the binary may run at all.
  const refusedChats = new ChatManager({ runtime: chatRuntime, config: chatConfig, home: claudeHome });
  assert.throws(() => refusedChats.send({ project: 0, prompt: "hi" }), /automation policy/);
  chatRuntime.automationPolicy.allowCommandPermanently("fake-claude");
  const chatServer = await start({ runtime: chatRuntime, chats: chatConfig, claudeHome });
  const cbase = chatServer.origin;
  const ctoken = readFileSync(join(chatWorkspace, ".astack", "console", "token"), "utf8").trim();
  const clogin = await call(cbase, "/api/login", { method: "POST", body: { token: ctoken }, origin: cbase });
  const ccookie = cookieOf(clogin);
  const ccsrf = clogin.json.csrf;
  const cpost = (path, body) => call(cbase, path, { method: "POST", body, cookie: ccookie, csrf: ccsrf, origin: cbase });
  const cget = (path) => call(cbase, path, { cookie: ccookie });

  const list = (await cget("/api/chats")).json.data;
  assert.deepEqual(list.items.map((item) => item.id), [S2, S1, S4], "newest first, sidechains and agent files excluded");
  assert.equal(list.items.find((item) => item.id === S1).subagents, 1);
  assert.equal(list.items.find((item) => item.id === S1).branch, "feature/export");
  assert.equal(list.projects.length, 2);
  assert.equal(list.projects[0].sessions, 3);
  assert.deepEqual((await cget("/api/chats?q=invoice")).json.data.items.map((item) => item.id), [S1], "search filters titles");
  assert.equal((await cget("/api/chats?size=5&page=1")).json.data.pages, 1);
  const opened = (await cget("/api/chats/" + S1)).json.data;
  assert.equal(opened.title, "Fix the invoice export");
  assert.ok(!JSON.stringify(opened).includes(leakKey), "no secret reaches the browser");
  assert.equal(opened.subagents[0].type, "reviewer");
  const agentView = (await cget("/api/chats/" + S1 + "?agent=agent-a1")).json.data;
  assert.equal(agentView.items[0].text, "Review the export", "sub-agent transcripts open read-only");
  assert.equal((await cget("/api/chats/..%2F..%2Fetc")).status, 404);
  assert.equal((await cget("/api/chats/" + S1 + "?agent=..%2F..%2Fx")).status, 400);
  assert.equal((await cget("/api/chats/not-a-uuid")).status, 404);

  const stream = await openStream(cbase, ccookie);
  const chatEvents = (sessionId) => stream.events.filter((event) => event.type === "chat" && event.data.sessionId === sessionId).map((event) => event.data);

  // Resume an existing session.
  const resumed = await cpost("/api/chats/" + S1 + "/messages", { prompt: "Run the tests please" });
  assert.equal(resumed.status, 200, resumed.text);
  await waitFor(() => chatEvents(S1).some((event) => event.type === "done"), { what: "resume turn" });
  const resumeCall = calls().at(-1);
  assert.equal(resumeCall.argv[resumeCall.argv.indexOf("--resume") + 1], S1, "--resume <session>");
  assert.ok(!resumeCall.argv.includes("Run the tests please"), "the prompt never reaches argv");
  assert.equal(resumeCall.prompt, "Run the tests please", "the prompt arrives on stdin");
  assert.equal(resumeCall.unattended, "1", "3.1.1: the Claude child runs unattended; the console server decides");
  assert.equal(resolve(resumeCall.cwd).toLowerCase(), resolve(project).toLowerCase(), "it runs in the session's project");
  for (const flag of ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--strict-mcp-config", "--mcp-config", "--permission-prompt-tool", PERMISSION_TOOL]) {
    assert.ok(resumeCall.argv.includes(flag), "argv has " + flag);
  }
  assert.equal(resumeCall.argv[resumeCall.argv.indexOf("--permission-mode") + 1], "default");
  for (const deny of MANDATORY_CLAUDE_DENIED) {
    assert.ok(resumeCall.argv.includes(deny), "mandatory deny " + deny);
  }
  for (const deny of CHAT_STATE_DENIES) {
    assert.ok(resumeCall.argv.includes(deny), "every turn denies " + deny);
  }
  for (const deny of ["Read(//**/.astack/console/**)", "Edit(//**/.astack/console/**)", "Read(//**/.astack/vault/**)", "Read(//**/.astack/gateway/**)", "Edit(//**/.astack/**)", "Bash(*astack* console*)", "Bash(*astack.mjs* console*)"]) {
    assert.ok(CHAT_STATE_DENIES.includes(deny), "state deny " + deny);
  }
  // Claude Code 2.1.x consults only Read(path)/Edit(path) for files: no ignored Write/Grep/Glob path rules here.
  assert.ok(!CHAT_STATE_DENIES.some((rule) => /^(Write|Grep|Glob|MultiEdit|NotebookEdit)\(/.test(rule)));
  assert.ok(!resumeCall.argv.some((argument) => /bypassPermissions|dangerously/.test(argument)));
  const allowedAt = resumeCall.argv.indexOf("--allowedTools");
  assert.deepEqual(resumeCall.argv.slice(allowedAt + 1, allowedAt + 4), ["Read", "Grep", "Glob"], "read-only tools are pre-allowed by default");
  assert.ok(Number(resumeCall.mcpTimeout) > 10 * 60 * 1000);
  const events1 = chatEvents(S1);
  const done1 = events1.find((event) => event.type === "done");
  assert.equal(done1.status, "completed");
  assert.equal(done1.costUsd, 0.0125);
  assert.equal(done1.durationMs, 420);
  assert.ok(events1.some((event) => event.type === "partial"), "partial text streams live");
  assert.ok(events1.some((event) => event.type === "assistant" && event.text.startsWith("سلام!")));
  assert.ok(!JSON.stringify(events1).includes("Q".repeat(40)), "streamed text is redacted");
  assert.ok(!JSON.stringify(events1).includes("secret thoughts"), "thinking never streams");
  assert.equal(readdirSync(join(chatWorkspace, ".astack", "console", "chats")).filter((name) => name.startsWith("mcp-")).length, 0, "the per-turn MCP config is removed");
  assert.ok(chatRuntime.audit.list({ action: "console-chat-turn" }).length >= 1);

  // A new session in the second project.
  const created = await cpost("/api/chats", { project: 1, prompt: "Start something new" });
  assert.equal(created.status, 200, created.text);
  const newId = created.json.data.sessionId;
  assert.match(newId, /^[0-9a-f-]{36}$/);
  await waitFor(() => chatEvents(newId).some((event) => event.type === "done"), { what: "new session turn" });
  const newCall = calls().at(-1);
  assert.equal(newCall.argv[newCall.argv.indexOf("--session-id") + 1], newId, "--session-id <new uuid>");
  assert.ok(!newCall.argv.includes("--resume"));
  assert.equal(resolve(newCall.cwd).toLowerCase(), resolve(otherProject).toLowerCase());
  const afterNew = (await cget("/api/chats?project=1")).json.data;
  assert.ok(afterNew.items.some((item) => item.id === newId), "the new session appears in the list");
  assert.ok(Math.abs(afterNew.today.usd - 0.025) < 1e-9, "today's total adds every turn");

  // One turn per session: a lock, and stop kills the process tree.
  const slow = await cpost("/api/chats/" + S2 + "/messages", { prompt: "[slow] take your time" });
  assert.equal(slow.status, 200, slow.text);
  const busy = await cpost("/api/chats/" + S2 + "/messages", { prompt: "again" });
  assert.equal(busy.status, 409, "a second message waits for the running turn");
  const active = (await cget("/api/chats/" + S2)).json.data.active;
  assert.equal(active.status, "running");
  await waitFor(() => chatEvents(S2).some((event) => event.type === "init"), { what: "slow turn init" });
  const stopped = await cpost("/api/chats/" + S2 + "/stop", {});
  assert.equal(stopped.status, 200);
  const doneSlow = await waitFor(() => chatEvents(S2).find((event) => event.type === "done"), { what: "stopped turn" });
  assert.equal(doneSlow.status, "stopped");
  assert.equal((await cpost("/api/chats/" + S2 + "/stop", {})).status, 404, "nothing left to stop");

  // Permission round trip: Claude Code -> astack MCP permission tool -> approval -> owner decides in the console.
  const permTurn = await cpost("/api/chats/" + S1 + "/messages", { prompt: "[perm] push it" });
  assert.equal(permTurn.status, 200, permTurn.text);
  const requested = await waitFor(() => chatRuntime.approvals.pending().find((record) => record.requestedBy === "console-chat:" + S1), { what: "permission approval", timeoutMs: 30000 });
  assert.equal(requested.action, "claude.tool");
  assert.equal(requested.tool, "Bash");
  assert.equal(requested.target, "git push origin main");
  await waitFor(() => chatEvents(S1).some((event) => event.type === "permission" && event.approvalId === requested.id), { what: "permission card event" });
  await waitFor(() => notified.some((message) => message.approvalId === requested.id), { what: "gateway notify" });
  const card = (await cget("/api/approvals/" + requested.id)).json.data;
  assert.equal(card.irreversible, true, "git push needs the typed code");
  const allow = await cpost("/api/approvals/" + requested.id + "/decide", { decision: "approve", confirm: card.confirmCode });
  assert.equal(allow.status, 200, allow.text);
  assert.equal(allow.json.data.decidedBy, "owner@console");
  await waitFor(() => chatEvents(S1).filter((event) => event.type === "done").length === 2, { what: "permission turn done", timeoutMs: 30000 });
  const allowedResult = chatEvents(S1).find((event) => event.type === "tool-result" && event.id === "toolu_perm");
  assert.equal(allowedResult.error, false);
  assert.equal(allowedResult.preview, "pushed", "an approval answers allow");
  const consumed = chatRuntime.approvals.get(requested.id);
  assert.equal(consumed.state, "consumed", "one approval authorizes one tool use");
  assert.equal(consumed.consumedBy, "console-chat:" + S1);

  const denyTurn = await cpost("/api/chats/" + S1 + "/messages", { prompt: "[perm] push again" });
  assert.equal(denyTurn.status, 200);
  const secondPerm = await waitFor(() => chatRuntime.approvals.pending().find((record) => record.requestedBy === "console-chat:" + S1), { what: "second permission", timeoutMs: 30000 });
  assert.equal((await cpost("/api/approvals/" + secondPerm.id + "/decide", { decision: "deny", note: "not today" })).status, 200);
  await waitFor(() => chatEvents(S1).filter((event) => event.type === "done").length === 3, { what: "deny turn done", timeoutMs: 30000 });
  const deniedResult = chatEvents(S1).filter((event) => event.type === "tool-result" && event.id === "toolu_perm").at(-1);
  assert.equal(deniedResult.error, true);
  assert.match(deniedResult.preview, /denied/i);
  assert.match(deniedResult.preview, /not today/);

  // Budget: today's spend is checked before a turn starts.
  chatServer.chats.config.daily_budget_usd = 0.05;
  assert.equal((await cpost("/api/chats/" + S1 + "/messages", { prompt: "one more" })).status, 402, "today's budget is spent");
  delete chatServer.chats.config.daily_budget_usd;
  stream.req.destroy();
  await chatServer.stop();

  // Arguments: no bypass, remote turns get no pre-allowed tools and extra denies.
  const manager = new ChatManager({ runtime: chatRuntime, config: { allowed_tools: "Read,Grep" }, home: claudeHome });
  const remoteArgs = manager.args({ sessionId: S1, isNew: false, mcpConfigPath: "x.json", channel: "remote" });
  assert.ok(!remoteArgs.includes("--allowedTools"), "no pre-allowed tools over the internet");
  for (const deny of ["Read(**/.env*)", "Read(**/.astack/**)", "Read(~/.ssh/**)", "Read(**/.claude/**)", "Read(//z/**)"]) {
    assert.ok(remoteArgs.includes(deny), "remote deny " + deny);
  }
  assert.ok(remoteChatDenies().length > 20);
  assert.throws(() => new ChatManager({ runtime: chatRuntime, config: { permission_mode: "bypassPermissions" }, home: claudeHome }).args({ sessionId: S1, isNew: false, mcpConfigPath: "x" }), /refused/);
  assert.throws(() => new ChatManager({ runtime: chatRuntime, config: { permission_mode: "auto" }, home: claudeHome }).args({ sessionId: S1, isNew: false, mcpConfigPath: "x" }), /refused/);

  // ======================================= MCP permission tool: timeout, listing
  const mcpWorkspace = workspace();
  const approvals = new ApprovalEngine(mcpWorkspace);
  const handler = createMcpHandler({ version: "test", permission: { session: "S-timeout", workspaceRoot: mcpWorkspace, timeoutMs: 600, pollMs: 50 }, approvals });
  const listed = await handler({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(listed.result.tools.length, mcpTools.length + 1, "the permission tool is listed for console chats");
  const plainHandler = createMcpHandler({ version: "test", permission: null });
  assert.equal((await plainHandler({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools.length, mcpTools.length, "and only for them");
  const timedOut = await handler({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "permission_prompt", arguments: { tool_name: "Write", input: { file_path: "a.txt", content: "x" }, tool_use_id: "t1" } } });
  const timedOutResult = JSON.parse(timedOut.result.content[0].text);
  assert.equal(timedOutResult.behavior, "deny", "no answer in time is a deny");
  assert.match(timedOutResult.message, /expired|timed out/);
  const expiredRecord = approvals.list({ limit: 5 })[0];
  assert.equal(expiredRecord.requestedBy, "console-chat:S-timeout");
  assert.equal(expiredRecord.state, "expired");
  // Allow keeps the original input; deny carries the note.
  const fast = new ApprovalEngine(mcpWorkspace);
  const allowRun = requestToolPermission({ approvals: fast, toolName: "Edit", input: { file_path: "b.txt", old_string: "a", new_string: "b" }, session: "S-unit", timeoutMs: 5000, pollMs: 20 });
  const pendingUnit = await waitFor(() => fast.pending().find((record) => record.requestedBy === "console-chat:S-unit"), { what: "unit approval" });
  fast.approve(pendingUnit.id, { by: "owner@console" });
  const allowed = await allowRun;
  assert.deepEqual(allowed.result, { behavior: "allow", updatedInput: { file_path: "b.txt", old_string: "a", new_string: "b" } });
  // The MCP server process itself can never decide.
  const prior = process.env.ASTACK_UNATTENDED;
  process.env.ASTACK_UNATTENDED = "1";
  const forged = fast.request({ action: "claude.tool", summary: "x", requestedBy: "console-chat:S-unit" });
  assert.throws(() => fast.approve(forged.id, { by: "console-chat:S-unit" }), /unattended/i);
  if (prior === undefined) delete process.env.ASTACK_UNATTENDED;
  else process.env.ASTACK_UNATTENDED = prior;

  console.log("AStack console conversations and sign-in verification passed");
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
