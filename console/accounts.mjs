import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join, resolve } from "node:path";
import { isUnattended } from "../trust-engine/approvals.mjs";
import { killProcessTree, resolveCommand, startProcess } from "../runner-engine/engines.mjs";

/**
 * Claude accounts for the Aramis console.
 *
 * Claude Code keeps its login in two places: `<claudeHome>/.credentials.json`
 * (the `claudeAiOauth` object: access and refresh token) and the
 * `oauthAccount` object inside `.claude.json` (email, organisation). A
 * "profile" is a saved copy of both. Switching writes a profile back as the live
 * login, so the next `claude -p --resume <id>` turn runs on that account while
 * the transcripts (`<claudeHome>/projects`, account independent) and all AStack
 * memory stay exactly where they are.
 *
 * Safety rules kept by this file:
 * - tokens never leave this module (no API answer, audit record or log line);
 * - `.claude.json` is changed surgically: only the text span of the
 *   `"oauthAccount"` value is replaced, every other byte stays identical;
 * - every file is written atomically (temp file + rename), one rolling backup
 *   of the live login is kept before each switch, and a failed read-back
 *   restores it;
 * - the profile folder is owner-only (icacls on Windows, 0700/0600 elsewhere).
 */

export const KEYCHAIN_SERVICE = "Claude Code-credentials";
export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const ID_PATTERN = /^[a-z0-9][a-z0-9._@+-]{0,127}$/;
const PROCESS_CACHE_MS = 10000;
const USAGE_TIMEOUT_MS = 6000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * `code` is a stable key (console.accounts.errors.<code> in the locale files) so
 * the CLI and the UI can show the error in the owner's language; `message`
 * stays English as a fallback.
 */
export class AccountError extends Error {
  constructor(status, message, details = null, code = null) {
    super(message);
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

/** Where the console records its running chat turns, so a terminal `astack account switch` can see them. */
export function turnsFilePath(runtime) {
  return runtime?.workspaceRoot ? join(runtime.workspaceRoot, ".astack", "console", "chats", "turns.json") : null;
}

export function writeTurnsFile(path, turns) {
  if (!path) {
    return;
  }
  writeAtomic(path, JSON.stringify({ serverPid: process.pid, updatedAt: new Date().toISOString(), turns }) + "\n", 0o600);
}

function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

const TURNS_MAX_AGE_MS = 6 * 3600 * 1000;

/** Running console chat turns recorded by a live console process; a stale file of a dead console counts as none. */
export function countLiveTurns(path) {
  try {
    if (!path || !existsSync(path)) {
      return 0;
    }
    const data = JSON.parse(readFileSync(path, "utf8"));
    const age = Date.now() - new Date(data.updatedAt).getTime();
    if (!data.serverPid || !pidAlive(data.serverPid) || !(age < TURNS_MAX_AGE_MS)) {
      return 0;
    }
    return Array.isArray(data.turns) ? data.turns.length : 0;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------- JSON text surgery

function skipString(text, start) {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      index += 2;
    } else if (char === '"') {
      return index + 1;
    } else {
      index += 1;
    }
  }
  return text.length;
}

function skipValue(text, start) {
  const first = text[start];
  if (first === '"') {
    return skipString(text, start);
  }
  if (first === "{" || first === "[") {
    let depth = 0;
    let index = start;
    while (index < text.length) {
      const char = text[index];
      if (char === '"') {
        index = skipString(text, index);
        continue;
      }
      if (char === "{" || char === "[") {
        depth += 1;
      } else if (char === "}" || char === "]") {
        depth -= 1;
        if (depth === 0) {
          return index + 1;
        }
      }
      index += 1;
    }
    return text.length;
  }
  let index = start;
  while (index < text.length && !/[\s,}\]]/.test(text[index])) {
    index += 1;
  }
  return index;
}

/**
 * Where the value of a top-level key sits in a JSON object text:
 * `{ start, end }` (end exclusive) or null. String-aware, no parsing of the
 * rest of the document.
 */
export function findTopLevelSpan(text, key) {
  const wanted = JSON.stringify(key);
  let index = text.indexOf("{");
  if (index < 0) {
    return null;
  }
  let depth = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const end = skipString(text, index);
      if (depth === 1) {
        let cursor = end;
        while (cursor < text.length && /\s/.test(text[cursor])) {
          cursor += 1;
        }
        if (text[cursor] === ":" && text.slice(index, end) === wanted) {
          cursor += 1;
          while (cursor < text.length && /\s/.test(text[cursor])) {
            cursor += 1;
          }
          return { start: cursor, end: skipValue(text, cursor) };
        }
      }
      index = end;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth <= 0) {
        return null;
      }
    }
    index += 1;
  }
  return null;
}

