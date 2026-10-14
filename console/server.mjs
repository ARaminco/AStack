import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ConsoleAuth } from "./auth.mjs";
import { ConsoleApi, HttpError, isIrreversible } from "./api.mjs";
import { ConsoleEvents } from "./events.mjs";
import { ConsoleUsers, LoginGuard, normalizeUsername } from "./users.mjs";
import { AccessVerifier } from "./access.mjs";
import { ChatError, ChatManager } from "./chats.mjs";
import { parseInterval } from "../scheduler-engine/cron.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIRECTORY = join(here, "public");
export const DEFAULT_PORT = 7717;
export const DEFAULT_HOST = "127.0.0.1";
const MAX_BODY_BYTES = 64 * 1024;
const COOKIE = "aramin_sid";
// The remote listener is always HTTPS at the edge: a __Host- cookie is
// Secure, host-only and Path=/ by definition.
const REMOTE_COOKIE = "__Host-aramin_sid";
export const DEFAULT_REMOTE_PORT = 7718;
// SSE keep-alive comments: Cloudflare drops a connection idle for about 100s.
export const HEARTBEAT_MS = 20000;
const REMOTE_MAX_HOURS = 12;
const FORWARDING_HEADERS = ["cf-connecting-ip", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "forwarded", "x-real-ip", "cf-access-jwt-assertion"];
const LOCAL = { kind: "local", cookie: COOKIE };
const REMOTE = { kind: "remote", cookie: REMOTE_COOKIE };

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8"
};

// No inline script, no inline style attribute, nothing from another origin.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

const SECURITY_HEADERS = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
};

export function isLoopback(host) {
  const value = String(host ?? "").replace(/^\[|\]$/g, "").toLowerCase();
  return value === "localhost" || value === "::1" || /^127\.\d+\.\d+\.\d+$/.test(value);
}

/**
 * Settings for the console, merged from `console:` in astack.config.yaml and
 * explicit overrides. A non-loopback host from the config alone is refused:
 * exposing the console beyond this machine must be typed on the command line
 * (`--host`) or allowed explicitly with `console.allow_remote: true`.
 */
export function resolveConsoleSettings(config = {}, overrides = {}) {
  const warnings = [];
  let host = overrides.host ?? config.host ?? DEFAULT_HOST;
  const explicitHost = overrides.host !== undefined && overrides.host !== null;
  if (!isLoopback(host) && !explicitHost && config.allow_remote !== true) {
    warnings.push("console.host " + host + " ignored: binding beyond this machine needs --host or console.allow_remote: true");
    host = DEFAULT_HOST;
  }
  if (!isLoopback(host)) {
    warnings.push("Aramin is listening on " + host + ": anyone who can reach this address sees the login page. Use HTTPS in front of it and keep the token secret.");
  }
  const port = Number(overrides.port ?? config.port ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Invalid console port: " + (overrides.port ?? config.port));
  }
  let pollMs = 3000;
  try {
    pollMs = config.poll_interval ? parseInterval(String(config.poll_interval)) : 3000;
  } catch {
    pollMs = 3000;
  }
  const remote = resolveRemoteSettings(config.remote);
  let allowedHosts = Array.isArray(config.allowed_hosts) ? config.allowed_hosts.map(String) : [];
  if (remote?.hostname && allowedHosts.some((entry) => entry.toLowerCase() === remote.hostname)) {
    warnings.push("console.allowed_hosts lists " + remote.hostname + ", the remote listener's public name: it is ignored on the local listener, which never answers the public host name");
    allowedHosts = allowedHosts.filter((entry) => entry.toLowerCase() !== remote.hostname);
  }
  if (remote?.error) {
    warnings.push("console.remote: " + remote.error);
  }
  let sessionIdleMs = null;
  if (config.session_idle) {
    try {
      sessionIdleMs = parseInterval(String(config.session_idle));
    } catch {
      warnings.push("console.session_idle " + config.session_idle + " ignored: use forms like 30m, 12h, 7d");
    }
  }
  return {
    host,
    port,
    pollMs,
    sessionDays: Number(config.session_days ?? 30),
    locale: config.locale ?? null,
    allowedHosts,
    authMode: ["token", "password", "both"].includes(config.auth) ? config.auth : null,
    sessionIdleMs,
    lockout: config.lockout && typeof config.lockout === "object" ? config.lockout : {},
    chats: config.chats && typeof config.chats === "object" ? config.chats : {},
    remote,
    warnings
  };
}

