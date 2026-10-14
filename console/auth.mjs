import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Owner authentication for the Aramin console.
 *
 * One random owner token lives in `.astack/console/token`. The login screen
 * exchanges it once for a session: an opaque id in an HttpOnly, SameSite=Strict
 * cookie, plus a CSRF token that every write must echo in a header. Only
 * hashes of session ids are written to disk, so a copied state folder cannot
 * be replayed as a live session.
 */
export class ConsoleAuth {
  constructor(directory, { clock = null, sessionDays = 30, idleMs = null } = {}) {
    this.directory = directory;
    this.tokenPath = join(directory, "token");
    this.sessionsPath = join(directory, "sessions.json");
    // Tickets issued by another process (`astack console open` while the daemon
    // serves the console). Only hashes and expiry times reach the disk.
    this.ticketsPath = join(directory, "tickets.json");
    this.clock = clock ?? (() => new Date());
    this.sessionMs = Math.max(1, Number(sessionDays) || 30) * DAY;
    // Optional idle timeout (console.session_idle); null keeps sessions alive until they expire.
    this.idleMs = Number(idleMs) > 0 ? Number(idleMs) : null;
    this.sessions = null;
    this.tickets = new Map();
    this.failures = new Map();
  }

  now() {
    return this.clock().getTime();
  }

  ensureDirectory() {
    mkdirSync(this.directory, { recursive: true });
  }

  hasToken() {
    return existsSync(this.tokenPath);
  }

  /** The owner token, created on first use. */
  token() {
    if (existsSync(this.tokenPath)) {
      const value = readFileSync(this.tokenPath, "utf8").trim();
      if (value.length >= 32) {
        return value;
      }
    }
    return this.rotate({ keepSessions: true });
  }

  /** Replace the owner token. Rotating also signs every device out. */
  rotate({ keepSessions = false } = {}) {
    this.ensureDirectory();
    const value = "ar_" + randomBytes(32).toString("base64url");
    atomicWrite(this.tokenPath, value + "\n");
    try {
      chmodSync(this.tokenPath, 0o600);
    } catch {
      // Windows keeps its own ACLs; the folder is per-user already.
    }
    if (!keepSessions) {
      this.sessions = {};
      this.saveSessions();
    }
    return value;
  }

  /** A masked form that is safe to print in logs: first and last characters only. */
  masked() {
    const value = this.token();
    return value.slice(0, 6) + "…" + value.slice(-4);
  }

  checkToken(candidate) {
    return constantTimeEquals(String(candidate ?? "").trim(), this.token());
  }

  /**
   * A one-time login ticket for `astack console start --open`: the browser is
   * opened with the ticket in the URL fragment (never sent to the server in a
   * request line, never logged), and it is good for one login within a minute.
   */
  issueTicket({ ttlMs = 60 * 1000, shared = false } = {}) {
    const ticket = randomBytes(18).toString("base64url");
    const expires = this.now() + ttlMs;
    if (shared) {
      const stored = this.readTickets();
      stored[hash(ticket)] = expires;
      this.writeTickets(stored);
    } else {
      this.tickets.set(hash(ticket), expires);
    }
    return ticket;
  }

  redeemTicket(candidate) {
    const key = hash(String(candidate ?? ""));
    let expires = this.tickets.get(key);
    this.tickets.delete(key);
    if (!expires) {
      const stored = this.readTickets();
      if (stored[key]) {
        expires = stored[key];
        delete stored[key];
        this.writeTickets(stored);
      }
    }
    return Boolean(expires && expires > this.now());
  }

  readTickets() {
    if (!existsSync(this.ticketsPath)) {
      return {};
    }
    try {
      const now = this.now();
      return Object.fromEntries(Object.entries(JSON.parse(readFileSync(this.ticketsPath, "utf8"))).filter(([, expires]) => Number(expires) > now));
    } catch {
      return {};
    }
  }

  writeTickets(stored) {
    this.ensureDirectory();
    atomicWrite(this.ticketsPath, JSON.stringify(stored) + "\n");
  }