/** Replaces (or, when missing, appends) one top-level value; the rest of the text is untouched. */
export function replaceTopLevelValue(text, key, rawValue) {
  const span = findTopLevelSpan(text, key);
  if (span) {
    return text.slice(0, span.start) + rawValue + text.slice(span.end);
  }
  const close = text.lastIndexOf("}");
  if (close < 0) {
    throw new AccountError(500, "the Claude settings file is not a JSON object", null, "not-object");
  }
  let before = close;
  while (before > 0 && /\s/.test(text[before - 1])) {
    before -= 1;
  }
  const empty = text[before - 1] === "{";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = /\{\r?\n([ \t]+)"/.exec(text)?.[1] ?? "";
  const entry = (indent ? eol + indent : "") + JSON.stringify(key) + (indent ? ": " : ":") + rawValue;
  return text.slice(0, before) + (empty ? "" : ",") + entry + text.slice(before);
}

function writeAtomic(path, data, mode = 0o600) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  const temp = path + "." + process.pid + "." + randomBytes(4).toString("hex") + ".tmp";
  writeFileSync(temp, data, { mode });
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      renameSync(temp, path);
      return;
    } catch (error) {
      lastError = error;
      // Windows can hold the target for a moment (antivirus, a reader): wait and retry.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1));
    }
  }
  rmSync(temp, { force: true });
  throw lastError;
}

function safeId(email) {
  return String(email ?? "").trim().toLowerCase().replace(/[^a-z0-9._@+-]/g, "_").replace(/^[._-]+/, "");
}

function cleanLabel(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 60);
}

// ------------------------------------------------------------- running claude processes

const WINDOWS_PROCESS_SCRIPT = String.raw`Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and (($_.Name -ieq 'claude.exe' -and $_.CommandLine -notmatch '--type=|WindowsApps') -or ($_.Name -ieq 'node.exe' -and $_.CommandLine -match 'claude-code|anthropic-ai[\\/]claude')) } | Select-Object ProcessId,Name | ConvertTo-Json -Compress`;

function run(file, args, timeout = 8000) {
  return new Promise((resolvePromise) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolvePromise(error ? null : String(stdout)));
  });
}

/** Running Claude Code processes: `[{ pid, name }]`; an empty list when they cannot be listed. */
export async function listClaudeProcesses(platform = process.platform) {
  try {
    if (platform === "win32") {
      const output = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_SCRIPT]);
      if (!output || !output.trim()) {
        return [];
      }
      const parsed = JSON.parse(output);
      return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({ pid: Number(entry.ProcessId), name: String(entry.Name) })).filter((entry) => entry.pid);
    }
    const output = await run("ps", ["-eo", "pid=,comm=,args="]);
    if (!output) {
      return [];
    }
    const found = [];
    for (const line of output.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!match || Number(match[1]) === process.pid) {
        continue;
      }
      const name = basename(match[2]);
      if (/--type=|Claude Helper|Claude.app/.test(match[3])) {
        continue; // the Claude desktop app (Electron), not Claude Code
      }
      if (name === "claude" || /(^|\/)claude(\s|$)/.test(match[3]) || /claude-code|@anthropic-ai\/claude/.test(match[3])) {
        found.push({ pid: Number(match[1]), name });
      }
    }
    return found;
  } catch {
    return [];
  }
}

// ------------------------------------------------------------- the accounts service