/**
 * `console.remote`: the optional second listener a tunnel points at. Null
 * when absent or disabled; `{ error }` when enabled but unusable.
 */
export function resolveRemoteSettings(section) {
  if (!section || typeof section !== "object" || section.enabled !== true) {
    return null;
  }
  const hostname = String(section.hostname ?? "").trim().toLowerCase().replace(/\.$/, "");
  const host = String(section.host ?? DEFAULT_HOST);
  const port = Number(section.port ?? DEFAULT_REMOTE_PORT);
  const base = { enabled: true, hostname, host, port, chat: section.chat === true };
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(hostname)) {
    return { ...base, error: "console.remote.hostname must be the public host name the tunnel serves (for example console.example.com)" };
  }
  if (!isLoopback(host)) {
    return { ...base, error: "console.remote.host must be a loopback address: the tunnel connector runs on this machine, and only it may reach the remote listener" };
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return { ...base, error: "invalid console.remote.port " + section.port };
  }
  const hours = Number(section.session_hours ?? REMOTE_MAX_HOURS);
  const idleMinutes = Number(section.idle_minutes ?? 60);
  const access = section.access && typeof section.access === "object" && (section.access.team || section.access.aud)
    ? { team: String(section.access.team ?? ""), aud: String(section.access.aud ?? "") }
    : null;
  return {
    ...base,
    sessionMs: Math.min(REMOTE_MAX_HOURS, hours > 0 ? hours : REMOTE_MAX_HOURS) * 60 * 60 * 1000,
    idleMs: Math.max(5, idleMinutes > 0 ? idleMinutes : 60) * 60 * 1000,
    access
  };
}

export function consoleStateDirectory(workspaceRoot) {
  return join(workspaceRoot, ".astack", "console");
}

export function readServerRecord(workspaceRoot) {
  const path = join(consoleStateDirectory(workspaceRoot), "server.json");
  if (!existsSync(path)) {
    return null;
  }
  try {
    const record = JSON.parse(readFileSync(path, "utf8"));
    let alive = false;
    try {
      process.kill(record.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    return { ...record, alive };
  } catch {
    return null;
  }
}

function buildHash() {
  const hash = createHash("sha256");
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else {
        hash.update(entry.name);
        hash.update(readFileSync(path));
      }
    }
  };
  if (existsSync(PUBLIC_DIRECTORY)) {
    walk(PUBLIC_DIRECTORY);
  }
  return hash.digest("hex").slice(0, 12);
}

function loadLocale(root, locale) {
  try {
    const messages = JSON.parse(readFileSync(join(root, "locales", locale + ".json"), "utf8"));
    return { meta: messages.meta ?? { locale, direction: locale === "fa" ? "rtl" : "ltr" }, strings: messages.console ?? {} };
  } catch {
    return { meta: { locale, direction: "ltr" }, strings: {} };
  }
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) {
      cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return cookies;
}

/**
 * Aramin — the AStack console.
 *
 * One node:http listener, no framework: the installable PWA shell from
 * `console/public/`, a JSON API over the runtime, and a Server-Sent Events
 * stream for live badges and notifications. Bound to loopback by default.
 */
