import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ConsoleAuth } from "./auth.mjs";
import { ConsoleApi, HttpError } from "./api.mjs";
import { ConsoleEvents } from "./events.mjs";
import { parseInterval } from "../scheduler-engine/cron.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIRECTORY = join(here, "public");
export const DEFAULT_PORT = 7717;
export const DEFAULT_HOST = "127.0.0.1";
const MAX_BODY_BYTES = 64 * 1024;
const COOKIE = "aramin_sid";

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
  return {
    host,
    port,
    pollMs,
    sessionDays: Number(config.session_days ?? 30),
    locale: config.locale ?? null,
    allowedHosts: Array.isArray(config.allowed_hosts) ? config.allowed_hosts.map(String) : [],
    warnings
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
  constructor({ runtime, host = DEFAULT_HOST, port = DEFAULT_PORT, pollMs = 3000, sessionDays = 30, locale = null, allowedHosts = [], log = console.log, clock = null } = {}) {
    if (!runtime) {
      throw new Error("ConsoleServer needs a runtime");
    }
    this.runtime = runtime;
    this.host = host;
    this.port = Number(port);
    this.log = log;
    this.locale = locale ?? runtime.configuration?.get?.("language.ui", null) ?? "fa";
    this.allowedHosts = allowedHosts;
    this.directory = consoleStateDirectory(runtime.workspaceRoot);
    this.auth = new ConsoleAuth(this.directory, { clock, sessionDays });
    this.events = new ConsoleEvents(runtime, { pollMs, clock });
    this.api = new ConsoleApi(runtime, { events: this.events, server: this, clock });
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
      tokenFile: ".astack/console/token"
    };
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

  sameOrigin(request) {
    const origin = request.headers.origin;
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

  sessionCookie(id, maxAge) {
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

  async handle(request, response) {
    if (!this.hostAllowed(request.headers.host)) {
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

    const address = request.socket.remoteAddress ?? "unknown";
    const cookies = parseCookies(request.headers.cookie);
    const session = this.auth.session(cookies[COOKIE]);
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
      this.send(response, 200, session
        ? { ok: true, authenticated: true, csrf: session.csrf, locale: this.locale, build: this.build, features: this.api.features(), server: { loopback: isLoopback(this.host) } }
        : { ok: true, authenticated: false, locale: this.locale, build: this.build });
      return;
    }
    if (pathname === "/api/login" && method === "POST") {
      if (!this.sameOrigin(request)) {
        this.send(response, 403, { ok: false, error: "cross-origin login refused" });
        return;
      }
      if (!this.auth.allowAttempt(address)) {
        this.send(response, 429, { ok: false, error: "too many attempts, wait a minute" });
        return;
      }
      const body = await this.readBody(request);
      const valid = body.ticket ? this.auth.redeemTicket(body.ticket) : this.auth.checkToken(body.token);
      if (!valid) {
        this.auth.recordFailure(address);
        this.log("[console] failed login from " + address);
        this.send(response, 401, { ok: false, error: "invalid token" });
        return;
      }
      const created = this.auth.createSession({ userAgent: request.headers["user-agent"] });
      this.runtime.audit?.record({ actor: "owner@console", action: "console-login", target: address, riskLevel: "L1", result: "session" });
      this.send(response, 200, { ok: true, authenticated: true, csrf: created.csrf }, { "set-cookie": this.sessionCookie(created.id, created.maxAgeSeconds) });
      return;
    }

    // ------------------------------------------------- authenticated from here
    if (!session) {
      this.send(response, 401, { ok: false, error: "login required" });
      return;
    }
    const write = method !== "GET" && method !== "HEAD";
    if (write) {
      if (!this.sameOrigin(request)) {
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
      this.events.addClient(response);
      return;
    }
    if (pathname === "/api/logout" && method === "POST") {
      this.auth.destroySession(cookies[COOKIE]);
      this.send(response, 200, { ok: true }, { "set-cookie": this.sessionCookie("", 0) });
      return;
    }

    const body = write ? await this.readBody(request) : {};
    const result = await this.route(method, pathname, query, body, session);
    if (result === undefined) {
      this.send(response, 404, { ok: false, error: "unknown endpoint" });
      return;
    }
    this.send(response, 200, { ok: true, data: result });
  }

  async route(method, pathname, query, body, session) {
    const api = this.api;
    const segments = pathname.split("/").filter(Boolean).slice(1).map((segment) => decodeURIComponent(segment));
    const [resource, id, action] = segments;
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
    writeFileSync(join(this.directory, "server.json"), JSON.stringify({ pid: process.pid, host: this.host, port: this.port, url: this.origin, startedAt: this.startedAt, build: this.build }, null, 2) + "\n", "utf8");
  }

  clearRecord() {
    const record = readServerRecord(this.runtime.workspaceRoot);
    if (record && record.pid === process.pid) {
      rmSync(join(this.directory, "server.json"), { force: true });
    }
  }

  start() {
    // Make sure the token exists before the first login screen is shown.
    this.auth.token();
    return new Promise((resolvePromise, reject) => {
      this.server = createServer((request, response) => {
        this.handle(request, response).catch((error) => {
          const status = error instanceof HttpError ? error.status : /^Unknown /.test(error.message) ? 404 : 500;
          if (status === 500) {
            this.log("[console] error: " + error.message);
          }
          this.send(response, status, { ok: false, error: error.message, ...(error.details ?? {}) });
        });
      });
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.port = this.server.address().port;
        this.startedAt = new Date().toISOString();
        this.events.start();
        this.heartbeat = setInterval(() => this.events.heartbeat(), 25000);
        this.heartbeat.unref?.();
        this.writeRecord();
        resolvePromise(this);
      });
    });
  }

  stop() {
    return new Promise((resolvePromise) => {
      clearInterval(this.heartbeat);
      this.events.stop();
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