export class ClaudeAccounts {
  /**
   * @param claudeHome   Claude's config folder (CLAUDE_CONFIG_DIR or ~/.claude)
   * @param claudeJson   path of .claude.json (default: inside the home when it is a custom folder or CLAUDE_CONFIG_DIR is set, else ~/.claude.json)
   * @param directory    where profiles are saved (default $ASTACK_ACCOUNTS_DIR or ~/.astack/accounts)
   * @param fetch        fetch implementation for the usage call
   * @param listProcesses async () => [{ pid, name }]
   * @param chatTurns    () => number of console chat turns running now
   */
  constructor({
    runtime = null,
    claudeHome = null,
    claudeJson = null,
    directory = null,
    fetch: fetchImplementation = null,
    listProcesses = null,
    chatTurns = () => 0,
    clock = null,
    env = process.env,
    platform = process.platform,
    security = null,
    harden = true,
    usageTtlMs = 30000,
    startLogin = null,
    loginTimeoutMs = LOGIN_TIMEOUT_MS
  } = {}) {
    this.runtime = runtime;
    this.env = env;
    this.platform = platform;
    // A home counts as custom only when it differs from Claude Code's own default (~/.claude): the console
    // always passes its (usually default) home, and that must still find ~/.claude.json beside the folder.
    const normalize = (path) => (platform === "win32" ? resolve(path).toLowerCase() : resolve(path));
    this.explicitHome = Boolean(claudeHome) && normalize(claudeHome) !== normalize(join(homedir(), ".claude"));
    this.home = claudeHome ? resolve(claudeHome) : env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(homedir(), ".claude");
    this.claudeJsonOverride = claudeJson ? resolve(claudeJson) : null;
    this.directory = resolve(directory ?? env.ASTACK_ACCOUNTS_DIR ?? join(homedir(), ".astack", "accounts"));
    this.fetchImplementation = fetchImplementation ?? ((...args) => globalThis.fetch(...args));
    this.listProcessesImplementation = listProcesses ?? (() => listClaudeProcesses(platform));
    this.chatTurns = chatTurns;
    this.clock = clock ?? (() => new Date());
    this.security = security ?? ((args, input) => execFileSync("security", args, { input, encoding: "utf8", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"], timeout: 8000 }));
    this.harden = harden;
    this.usageTtlMs = usageTtlMs;
    // (args, env) => child process; injected by tests so no real sign-in ever starts.
    this.startLoginProcess = startLogin ?? ((args, env) => {
      const resolved = resolveCommand("claude", { env: this.env, platform: this.platform });
      if (!resolved) {
        throw new AccountError(409, "Claude Code was not found on this computer", null, "no-claude");
      }
      return startProcess(resolved, args, { env, cwd: homedir() });
    });
    this.loginTimeoutMs = loginTimeoutMs;
    this.login = null;
    this.processCache = null;
    this.usageCache = new Map();
    this.emailCache = null;
  }

  // ----------------------------------------------------------- paths

  get credentialsPath() {
    return join(this.home, ".credentials.json");
  }

  get claudeJsonPath() {
    if (this.claudeJsonOverride) {
      return this.claudeJsonOverride;
    }
    const inside = join(this.home, ".claude.json");
    // Claude Code keeps ~/.claude.json beside the folder, but inside CLAUDE_CONFIG_DIR when that is set.
    if (this.explicitHome || this.env.CLAUDE_CONFIG_DIR) {
      return inside;
    }
    const beside = join(homedir(), ".claude.json");
    return existsSync(beside) || !existsSync(inside) ? beside : inside;
  }

  get backupPath() {
    return join(this.directory, ".backups", "live-login.json");
  }

  profilePath(id) {
    return join(this.directory, id + ".json");
  }

  ensureDirectory() {
    if (existsSync(this.directory)) {
      return;
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (this.platform === "win32" && this.harden) {
      try {
        const user = userInfo().username;
        execFileSync("icacls", [this.directory, "/inheritance:r", "/grant:r", user + ":(OI)(CI)F"], { stdio: "ignore", windowsHide: true, timeout: 8000 });
      } catch {
        // Best effort: the folder stays inside the user's own profile anyway.
      }
    }
  }

  audit(action, target, result, riskLevel = "L3") {
    try {
      this.runtime?.audit?.record?.({ actor: "owner@console", action, target, riskLevel, result });
    } catch {
      // Auditing must never block a sign-in change.
    }
  }

  // ----------------------------------------------------------- the live login

  useKeychain() {
    return this.platform === "darwin" && !existsSync(this.credentialsPath);
  }

  readCredentialsObject() {
    try {
      if (this.useKeychain()) {
        const text = this.security(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
        return { source: "keychain", object: JSON.parse(String(text).trim()) };
      }
      if (existsSync(this.credentialsPath)) {
        return { source: "file", object: JSON.parse(readFileSync(this.credentialsPath, "utf8").replace(/^﻿/, "")) };
      }
    } catch {
      // unreadable: treated as signed out
    }
    return { source: this.useKeychain() ? "keychain" : "file", object: null };
  }

  storeCredentialsObject(object, source) {
    const text = JSON.stringify(object);
    if (source === "keychain") {
      // The secret goes to `security -i` on stdin (hex encoded), never into the process arguments.
      const quote = (value) => '"' + String(value).replace(/(["\\])/g, "\\$1") + '"';
      const hex = Buffer.from(text, "utf8").toString("hex");
      this.security(["-i"], "add-generic-password -U -s " + quote(KEYCHAIN_SERVICE) + " -a " + quote(userInfo().username) + " -X " + hex + "\n");
      // `security -i` can exit 0 when its inner command failed: read the entry back.
      const back = this.readCredentialsObject().object;
      if (back?.claudeAiOauth?.accessToken !== object?.claudeAiOauth?.accessToken) {
        throw new AccountError(500, "the keychain entry could not be written", null, "keychain-failed");
      }
      return;
    }
    writeAtomic(this.credentialsPath, text, 0o600);
  }

  readClaudeJson() {
    const path = this.claudeJsonPath;
    if (!existsSync(path)) {
      return null;
    }
    return readFileSync(path, "utf8");
  }

  /** The live login: `{ source, object, oauth, token, raw, account, email, plan }`. Never leaves this module. */
  readLive() {
    const { source, object } = this.readCredentialsObject();
    const oauth = object?.claudeAiOauth && typeof object.claudeAiOauth === "object" ? object.claudeAiOauth : null;
    const text = this.readClaudeJson();
    const span = text ? findTopLevelSpan(text, "oauthAccount") : null;
    const raw = span && text[span.start] === "{" ? text.slice(span.start, span.end) : null;
    let account = null;
    try {
      account = raw ? JSON.parse(raw) : null;
    } catch {
      account = null;
    }
    return {
      source,
      object,
      oauth,
      token: typeof oauth?.accessToken === "string" ? oauth.accessToken : null,
      raw,
      account,
      email: typeof account?.emailAddress === "string" ? account.emailAddress : null,
      plan: typeof oauth?.subscriptionType === "string" ? oauth.subscriptionType : null,
      text
    };
  }

  /** Email of the login a Claude Code turn would run on now, or null. Cheap: cached by file time and size. */
  activeEmail() {
    try {
      const path = this.claudeJsonPath;
      if (!existsSync(path)) {
        return null;
      }
      const stat = statSync(path);
      const key = stat.mtimeMs + ":" + stat.size;
      if (this.emailCache?.key === key) {
        return this.emailCache.email;
      }
      const text = readFileSync(path, "utf8");
      const span = findTopLevelSpan(text, "oauthAccount");
      const email = span && text[span.start] === "{" ? JSON.parse(text.slice(span.start, span.end)).emailAddress ?? null : null;
      this.emailCache = { key, email: typeof email === "string" ? email : null };
      return this.emailCache.email;
    } catch {
      return null;
    }
  }

  // ----------------------------------------------------------- profiles

  assertId(id) {
    const value = String(id ?? "");
    if (!ID_PATTERN.test(value)) {
      throw new AccountError(404, "unknown account", null, "unknown");
    }
    return value;
  }

  loadProfile(id) {
    const value = this.assertId(id);
    const path = this.profilePath(value);
    if (!existsSync(path)) {
      throw new AccountError(404, "unknown account", null, "unknown");
    }
    try {
      return { id: value, ...JSON.parse(readFileSync(path, "utf8")) };
    } catch {
      throw new AccountError(500, "the saved account file is damaged", null, "damaged");
    }
  }

  profiles() {
    if (!existsSync(this.directory)) {
      return [];
    }
    const found = [];
    for (const name of readdirSync(this.directory)) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const id = name.slice(0, -5);
      if (!ID_PATTERN.test(id)) {
        continue;
      }
      try {
        found.push({ id, ...JSON.parse(readFileSync(join(this.directory, name), "utf8")) });
      } catch {
        // a damaged profile is skipped, never fatal
      }
    }
    return found.sort((a, b) => String(a.email).localeCompare(String(b.email)));
  }

  writeProfile(profile) {
    this.ensureDirectory();
    const { id, ...rest } = profile;
    writeAtomic(this.profilePath(id), JSON.stringify(rest, null, 2) + "\n", 0o600);
  }

  /**
   * The saved profile that is the live login and how it was recognised:
   * `token` (same access token), `refresh` (same refresh token) or `email` only.
   * An email-only match with different tokens cannot be told apart, offline, from
   * a login that another process wrote: callers must not destroy the profile's own login then.
   */
  matchInfo(live, profiles = this.profiles()) {
    if (live.token) {
      const byToken = profiles.find((profile) => profile.credentials?.accessToken === live.token);
      if (byToken) {
        return { profile: byToken, by: "token" };
      }
    }
    if (live.oauth?.refreshToken) {
      const byRefresh = profiles.find((profile) => profile.credentials?.refreshToken === live.oauth.refreshToken);
      if (byRefresh) {
        return { profile: byRefresh, by: "refresh" };
      }
    }
    if (live.email) {
      const byEmail = profiles.find((profile) => String(profile.email).toLowerCase() === live.email.toLowerCase());
      if (byEmail) {
        return { profile: byEmail, by: "email" };
      }
    }
    return { profile: null, by: null };
  }

  matchProfile(live, profiles = this.profiles()) {
    return this.matchInfo(live, profiles).profile;
  }

  /** When new credentials replace different ones, the old ones stay in the profile (one generation) so a wrong match never loses a login. */
  historyFor(existing, credentials) {
    const previous = existing?.credentials;
    if (previous?.refreshToken && previous.refreshToken !== credentials?.refreshToken) {
      return { previousCredentials: previous, previousSavedAt: existing.savedAt ?? null };
    }
    return {};
  }

  assertAttended() {
    // Chat and runner children run unattended: they may never change the owner's Claude login.
    if (isUnattended(this.env)) {
      throw new AccountError(403, "Claude accounts cannot be changed from an unattended process", null, "unattended");
    }
  }

  publicProfile(profile, activeId) {
    return {
      id: profile.id,
      email: profile.email,
      label: profile.label ?? "",
      savedAt: profile.savedAt ?? null,
      plan: typeof profile.credentials?.subscriptionType === "string" ? profile.credentials.subscriptionType : null,
      active: profile.id === activeId
    };
  }

  activeInfo(live = this.readLive(), profiles = this.profiles()) {
    const match = live.token || live.email ? this.matchProfile(live, profiles) : null;
    return { email: live.email, plan: live.plan, profileId: match?.id ?? null };
  }

  // ----------------------------------------------------------- processes

  async running({ fresh = false } = {}) {
    const now = Date.now();
    if (!fresh && this.processCache && now - this.processCache.at < PROCESS_CACHE_MS) {
      return this.processCache.list;
    }
    let list = [];
    try {
      list = (await this.listProcessesImplementation()) ?? [];
    } catch {
      list = [];
    }
    list = list.map((entry) => ({ pid: Number(entry.pid), name: String(entry.name ?? "claude") }));
    this.processCache = { at: now, list };
    return list;
  }

  // ----------------------------------------------------------- API

  async list() {
    const live = this.readLive();
    const profiles = this.profiles();
    const active = this.activeInfo(live, profiles);
    return {
      active,
      accounts: profiles.map((profile) => this.publicProfile(profile, active.profileId)),
      running: await this.running(),
      chatTurnsRunning: Number(this.chatTurns()) || 0,
      platform: this.platform
    };
  }

  /** Saves (or refreshes) the current login as a profile. */
  save({ label = null } = {}) {
    this.assertAttended();
    const live = this.readLive();
    if (!live.token || !live.oauth) {
      throw new AccountError(409, "no Claude login found: sign in with Claude Code first", null, "no-login");
    }
    if (!live.email) {
      throw new AccountError(409, "the Claude login has no account email: sign in with Claude Code first", null, "no-email");
    }
    const profiles = this.profiles();
    const existing = this.matchProfile(live, profiles);
    const id = existing?.id ?? safeId(live.email);
    if (!ID_PATTERN.test(id)) {
      throw new AccountError(409, "the account email cannot be used as a name", null, "bad-email");
    }
    const history = this.historyFor(existing, live.oauth);
    const profile = {
      id,
      email: live.email,
      label: label !== null && label !== undefined && String(label).trim() ? cleanLabel(label) : existing?.label ?? "",
      savedAt: this.clock().toISOString(),
      credentials: live.oauth,
      oauthAccountRaw: live.raw,
      ...(history.previousCredentials ? history : existing?.previousCredentials ? { previousCredentials: existing.previousCredentials, previousSavedAt: existing.previousSavedAt ?? null } : {})
    };
    this.writeProfile(profile);
    this.audit("claude-account-save", id, existing ? "updated" : "saved");
    return this.publicProfile(profile, id);
  }

  label(id, label) {
    this.assertAttended();
    const profile = this.loadProfile(id);
    profile.label = cleanLabel(label);
    this.writeProfile(profile);
    this.audit("claude-account-label", profile.id, "label changed", "L1");
    return this.publicProfile(profile, this.activeInfo().profileId);
  }

  remove(id) {
    this.assertAttended();
    const profile = this.loadProfile(id);
    rmSync(this.profilePath(profile.id), { force: true });
    this.usageCache.delete(profile.id);
    const backupCleared = this.clearBackupFor(profile);
    this.audit("claude-account-remove", profile.id, "local profile removed (no sign-out)" + (backupCleared ? ", rolling backup of this login cleared" : ""));
    return { removed: true, backupCleared };
  }

  /**
   * The rolling backup of the live login must not keep a removed account on the
   * machine. When it holds this account's login, that login is scrubbed (other
   * keys of the credentials file, such as MCP logins, stay as a recovery copy).
   * A backup that belongs to another account is left alone.
   */
  clearBackupFor(profile) {
    try {
      if (!existsSync(this.backupPath)) {
        return false;
      }
      const backup = JSON.parse(readFileSync(this.backupPath, "utf8"));
      const oauth = backup?.credentialsFile?.claudeAiOauth;
      const tokens = new Set([profile.credentials?.accessToken, profile.credentials?.refreshToken, profile.previousCredentials?.accessToken, profile.previousCredentials?.refreshToken].filter(Boolean));
      let backupEmail = null;
      try {
        backupEmail = backup.oauthAccountRaw ? JSON.parse(backup.oauthAccountRaw).emailAddress : null;
      } catch {
        backupEmail = null;
      }
      const matches = (oauth?.accessToken && tokens.has(oauth.accessToken))
        || (oauth?.refreshToken && tokens.has(oauth.refreshToken))
        || (typeof backupEmail === "string" && backupEmail.toLowerCase() === String(profile.email).toLowerCase());
      if (!matches) {
        return false;
      }
      const { claudeAiOauth, ...others } = backup.credentialsFile ?? {};
      if (Object.keys(others).length) {
        writeAtomic(this.backupPath, JSON.stringify({ ...backup, credentialsFile: others, oauthAccountRaw: null }) + "\n", 0o600);
      } else {
        rmSync(this.backupPath, { force: true });
      }
      return true;
    } catch {
      return false;
    }
  }

  /** .claude.json as text that parses; a file caught empty or half written is re-read a few times. */
  readStableClaudeJson() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const text = this.readClaudeJson();
      if (text !== null && text.trim()) {
        try {
          JSON.parse(text.replace(/^\uFEFF/, ""));
          return text;
        } catch {
          // being written: wait and read again
        }
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    throw new AccountError(409, "Claude's settings file is empty or being written: try again in a moment", null, "claude-json-unreadable");
  }

  /**
   * Makes a saved account the live login. Order: sync-back, backup, credentials,
   * `oauthAccount`, read-back verification (restore on failure).
   */
  async switch(id, { force = false } = {}) {
    this.assertAttended();
    let target = this.loadProfile(id);
    const processes = await this.running({ fresh: true });
    const warnings = [];
    const turns = Number(this.chatTurns()) || 0;
    if (turns > 0) {
      if (!force) {
        throw new AccountError(409, "a conversation turn is running: wait for it or stop it, then switch", { chatTurnsRunning: turns }, "turn-running");
      }
      warnings.push("chat-turns-running");
    }
    const live = this.readLive();
    const profiles = this.profiles();
    const { profile: current, by } = live.token || live.email ? this.matchInfo(live, profiles) : { profile: null, by: null };
    const sameEmail = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
    // 1. sync-back: a refreshed token in the live login must not be lost. The profile's own previous
    // login is kept (one generation), and an email-only match is reported as unverified: offline, a
    // refreshed token of the same account looks exactly like another process's login.
    if (current && live.oauth && (current.credentials?.accessToken !== live.token || current.credentials?.refreshToken !== live.oauth.refreshToken)) {
      const updated = {
        ...current,
        savedAt: this.clock().toISOString(),
        credentials: live.oauth,
        // The live oauthAccount is taken over only when it is this account's own.
        oauthAccountRaw: live.raw && sameEmail(live.email, current.email) ? live.raw : current.oauthAccountRaw,
        ...this.historyFor(current, live.oauth)
      };
      this.writeProfile(updated);
      if (by === "email") {
        warnings.push("login-unverified");
      }
      if (current.id === target.id) {
        target = updated;
      }
    } else if (!current && live.token) {
      warnings.push("unsaved-previous-login");
    }
    // The target counts as active only when tokens AND the displayed account agree (a half-applied switch is repaired).
    const accountMatches = !target.oauthAccountRaw || live.text === null || sameEmail(live.email, target.email);
    if (current && current.id === target.id && live.token) {
      if (accountMatches) {
        if (processes.length) {
          warnings.push("running-sessions");
        }
        return { active: this.activeInfo(), warnings: [...warnings, "already-active"] };
      }
      warnings.push("login-repaired");
    }
    if (!target.credentials?.accessToken) {
      throw new AccountError(500, "the saved account has no login", null, "profile-no-login");
    }
    if (target.oauthAccountRaw && live.text === null) {
      // Tokens without the matching oauthAccount would leave a half-switched login.
      throw new AccountError(409, "Claude's settings file (.claude.json) was not found: nothing was changed", null, "no-claude-json");
    }
    // 2. one rolling backup of the live login.
    if (live.object || live.raw) {
      writeAtomic(this.backupPath, JSON.stringify({ savedAt: this.clock().toISOString(), source: live.source, credentialsFile: live.object, oauthAccountRaw: live.raw }) + "\n", 0o600);
    }
    // 3. credentials (other keys of the file, such as MCP logins, stay).
    const merged = { ...(live.object ?? {}), claudeAiOauth: target.credentials };
    let credentialsTouched = false;
    let wroteJson = null;
    try {
      credentialsTouched = true;
      this.storeCredentialsObject(merged, live.source);
      // 4. only the oauthAccount span of .claude.json, applied to the text as it is NOW (a concurrent
      // writer's change is kept; an empty or half-written file is never written back).
      if (target.oauthAccountRaw) {
        const fresh = this.readStableClaudeJson();
        const next = replaceTopLevelValue(fresh, "oauthAccount", target.oauthAccountRaw);
        JSON.parse(next.replace(/^\uFEFF/, ""));
        let mode = 0o600;
        try {
          mode = statSync(this.claudeJsonPath).mode & 0o777;
        } catch {
          // keep the default
        }
        writeAtomic(this.claudeJsonPath, next, mode);
        wroteJson = { written: next, fresh, mode };
      }
      // 5. verify by reading back (the whole file must still parse).
      const after = this.readLive();
      let parses = true;
      if (target.oauthAccountRaw) {
        try {
          JSON.parse(String(after.text).replace(/^\uFEFF/, ""));
        } catch {
          parses = false;
        }
      }
      if (after.token !== target.credentials.accessToken || (target.oauthAccountRaw && (!parses || !sameEmail(after.email, target.email)))) {
        throw new AccountError(500, "the switch could not be verified", null, "verify-failed");
      }
    } catch (error) {
      this.restore(live, { credentialsTouched, wroteJson });
      this.audit("claude-account-switch", target.id, "failed and restored: " + String(error.message).slice(0, 120));
      throw error instanceof AccountError ? error : new AccountError(500, "the switch failed and the previous login was restored", null, "switch-failed");
    }
    this.emailCache = null;
    if (processes.length) {
      warnings.push("running-sessions");
    }
    this.audit("claude-account-switch", target.id, "switched" + (force ? " (forced)" : "") + (processes.length ? ", " + processes.length + " claude process(es) kept the old login" : ""));
    return { active: this.activeInfo(), warnings };
  }

  /** Undo what this switch wrote. .claude.json is touched only if this call wrote it and nobody changed it since. */
  restore(live, { credentialsTouched = false, wroteJson = null } = {}) {
    try {
      if (credentialsTouched) {
        if (live.object) {
          this.storeCredentialsObject(live.object, live.source);
        } else if (live.source === "file") {
          rmSync(this.credentialsPath, { force: true });
        }
      }
    } catch {
      // The rolling backup under the accounts folder still holds the previous login.
    }
    try {
      if (wroteJson) {
        let currentText = null;
        try {
          currentText = readFileSync(this.claudeJsonPath, "utf8");
        } catch {
          currentText = null;
        }
        if (currentText === wroteJson.written) {
          writeAtomic(this.claudeJsonPath, wroteJson.fresh, wroteJson.mode);
        }
      }
    } catch {
      // see above
    }
  }

  /** Five-hour and seven-day usage of an account; `{ error, code }` on any failure. Never throws, never returns a token. */
  // ---------------------------------------------------- add another account

  /**
   * Adds a second (third, ...) Claude account without touching the live login.
   * `claude auth login` runs with its own throw-away CLAUDE_CONFIG_DIR, so the
   * account in use keeps working; when the sign-in finishes, the new login is
   * saved as a profile and the throw-away folder is deleted. The caller shows
   * the sign-in link and polls loginStatus().
   */
  startAddLogin({ email = null, label = null } = {}) {
    this.assertAttended();
    if (this.login && this.login.state === "running") {
      throw new AccountError(409, "a sign-in is already waiting", null, "login-running");
    }
    const cleanEmail = email ? String(email).trim().slice(0, 254) : "";
    if (cleanEmail && !/^[^\s@<>"'`;&|]+@[^\s@<>"'`;&|]+\.[^\s@<>"'`;&|]+$/.test(cleanEmail)) {
      throw new AccountError(400, "this is not an email address", null, "bad-email");
    }
    this.ensureDirectory();
    const folder = join(this.directory, ".login-" + randomBytes(6).toString("hex"));
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const args = ["auth", "login", "--claudeai", ...(cleanEmail ? ["--email", cleanEmail] : [])];
    const env = { ...this.env, CLAUDE_CONFIG_DIR: folder };
    let child;
    try {
      child = this.startLoginProcess(args, env);
    } catch (error) {
      rmSync(folder, { recursive: true, force: true });
      throw error;
    }
    const state = { id: randomBytes(6).toString("hex"), state: "running", url: null, account: null, error: null, code: null, startedAt: this.clock().toISOString(), folder, child, label: label ? cleanLabel(label) : null };
    this.login = state;
    const watch = (chunk) => {
      if (state.url) {
        return;
      }
      const text = String(chunk).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
      const found = /https:\/\/[^\s"'<>)\]]+/.exec(text);
      if (found && /(claude|anthropic)\./i.test(found[0])) {
        state.url = found[0];
      }
    };
    child.stdout?.on("data", watch);
    child.stderr?.on("data", watch);
    const timer = setTimeout(() => {
      if (state.state === "running") {
        state.timedOut = true;
        killProcessTree(child);
      }
    }, this.loginTimeoutMs);
    timer.unref?.();
    const finish = (code, spawnError) => {
      clearTimeout(timer);
      if (state.state !== "running") {
        return;
      }
      try {
        if (state.cancelled) {
          state.state = "cancelled";
        } else if (spawnError || code !== 0) {
          state.state = "failed";
          state.code = state.timedOut ? "login-timeout" : "login-failed";
          state.error = state.timedOut ? "the sign-in was not finished in time" : "the sign-in did not finish";
        } else {
          const temp = new ClaudeAccounts({ claudeHome: folder, directory: this.directory, platform: "linux", env: {}, clock: this.clock, harden: false, runtime: this.runtime });
          temp.explicitHome = true;
          const saved = temp.save({ label: state.label });
          state.account = saved;
          state.state = "done";
          this.audit("claude-account-add", saved.id, "added through a separate sign-in (the live login was not touched)");
        }
      } catch (error) {
        state.state = "failed";
        state.code = error.code ?? "login-failed";
        state.error = error.code ? error.message : "the new login could not be saved";
      } finally {
        rmSync(folder, { recursive: true, force: true });
        state.child = null;
      }
    };
    child.on("error", (error) => finish(1, error));
    child.on("close", (code) => finish(code ?? 1));
    return this.loginView();
  }

  loginView() {
    const state = this.login;
    if (!state) {
      return { state: "idle" };
    }
    return { id: state.id, state: state.state, url: state.url, account: state.account, error: state.error, code: state.code, startedAt: state.startedAt };
  }

  cancelAddLogin() {
    this.assertAttended();
    const state = this.login;
    if (state && state.state === "running") {
      state.cancelled = true;
      killProcessTree(state.child);
      // the close event settles the state; make it visible at once as well
      state.state = "cancelled";
      rmSync(state.folder, { recursive: true, force: true });
    }
    return this.loginView();
  }

  async usage(id = null) {
    let token;
    let key;
    let expiresAt;
    try {
      const live = this.readLive();
      let profile = null;
      let by = null;
      if (id) {
        profile = this.loadProfile(id);
        by = live.token || live.email ? this.matchInfo(live, [profile]).by : null;
      } else if (live.token || live.email) {
        ({ profile, by } = this.matchInfo(live));
      }
      let source;
      if (!id || !profile) {
        // The active account (or an unsaved login): the live login.
        source = live.oauth;
      } else if (by === "token" || by === "refresh") {
        source = live.oauth;
      } else if (by === "email" && live.token) {
        // Same email, different token: probably a refreshed login of this account, possibly another
        // process's. Prefer the profile's own saved login; use the live one only when that has expired.
        const own = profile.credentials;
        source = own?.accessToken && !(Number(own.expiresAt) && Number(own.expiresAt) < this.clock().getTime()) ? own : live.oauth;
      } else {
        source = profile.credentials;
      }
      token = source?.accessToken;
      expiresAt = Number(source?.expiresAt) || null;
      key = profile?.id ?? "live";
    } catch (error) {
      return error instanceof AccountError ? { error: error.message, code: error.code ?? "failed" } : { error: "the account could not be read", code: "unreadable" };
    }
    if (!token) {
      return { error: "no login", code: "no-login" };
    }
    if (expiresAt && expiresAt < this.clock().getTime()) {
      return { error: "login expired: switch to this account once so Claude Code refreshes it", code: "expired", expired: true };
    }
    const cached = this.usageCache.get(key);
    if (cached && this.usageTtlMs > 0 && Date.now() - cached.at < this.usageTtlMs) {
      return cached.value;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);
    try {
      const response = await this.fetchImplementation(USAGE_URL, {
        method: "GET",
        headers: { authorization: "Bearer " + token, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20", accept: "application/json" },
        signal: controller.signal
      });
      if (!response.ok) {
        return { error: "usage request failed (HTTP " + response.status + ")", code: "http", status: response.status };
      }
      const data = await response.json();
      const part = (entry) => ({ pct: Number.isFinite(Number(entry?.utilization)) ? Number(entry.utilization) : null, resetsAt: entry?.resets_at ?? null });
      const value = { fiveHour: part(data?.five_hour), sevenDay: part(data?.seven_day) };
      this.usageCache.set(key, { at: Date.now(), value });
      return value;
    } catch (error) {
      return error?.name === "AbortError" ? { error: "usage request timed out", code: "timeout" } : { error: "usage request failed", code: "failed" };
    } finally {
      clearTimeout(timer);
    }
  }
}