export class ConsoleServer {
  constructor({ runtime, host = DEFAULT_HOST, port = DEFAULT_PORT, pollMs = 3000, sessionDays = 30, locale = null, allowedHosts = [], log = console.log, clock = null, authMode = null, sessionIdleMs = null, lockout = {}, chats = {}, remote = null, accessFetch = null, accessCertsUrl = null, claudeHome = null } = {}) {
    if (!runtime) {
      throw new Error("ConsoleServer needs a runtime");
    }
    this.runtime = runtime;
    this.host = host;
    this.port = Number(port);
    this.log = log;
    this.locale = locale ?? runtime.configuration?.get?.("language.ui", null) ?? "fa";
    this.remote = remote && remote.enabled ? remote : null;
    // The public host name is never answered on the local listener.
    this.allowedHosts = allowedHosts.filter((entry) => !this.remote?.hostname || entry.toLowerCase() !== this.remote.hostname);
    this.directory = consoleStateDirectory(runtime.workspaceRoot);
    this.clock = clock ?? (() => new Date());
    this.auth = new ConsoleAuth(this.directory, { clock, sessionDays, idleMs: sessionIdleMs });
    this.users = new ConsoleUsers(this.directory, { clock });
    const minutes = Number(lockout.minutes ?? 15) > 0 ? Number(lockout.minutes ?? 15) : 15;
    this.guard = new LoginGuard({ attempts: Number(lockout.attempts ?? 5) || 5, windowMs: minutes * 60 * 1000, lockMs: minutes * 60 * 1000, clock });
    this.authModeSetting = authMode;
    this.events = new ConsoleEvents(runtime, { pollMs, clock });
    this.api = new ConsoleApi(runtime, { events: this.events, server: this, clock });
    this.chats = new ChatManager({ runtime, config: chats, events: this.events, clock, home: claudeHome, log });
    this.accessFetch = accessFetch;
    this.accessCertsUrl = accessCertsUrl;
    this.access = null;
    this.remoteServer = null;
    this.remoteError = null;
    this.server = null;
    this.heartbeat = null;
    this.startedAt = null;
    this.build = buildHash();
    this.locales = new Map();
  }

  get origin() {
    const host = this.host.includes(":") ? "[" + this.host + "]" : this.host;
    return "http://" + (host === "0.0.0.0" || host === "[::]" ? "127.0.0.1" : host) + ":" + this.port;
  }

  describe() {
    return {
      running: Boolean(this.server?.listening),
      host: this.host,
      port: this.port,
      url: this.origin,
      loopback: isLoopback(this.host),
      startedAt: this.startedAt,
      build: this.build,
      sessions: this.auth.count(),
      clients: this.events.clients.size,
      tokenFile: ".astack/console/token",
      authMode: this.authMode(),
      users: this.users.count(),
      remote: this.remote ? this.describeRemote() : null
    };
  }

  describeRemote() {
    const listening = Boolean(this.remoteServer?.listening);
    const port = listening ? this.remoteServer.address().port : this.remote.port;
    return {
      running: listening,
      host: this.remote.host,
      port,
      url: listening ? "http://" + (this.remote.host.includes(":") ? "[" + this.remote.host + "]" : this.remote.host) + ":" + port : null,
      hostname: this.remote.hostname,
      publicUrl: this.remote.hostname ? "https://" + this.remote.hostname : null,
      chat: this.remote.chat,
      access: Boolean(this.remote.access),
      error: this.remoteError ?? this.remote.error ?? null
    };
  }

  /** token | password | both. Unset: both once a console user exists, else token. */
  authMode() {
    const users = this.users.count();
    if (this.authModeSetting === "password" && !users) {
      return "token";
    }
    if (["token", "password", "both"].includes(this.authModeSetting)) {
      return this.authModeSetting;
    }
    return users ? "both" : "token";
  }

  loginOptions(listener = LOCAL) {
    if (listener.kind === "remote") {
      return { methods: ["password"], totp: "required", remote: true };
    }
    const mode = this.authMode();
    const users = this.users.list();
    const withTotp = users.filter((user) => user.totp).length;
    return {
      methods: mode === "both" ? ["password", "token"] : [mode],
      totp: !withTotp ? "off" : withTotp === users.length ? "required" : "optional",
      remote: false
    };
  }

  chatAccess(listener = LOCAL) {
    if (!this.chats.enabled()) {
      return { enabled: false, reason: "disabled" };
    }
    if (listener.kind === "remote" && !this.remote?.chat) {
      return { enabled: false, reason: "remote" };
    }
    return { enabled: true, reason: null, remote: listener.kind === "remote" };
  }

  /** The remote listener answers its public host name and nothing else. */
  remoteHostAllowed(header) {
    return Boolean(this.remote?.hostname) && String(header ?? "").toLowerCase() === this.remote.hostname;
  }

  /** The client address: Cloudflare's CF-Connecting-IP on the remote listener only, the socket peer everywhere else. */
  clientAddress(request, listener = LOCAL) {
    const peer = request.socket.remoteAddress ?? "unknown";
    if (listener.kind === "remote") {
      const forwarded = String(request.headers["cf-connecting-ip"] ?? "").trim();
      if (forwarded && isIP(forwarded)) {
        return forwarded;
      }
    }
    return peer;
  }