  /** Failed logins per address per minute; the eleventh is refused outright. */
  allowAttempt(address, { limit = 10 } = {}) {
    const now = this.now();
    const entry = this.failures.get(address) ?? { count: 0, since: now };
    if (now - entry.since > 60 * 1000) {
      entry.count = 0;
      entry.since = now;
    }
    this.failures.set(address, entry);
    return entry.count < limit;
  }

  recordFailure(address) {
    const entry = this.failures.get(address) ?? { count: 0, since: this.now() };
    entry.count += 1;
    this.failures.set(address, entry);
  }

  loadSessions() {
    if (this.sessions) {
      return this.sessions;
    }
    try {
      this.sessions = existsSync(this.sessionsPath) ? JSON.parse(readFileSync(this.sessionsPath, "utf8")) : {};
    } catch {
      this.sessions = {};
    }
    return this.sessions;
  }

  saveSessions() {
    this.ensureDirectory();
    const now = this.now();
    const live = Object.fromEntries(Object.entries(this.sessions ?? {}).filter(([, session]) => session.expiresAt > now));
    this.sessions = live;
    atomicWrite(this.sessionsPath, JSON.stringify(live, null, 2) + "\n");
  }

  /**
   * `channel` is the listener the session belongs to ("local" or "remote"):
   * a session is only ever valid on the listener that created it. `idleMs`
   * ends a session that has not been used for that long; `maxAgeMs` caps it.
   */
  createSession({ userAgent = null, user = null, channel = "local", method = "token", maxAgeMs = null, idleMs = null } = {}) {
    const sessions = this.loadSessions();
    const id = randomBytes(32).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    const now = this.now();
    const lifetime = Math.min(this.sessionMs, Number(maxAgeMs) > 0 ? Number(maxAgeMs) : this.sessionMs);
    const idle = Number(idleMs) > 0 ? Number(idleMs) : this.idleMs;
    sessions[hash(id)] = {
      csrf,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + lifetime,
      device: userAgent ? String(userAgent).slice(0, 120) : null,
      ...(user ? { user } : {}),
      ...(channel !== "local" ? { channel } : {}),
      ...(method !== "token" ? { method } : {}),
      ...(idle ? { idleMs: idle } : {})
    };
    this.saveSessions();
    return { id, csrf, maxAgeSeconds: Math.floor(lifetime / 1000) };
  }

  session(id, { channel = "local" } = {}) {
    if (!id) {
      return null;
    }
    const sessions = this.loadSessions();
    const key = hash(id);
    const session = sessions[key];
    if (!session) {
      return null;
    }
    if ((session.channel ?? "local") !== channel) {
      return null;
    }
    const now = this.now();
    if (session.expiresAt <= now || (session.idleMs && now - session.lastSeenAt > session.idleMs)) {
      delete sessions[key];
      this.saveSessions();
      return null;
    }
    const persist = session.idleMs && now - session.lastSeenAt > 60 * 1000;
    session.lastSeenAt = now;
    if (persist) {
      this.saveSessions();
    }
    return { key, ...session };
  }

  /** Sign every device out, on every listener. Returns how many sessions ended. */
  destroyAll() {
    const count = Object.keys(this.loadSessions()).length;
    this.sessions = {};
    this.saveSessions();
    return count;
  }

  destroySession(id) {
    const sessions = this.loadSessions();
    delete sessions[hash(String(id ?? ""))];
    this.saveSessions();
  }

  checkCsrf(session, candidate) {
    return Boolean(session && constantTimeEquals(String(candidate ?? ""), session.csrf));
  }

  count() {
    const now = this.now();
    return Object.values(this.loadSessions()).filter((session) => session.expiresAt > now).length;
  }

  clearState() {
    rmSync(this.sessionsPath, { force: true });
    this.sessions = {};
  }
}

export function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function constantTimeEquals(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  if (!a.length || a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function atomicWrite(path, text) {
  const temporary = path + "." + process.pid + ".tmp";
  writeFileSync(temporary, text, "utf8");
  renameSync(temporary, path);
}