  /** A one-time ticket comes from this machine: a loopback peer and no proxy in between. */
  directLocalRequest(request) {
    const peer = String(request.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    return isLoopback(peer) && !FORWARDING_HEADERS.some((name) => request.headers[name] !== undefined);
  }

  hostAllowed(header) {
    if (!isLoopback(this.host)) {
      // Bound beyond loopback on purpose; the owner chose the exposure.
      return true;
    }
    const value = String(header ?? "").toLowerCase();
    const names = ["127.0.0.1", "localhost", "[::1]", ...this.allowedHosts.map((entry) => entry.toLowerCase())];
    return names.some((name) => value === name + ":" + this.port || (this.port === 80 && value === name));
  }

  sameOrigin(request, listener = LOCAL) {
    const origin = request.headers.origin;
    if (listener.kind === "remote") {
      // Behind the tunnel every write must say exactly where it comes from.
      return Boolean(origin) && String(origin).toLowerCase() === "https://" + this.remote.hostname;
    }
    if (origin) {
      try {
        return new URL(origin).host.toLowerCase() === String(request.headers.host ?? "").toLowerCase();
      } catch {
        return false;
      }
    }
    return request.headers["sec-fetch-site"] !== "cross-site";
  }

  send(response, status, body, headers = {}) {
    if (response.headersSent) {
      return;
    }
    response.writeHead(status, {
      ...SECURITY_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers
    });
    response.end(JSON.stringify(body));
  }

  readBody(request) {
    return new Promise((resolvePromise, reject) => {
      let size = 0;
      const chunks = [];
      request.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new HttpError(413, "payload too large"));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) {
          resolvePromise({});
          return;
        }
        try {
          resolvePromise(JSON.parse(raw));
        } catch {
          reject(new HttpError(400, "invalid JSON body"));
        }
      });
      request.on("error", reject);
    });
  }

  sessionCookie(id, maxAge, listener = LOCAL) {
    if (listener.kind === "remote") {
      return REMOTE_COOKIE + "=" + id + "; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=" + maxAge;
    }
    return COOKIE + "=" + id + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=" + maxAge;
  }

  localeBundle(locale) {
    const key = ["fa", "en"].includes(locale) ? locale : "fa";
    if (!this.locales.has(key)) {
      this.locales.set(key, loadLocale(this.runtime.root, key));
    }
    return this.locales.get(key);
  }

  serveStatic(request, response, pathname) {
    let relative = pathname === "/" ? "/index.html" : pathname;
    if (relative === "/sw.js" || relative === "/manifest.webmanifest" || relative.startsWith("/icons/") || relative.startsWith("/fonts/") || /^\/[a-z0-9-]+\.(js|css|html|svg|png|txt)$/i.test(relative)) {
      // known shell asset shapes only
    } else {
      // Every other path is a client-side route: serve the shell.
      relative = "/index.html";
    }
    const absolute = resolve(PUBLIC_DIRECTORY, "." + normalize(decodeURIComponent(relative)).replace(/\\/g, "/"));
    if (!absolute.startsWith(PUBLIC_DIRECTORY + sep) || !existsSync(absolute) || !statSync(absolute).isFile()) {
      this.send(response, 404, { ok: false, error: "not found" });
      return;
    }
    const type = CONTENT_TYPES[extname(absolute).toLowerCase()] ?? "application/octet-stream";
    let body = readFileSync(absolute);
    const headers = { ...SECURITY_HEADERS, "content-type": type, "cache-control": "no-cache" };
    if (relative === "/sw.js" || relative === "/index.html") {
      body = Buffer.from(body.toString("utf8").replace(/__BUILD__/g, this.build), "utf8");
      if (relative === "/sw.js") {
        headers["service-worker-allowed"] = "/";
      }
    }
    if (relative.startsWith("/fonts/") || relative.startsWith("/icons/")) {
      headers["cache-control"] = "public, max-age=604800";
    }
    const etag = '"' + createHash("sha1").update(body).digest("hex").slice(0, 16) + '"';
    headers.etag = etag;
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, headers);
      response.end();
      return;
    }
    response.writeHead(200, headers);
    response.end(request.method === "HEAD" ? undefined : body);
  }

  async handle(request, response, listener = LOCAL) {
    if (listener.kind === "remote") {
      if (!this.remoteHostAllowed(request.headers.host)) {
        this.send(response, 421, { ok: false, error: "unexpected host header" });
        return;
      }
      if (this.access) {
        const verdict = await this.access.verify(request.headers["cf-access-jwt-assertion"]);
        if (!verdict.ok) {
          this.log("[console] remote request refused by Cloudflare Access check: " + verdict.reason);
          this.send(response, 403, { ok: false, error: "Cloudflare Access assertion missing or invalid" });
          return;
        }
      }
    } else if (!this.hostAllowed(request.headers.host)) {
      this.send(response, 421, { ok: false, error: "unexpected host header" });
      return;
    }
    const url = new URL(request.url, "http://localhost");
    const pathname = url.pathname;
    const method = request.method ?? "GET";
    if (!pathname.startsWith("/api/")) {
      if (method !== "GET" && method !== "HEAD") {
        this.send(response, 405, { ok: false, error: "method not allowed" });
        return;
      }
      this.serveStatic(request, response, pathname);
      return;
    }

    const address = this.clientAddress(request, listener);
    const cookies = parseCookies(request.headers.cookie);
    const session = this.auth.session(cookies[listener.cookie], { channel: listener.kind });
    const query = Object.fromEntries(url.searchParams.entries());

    // ------------------------------------------------------ public endpoints
    if (pathname === "/api/health") {
      this.send(response, 200, { ok: true, name: "aramin", build: this.build });
      return;
    }
    if (pathname === "/api/i18n" && method === "GET") {
      const bundle = this.localeBundle(query.lang ?? this.locale);
      this.send(response, 200, { ok: true, ...bundle }, { "cache-control": "no-cache" });
      return;
    }
    if (pathname === "/api/session" && method === "GET") {
      const login = this.loginOptions(listener);
      this.send(response, 200, session
        ? {
            ok: true,
            authenticated: true,
            csrf: session.csrf,
            locale: this.locale,
            build: this.build,
            features: { ...this.api.features(), chats: this.chatAccess(listener) },
            server: { loopback: isLoopback(this.host), remote: listener.kind === "remote" },
            user: session.user ?? null,
            method: session.method ?? "token",
            stepUp: listener.kind === "remote",
            login
          }
        : { ok: true, authenticated: false, locale: this.locale, build: this.build, login });
      return;
    }
    if (pathname === "/api/login" && method === "POST") {
      await this.login(request, response, listener, address);
      return;
    }

    // ------------------------------------------------- authenticated from here
    if (!session) {
      this.send(response, 401, { ok: false, error: "login required" });
      return;
    }
    const write = method !== "GET" && method !== "HEAD";
    if (write) {
      if (!this.sameOrigin(request, listener)) {
        this.send(response, 403, { ok: false, error: "cross-origin request refused" });
        return;
      }
      if (!this.auth.checkCsrf(session, request.headers["x-csrf-token"])) {
        this.send(response, 403, { ok: false, error: "missing or invalid CSRF token" });
        return;
      }
    }

    if (pathname === "/api/events" && method === "GET") {
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });
      response.write("retry: 4000\n\n");
      this.events.addClient(response, { chat: this.chatAccess(listener).enabled });
      return;
    }
    if (pathname === "/api/logout" && method === "POST") {
      this.auth.destroySession(cookies[listener.cookie]);
      this.send(response, 200, { ok: true }, { "set-cookie": this.sessionCookie("", 0, listener) });
      return;
    }
    if (pathname === "/api/logout-all" && method === "POST") {
      const ended = this.auth.destroyAll();
      this.runtime.audit?.record({ actor: "owner@console", action: "console-logout-all", target: address, riskLevel: "L1", result: ended + " session(s) ended" });
      this.send(response, 200, { ok: true, data: { ended } }, { "set-cookie": this.sessionCookie("", 0, listener) });
      return;
    }

    const body = write ? await this.readBody(request) : {};
    const result = await this.route(method, pathname, query, body, session, listener, address);
    if (result === undefined) {
      this.send(response, 404, { ok: false, error: "unknown endpoint" });
      return;
    }
    this.send(response, 200, { ok: true, data: result });
  }

  loginFailure(response, { address, method, username = null, keys, reason, listener }) {
    // "user", not "password": audit text is redacted after credential words.
    const label = method === "password" ? "user" : method;
    this.guard.fail(keys);
    this.auth.recordFailure(address);
    this.log("[console] failed login from " + address);
    this.runtime.audit?.record({ actor: "console", action: "console-login-failed", target: address, riskLevel: "L1", result: label + (username ? " " + username : "") + " (" + reason + ", " + listener.kind + ")" });
    this.send(response, 401, { ok: false, error: "invalid credentials" });
  }

  /**
   * Sign-in. The local listener takes the owner token, a one-time ticket
   * (from this machine only) or a username and password (plus the TOTP code
   * when the user has one), as `console.auth` allows. The remote listener
   * takes a username, password and TOTP code, nothing else. Failures are
   * audited (never the secret), limited per address and per username, and
   * answered with one uniform message.
   */
  async login(request, response, listener, address) {
    if (!this.sameOrigin(request, listener)) {
      this.send(response, 403, { ok: false, error: "cross-origin login refused" });
      return;
    }
    if (!this.auth.allowAttempt(address)) {
      this.send(response, 429, { ok: false, error: "too many attempts, wait a minute" });
      return;
    }
    const body = await this.readBody(request);
    const method = body.ticket ? "ticket" : body.username !== undefined || body.password !== undefined ? "password" : "token";
    const options = this.loginOptions(listener);
    if (listener.kind === "remote" && method !== "password") {
      this.runtime.audit?.record({ actor: "console", action: "console-login-failed", target: address, riskLevel: "L1", result: method + " refused on the remote listener" });
      this.send(response, 403, { ok: false, error: "sign in with your username, password and authenticator code" });
      return;
    }
    if (method === "ticket" && !this.directLocalRequest(request)) {
      this.send(response, 403, { ok: false, error: "a sign-in link only works on this computer" });
      return;
    }
    if ((method === "token" && !options.methods.includes("token")) || (method === "password" && !options.methods.includes("password"))) {
      this.send(response, 403, { ok: false, error: "this sign-in method is turned off (console.auth)" });
      return;
    }
    const username = method === "password" ? normalizeUsername(body.username) : null;
    const keys = ["ip:" + address, ...(method === "password" ? ["user:" + (username ?? String(body.username ?? "").toLowerCase().slice(0, 64))] : [])];
    if (method !== "ticket") {
      const gate = this.guard.check(keys);
      if (!gate.allowed) {
        this.runtime.audit?.record({ actor: "console", action: "console-login-locked", target: address, riskLevel: "L1", result: (method === "password" ? "user" : method) + (username ? " " + username : "") });
        this.send(response, 429, { ok: false, error: "too many attempts, try again later", retryAfterSeconds: Math.ceil(gate.retryAfterMs / 1000) }, { "retry-after": String(Math.ceil(gate.retryAfterMs / 1000)) });
        return;
      }
    }
    let user = null;
    if (method === "ticket") {
      if (!this.auth.redeemTicket(body.ticket)) {
        this.auth.recordFailure(address);
        this.runtime.audit?.record({ actor: "console", action: "console-login-failed", target: address, riskLevel: "L1", result: "ticket (invalid or used)" });
        this.send(response, 401, { ok: false, error: "invalid credentials" });
        return;
      }
    } else if (method === "token") {
      if (!this.auth.checkToken(body.token)) {
        this.loginFailure(response, { address, method, keys, reason: "wrong token", listener });
        return;
      }
    } else {
      const name = await this.users.checkPassword(body.username, String(body.password ?? ""));
      if (!name) {
        this.loginFailure(response, { address, method, username, keys, reason: "wrong username or secret", listener });
        return;
      }
      const needsCode = listener.kind === "remote" || this.users.hasTotp(name);
      if (needsCode && (!this.users.hasTotp(name) || !this.users.useTotp(name, body.code))) {
        this.loginFailure(response, { address, method, username: name, keys, reason: this.users.hasTotp(name) ? "wrong code" : "no TOTP for remote sign-in", listener });
        return;
      }
      user = name;
    }
    this.guard.succeed(keys);
    const remote = listener.kind === "remote";
    const created = this.auth.createSession({
      userAgent: request.headers["user-agent"],
      user,
      channel: listener.kind,
      method,
      maxAgeMs: remote ? this.remote.sessionMs : null,
      idleMs: remote ? this.remote.idleMs : null
    });
    this.runtime.audit?.record({ actor: "owner@console", action: "console-login", target: address, riskLevel: "L1", result: "session (" + (method === "password" ? "user" : method) + (user ? " " + user : "") + ", " + listener.kind + ")" });
    this.send(response, 200, { ok: true, authenticated: true, csrf: created.csrf }, { "set-cookie": this.sessionCookie(created.id, created.maxAgeSeconds, listener) });
  }

  /**
   * Step-up on the remote listener: approving something irreversible (or a
   * conversation's tool use) needs a fresh authenticator code as well as the
   * typed confirmation.
   */
  stepUp(session, body, address) {
    const keys = ["ip:" + address, "user:" + (session.user ?? "?")];
    const gate = this.guard.check(keys);
    if (!gate.allowed) {
      throw new HttpError(429, "too many attempts, try again later");
    }
    if (!session.user || !this.users.useTotp(session.user, body.totp)) {
      this.guard.fail(keys);
      this.runtime.audit?.record({ actor: "owner@console", action: "console-step-up-failed", target: address, riskLevel: "L1", result: session.user ?? "no user" });
      throw new HttpError(422, "a fresh authenticator code is required", { stepUpRequired: true });
    }
  }

  async chatCall(fn) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ChatError) {
        throw new HttpError(error.status, error.message, error.details);
      }
      throw error;
    }
  }

  async route(method, pathname, query, body, session, listener = LOCAL, address = "unknown") {
    const api = this.api;
    const segments = pathname.split("/").filter(Boolean).slice(1).map((segment) => decodeURIComponent(segment));
    const [resource, id, action] = segments;
    if (resource === "chats") {
      const access = this.chatAccess(listener);
      if (!access.enabled) {
        throw new HttpError(access.reason === "remote" ? 403 : 404, access.reason === "remote" ? "conversations are not available over the internet listener" : "conversations are turned off", { chats: access.reason });
      }
      if (method === "GET") {
        if (!id) {
          return this.chatCall(() => this.chats.list(query));
        }
        if (id === "status") {
          return this.chats.status();
        }
        return this.chatCall(() => this.chats.get(id, { before: query.before ?? null, turns: query.turns, agent: query.agent || null }));
      }
      if (method === "POST") {
        if (!id) {
          return this.chatCall(() => this.chats.send({ project: body.project ?? 0, prompt: body.prompt, channel: listener.kind }));
        }
        if (action === "messages") {
          return this.chatCall(() => this.chats.send({ sessionId: id, prompt: body.prompt, channel: listener.kind }));
        }
        if (action === "stop") {
          this.runtime.audit?.record({ actor: "owner@console", action: "console-chat-stop", target: id, riskLevel: "L1", result: "stop requested" });
          return this.chatCall(() => this.chats.stop(id));
        }
      }
      return undefined;
    }
    if (method === "GET") {
      switch (resource) {
        case "home":
          return api.home();
        case "counts":
          return this.events.counts();
        case "notifications":
          return { items: this.events.recent(Number(query.limit) || 30) };
        case "approvals":
          return id ? api.approval(id) : api.approvals(query);
        case "missions":
          return id ? api.mission(id) : api.missions(query);
        case "runs":
          return id ? api.run(id) : api.runs(query);
        case "jobs":
          return api.jobs();
        case "hooks":
          return api.hooks();
        case "audit":
          return api.auditLog(query);
        case "memory":
          if (id === "entity") {
            return api.memoryEntity(query);
          }
          if (id === "stats") {
            return api.memoryStats();
          }
          return api.memorySearch(query);
        case "skills":
          return id ? api.skill(id) : api.skills(query);
        case "board":
          return api.board();
        case "gateway":
          return api.gateway();
        case "system":
          return api.system();
        case "search":
          return api.search(query);
        default:
          return undefined;
      }
    }
    if (method === "POST") {
      if (resource === "approvals" && id && action === "decide") {
        if (listener.kind === "remote" && body.decision === "approve") {
          let record = null;
          try {
            record = this.runtime.approvals.get(id);
          } catch {
            record = null;
          }
          if (record && record.state === "pending" && (isIrreversible(record) || record.action === "claude.tool")) {
            this.stepUp(session, body, address);
          }
        }
        return api.decide(id, body);
      }
      if (resource === "missions" && id && ["pause", "resume", "cancel"].includes(action)) {
        return api.missionAction(id, action, body);
      }
      if (resource === "runs" && !id) {
        return api.startRun(session.key, body);
      }
      if (resource === "jobs" && id && action === "run") {
        return api.runJob(id);
      }
    }
    return undefined;
  }

  writeRecord() {
    mkdirSync(this.directory, { recursive: true });
    const remote = this.remote ? this.describeRemote() : null;
    writeFileSync(join(this.directory, "server.json"), JSON.stringify({
      pid: process.pid,
      host: this.host,
      port: this.port,
      url: this.origin,
      startedAt: this.startedAt,
      build: this.build,
      ...(remote ? { remote: { running: remote.running, url: remote.url, hostname: remote.hostname, publicUrl: remote.publicUrl, chat: remote.chat, access: remote.access, error: remote.error } } : {})
    }, null, 2) + "\n", "utf8");
  }

  clearRecord() {
    const record = readServerRecord(this.runtime.workspaceRoot);
    if (record && record.pid === process.pid) {
      rmSync(join(this.directory, "server.json"), { force: true });
    }
  }

  listenerHandler(listener) {
    return (request, response) => {
      this.handle(request, response, listener).catch((error) => {
        const status = error instanceof HttpError ? error.status : /^Unknown /.test(error.message) ? 404 : 500;
        if (status === 500) {
          this.log("[console] error: " + error.message);
        }
        this.send(response, status, { ok: false, error: error.message, ...(error.details ?? {}) });
      });
    };
  }

  start() {
    // Make sure the token exists before the first login screen is shown.
    this.auth.token();
    return new Promise((resolvePromise, reject) => {
      this.server = createServer(this.listenerHandler(LOCAL));
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, async () => {
        this.port = this.server.address().port;
        this.startedAt = new Date().toISOString();
        this.events.start();
        this.heartbeat = setInterval(() => this.events.heartbeat(), HEARTBEAT_MS);
        this.heartbeat.unref?.();
        if (this.remote) {
          try {
            await this.startRemote();
          } catch (error) {
            this.remoteError = error.message;
            this.log("[console] remote listener not started: " + error.message);
          }
        }
        this.writeRecord();
        resolvePromise(this);
      });
    });
  }

  /**
   * The internet-facing listener a tunnel points at. It refuses to start
   * unless the configuration is complete and at least one console user has
   * two-factor sign-in.
   */
  startRemote() {
    const remote = this.remote;
    if (!remote) {
      return Promise.resolve(null);
    }
    if (remote.error) {
      return Promise.reject(new Error(remote.error));
    }
    if (!this.users.anyWithTotp()) {
      return Promise.reject(new Error("console.remote needs a console user with two-factor sign-in. Run `astack console user set <name>` and `astack console user totp <name>`, then restart the console."));
    }
    if (remote.access) {
      try {
        this.access = new AccessVerifier({ ...remote.access, fetch: this.accessFetch ?? globalThis.fetch, certsUrl: this.accessCertsUrl, clock: this.clock });
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return new Promise((resolvePromise, reject) => {
      const server = createServer(this.listenerHandler(REMOTE));
      server.once("error", reject);
      server.listen(remote.port, remote.host, () => {
        this.remoteServer = server;
        this.remoteError = null;
        resolvePromise(server);
      });
    });
  }

  stop() {
    return new Promise((resolvePromise) => {
      clearInterval(this.heartbeat);
      this.events.stop();
      this.chats.stopAll();
      if (this.remoteServer) {
        this.remoteServer.closeAllConnections?.();
        this.remoteServer.close();
        this.remoteServer = null;
      }
      if (!this.server) {
        resolvePromise(false);
        return;
      }
      this.clearRecord();
      this.server.closeAllConnections?.();
      this.server.close(() => resolvePromise(true));
      this.server = null;
    });
  }
}
