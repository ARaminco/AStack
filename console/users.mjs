import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { VaultBackends } from "../trust-engine/vault.mjs";

const scrypt = promisify(scryptCallback);

/**
 * Console users: username + password (+ optional TOTP) for Aramin.
 *
 * `.astack/console/users.json` holds, per user, an scrypt hash with its own
 * salt and parameters (never the password), a credential version and, when
 * two-factor sign-in is on, where the TOTP secret lives. On Windows the
 * secret itself is kept DPAPI-encrypted for the current Windows user
 * (`vault:windows`, `.astack/vault/console-totp.<user>.dpapi`); on other
 * platforms it stays in this file. The file is written atomically with mode
 * 0600 where the OS supports it.
 *
 * The credential version changes whenever the password or the TOTP setting
 * changes (and a removed user has none), so a session signed in with the old
 * credentials is refused.
 */

// 3.1.1: N=2^17 for new and changed hashes. Older hashes keep their own
// parameters, still verify, and are rehashed on the next successful sign-in.
export const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1, keylen: 64 };
export const MIN_PASSWORD_LENGTH = 10;
const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/;
// scrypt needs 128 * N * r bytes: 128 MiB at N=2^17, r=8; give it room.
const MAXMEM = 256 * 1024 * 1024;

export function normalizeUsername(value) {
  const name = String(value ?? "").trim().toLowerCase();
  return USERNAME.test(name) ? name : null;
}

export async function hashPassword(password, { N = SCRYPT_PARAMS.N, r = SCRYPT_PARAMS.r, p = SCRYPT_PARAMS.p, keylen = SCRYPT_PARAMS.keylen, salt = randomBytes(16) } = {}) {
  const key = await scrypt(String(password).normalize("NFC"), salt, keylen, { N, r, p, maxmem: MAXMEM });
  return ["scrypt", N, r, p, salt.toString("base64"), key.toString("base64")].join("$");
}

/** True when a stored hash uses weaker parameters than SCRYPT_PARAMS. */
export function needsRehash(stored) {
  const parts = String(stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  return Number(parts[1]) < SCRYPT_PARAMS.N || Number(parts[2]) < SCRYPT_PARAMS.r || Number(parts[3]) < SCRYPT_PARAMS.p;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const [, N, r, p, salt, expected] = parts;
  const expectedKey = Buffer.from(expected, "base64");
  let key;
  try {
    key = await scrypt(String(password ?? "").normalize("NFC"), Buffer.from(salt, "base64"), expectedKey.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: MAXMEM });
  } catch {
    return false;
  }
  return key.length === expectedKey.length && timingSafeEqual(key, expectedKey);
}

// ------------------------------------------------------------------- TOTP

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(text) {
  const clean = String(text ?? "").toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of clean) {
    const index = BASE32.indexOf(character);
    if (index === -1) {
      throw new Error("invalid base32");
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** RFC 4226 HOTP with HMAC-SHA1. */
export function hotp(secret, counter, digits = 6) {
  const key = Buffer.isBuffer(secret) ? secret : base32Decode(secret);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  const code = ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(code % 10 ** digits).padStart(digits, "0");
}

/** RFC 6238 TOTP: 30-second steps, 6 digits. */
export function totp(secret, { time = Date.now(), step = 30, digits = 6 } = {}) {
  return hotp(secret, Math.floor(time / 1000 / step), digits);
}

/**
 * The matching time step for `code`, or null. One step of clock drift either
 * way is accepted; a step at or before `lastCounter` is refused, so a code
 * works once.
 */
export function verifyTotp(secret, code, { time = Date.now(), step = 30, window = 1, lastCounter = -1 } = {}) {
  const candidate = String(code ?? "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(candidate)) {
    return null;
  }
  const current = Math.floor(time / 1000 / step);
  let matched = null;
  for (let delta = -window; delta <= window; delta += 1) {
    const counter = current + delta;
    const expected = Buffer.from(hotp(secret, counter));
    if (timingSafeEqual(expected, Buffer.from(candidate)) && counter > lastCounter) {
      matched = counter;
    }
  }
  return matched;
}

export function otpauthUri({ secret, username, issuer = "Aramin" }) {
  const label = encodeURIComponent(issuer) + ":" + encodeURIComponent(username);
  return "otpauth://totp/" + label + "?secret=" + secret + "&issuer=" + encodeURIComponent(issuer) + "&algorithm=SHA1&digits=6&period=30";
}

// -------------------------------------------------------------- the store

// A fixed hash that never matches: unknown usernames still pay one scrypt,
// so the response time does not tell which usernames exist.
let dummyHash = null;
async function dummy() {
  if (!dummyHash) {
    dummyHash = await hashPassword(randomBytes(24).toString("base64"));
  }
  return dummyHash;
}

function newCredentialVersion() {
  return randomBytes(12).toString("base64url");
}

/**
 * Where TOTP secrets live on this machine: the Windows DPAPI vault
 * (`vault:windows`) on Windows, nowhere else (they stay in users.json).
 * `run` is the vault's injectable process runner (tests).
 */
export function createTotpVault({ root, platform = process.platform, env = process.env, run = null } = {}) {
  if (platform !== "win32" || !root) {
    return null;
  }
  const backends = new VaultBackends(root, { platform, env, ...(run ? { run } : {}) });
  const record = (name) => ({ provider: "console-totp", name, source: "vault:windows", reference: "credential://console-totp/" + name });
  return {
    source: "vault:windows",
    write: (name, secret) => backends.write(record(name), secret),
    read: (name) => backends.read(record(name)),
    remove: (name) => backends.remove(record(name))
  };
}

export class ConsoleUsers {
  /**
   * `vault`: undefined picks the platform default (DPAPI on Windows), null
   * keeps secrets in users.json, an object `{ source, read, write, remove }`
   * is used as given.
   */
  constructor(directory, { clock = null, vault = undefined, workspaceRoot = null } = {}) {
    this.directory = directory;
    this.path = join(directory, "users.json");
    this.clock = clock ?? (() => new Date());
    this.vault = vault === undefined ? createTotpVault({ root: workspaceRoot ?? dirname(dirname(directory)) }) : vault || null;
    // Decrypted secrets, keyed by user and enrolment time, so DPAPI runs once per enrolment.
    this.secrets = new Map();
  }

  read() {
    if (!existsSync(this.path)) {
      return { version: 1, users: {} };
    }
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8").replace(/^﻿/, ""));
      return { version: 1, users: data.users ?? {} };
    } catch {
      return { version: 1, users: {} };
    }
  }

  write(data) {
    mkdirSync(this.directory, { recursive: true });
    const temporary = this.path + "." + process.pid + ".tmp";
    writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // Windows keeps its own ACLs.
    }
  }

  list() {
    return Object.entries(this.read().users).map(([name, user]) => ({
      username: name,
      createdAt: user.createdAt ?? null,
      updatedAt: user.updatedAt ?? null,
      totp: Boolean(user.totp?.enabled),
      totpStore: user.totp?.enabled ? (user.totp.store ?? "file") : null
    }));
  }

  get(username) {
    const name = normalizeUsername(username);
    return name ? this.read().users[name] ?? null : null;
  }

  /** The user's current credential version; null for an unknown user or a pre-3.1.1 record. */
  credentialVersion(username) {
    return this.get(username)?.credentialVersion ?? null;
  }

  count() {
    return Object.keys(this.read().users).length;
  }

  anyWithTotp() {
    return Object.values(this.read().users).some((user) => user.totp?.enabled);
  }

  async set(username, password) {
    const name = normalizeUsername(username);
    if (!name) {
      throw new Error("A username is 2-32 characters: a-z, 0-9, dot, dash or underscore, starting with a letter or digit");
    }
    if (String(password ?? "").length < MIN_PASSWORD_LENGTH) {
      throw new Error("The password needs at least " + MIN_PASSWORD_LENGTH + " characters");
    }
    const hash = await hashPassword(password);
    const data = this.read();
    const now = this.clock().toISOString();
    const existing = data.users[name];
    data.users[name] = { ...(existing ?? {}), hash, credentialVersion: newCredentialVersion(), createdAt: existing?.createdAt ?? now, updatedAt: now };
    this.write(data);
    return { username: name, created: !existing };
  }

  remove(username) {
    const name = normalizeUsername(username);
    const data = this.read();
    if (!name || !data.users[name]) {
      return false;
    }
    this.forgetSecret(name, data.users[name].totp);
    delete data.users[name];
    this.write(data);
    return true;
  }

  /** Drop a cached secret and remove a vault-held one (best effort). */
  forgetSecret(name, totpState) {
    for (const key of [...this.secrets.keys()]) {
      if (key.startsWith(name + "\n")) {
        this.secrets.delete(key);
      }
    }
    if (totpState?.store && this.vault && totpState.store === this.vault.source) {
      try {
        this.vault.remove(name);
      } catch {
        // already gone
      }
    }
  }

  /**
   * Turn TOTP on (or reset it) with a fresh secret. The secret is returned
   * once, for enrolment, and kept in the vault when there is one.
   */
  enableTotp(username) {
    const name = normalizeUsername(username);
    const data = this.read();
    if (!name || !data.users[name]) {
      throw new Error("Unknown console user: " + username);
    }
    const secret = base32Encode(randomBytes(20));
    const now = this.clock().toISOString();
    this.forgetSecret(name, data.users[name].totp);
    let stored = { secret };
    if (this.vault) {
      this.vault.write(name, secret);
      stored = { store: this.vault.source };
    }
    data.users[name].totp = { ...stored, enabled: true, createdAt: now, lastCounter: -1 };
    data.users[name].updatedAt = now;
    data.users[name].credentialVersion = newCredentialVersion();
    this.write(data);
    return { username: name, secret, uri: otpauthUri({ secret, username: name }), store: stored.store ?? "file" };
  }

  disableTotp(username) {
    const name = normalizeUsername(username);
    const data = this.read();
    if (!name || !data.users[name]) {
      throw new Error("Unknown console user: " + username);
    }
    this.forgetSecret(name, data.users[name].totp);
    data.users[name].totp = null;
    data.users[name].updatedAt = this.clock().toISOString();
    data.users[name].credentialVersion = newCredentialVersion();
    this.write(data);
    return true;
  }

  /** Always costs one scrypt, known user or not. A weaker hash is upgraded after a match. */
  async checkPassword(username, password) {
    const name = normalizeUsername(username);
    const user = name ? this.read().users[name] : null;
    const ok = await verifyPassword(password, user?.hash ?? (await dummy()));
    if (!ok || !user) {
      return null;
    }
    if (needsRehash(user.hash)) {
      try {
        const hash = await hashPassword(password);
        const data = this.read();
        // Same password, so the credential version stays; skip if it changed meanwhile.
        if (data.users[name]?.hash === user.hash) {
          data.users[name].hash = hash;
          this.write(data);
        }
      } catch {
        // the old hash still verifies
      }
    }
    return name;
  }

  hasTotp(username) {
    return Boolean(this.get(username)?.totp?.enabled);
  }

  /** The plaintext TOTP secret of an enabled user, or null when it cannot be read here. */
  secretOf(name, totpState) {
    if (!totpState?.enabled) {
      return null;
    }
    if (totpState.secret) {
      return totpState.secret;
    }
    if (!this.vault || totpState.store !== this.vault.source) {
      return null;
    }
    const key = name + "\n" + (totpState.createdAt ?? "");
    if (this.secrets.has(key)) {
      return this.secrets.get(key);
    }
    let secret = null;
    try {
      secret = this.vault.read(name);
    } catch {
      secret = null;
    }
    if (secret) {
      this.secrets.set(key, secret);
    }
    return secret;
  }

  /**
   * Check a code and burn its time step so it cannot be replayed. A secret
   * still kept in users.json moves into the vault after a good code.
   */
  useTotp(username, code) {
    const name = normalizeUsername(username);
    const data = this.read();
    const user = name ? data.users[name] : null;
    if (!user?.totp?.enabled) {
      return false;
    }
    const secret = this.secretOf(name, user.totp);
    if (!secret) {
      return false;
    }
    const counter = verifyTotp(secret, code, { time: this.clock().getTime(), lastCounter: Number(user.totp.lastCounter ?? -1) });
    if (counter === null) {
      return false;
    }
    user.totp.lastCounter = counter;
    if (user.totp.secret && this.vault) {
      try {
        this.vault.write(name, user.totp.secret);
        delete user.totp.secret;
        user.totp.store = this.vault.source;
        this.secrets.set(name + "\n" + (user.totp.createdAt ?? ""), secret);
      } catch {
        // stays in the file until the vault works
      }
    }
    this.write(data);
    return true;
  }
}

// ---------------------------------------------------------------- lockout

/**
 * Failed sign-ins per key (an address, a username). `attempts` failures
 * inside `windowMs` lock the key for `lockMs`. A success clears the key.
 * With `path`, the counters survive a restart: only SHA-256 hashes of the
 * keys and the times are written, and expired entries are dropped.
 */
export class LoginGuard {
  constructor({ attempts = 5, windowMs = 15 * 60 * 1000, lockMs = 15 * 60 * 1000, clock = null, path = null } = {}) {
    this.attempts = Math.max(1, Number(attempts) || 5);
    this.windowMs = windowMs;
    this.lockMs = lockMs;
    this.clock = clock ?? (() => new Date());
    this.path = path;
    this.entries = new Map();
    this.load();
  }

  now() {
    return this.clock().getTime();
  }

  static keyOf(key) {
    return createHash("sha256").update("aramin-lockout\n" + String(key)).digest("hex").slice(0, 40);
  }

  live(entry, now) {
    return entry.lockedUntil > now || entry.failures.some((at) => now - at < this.windowMs);
  }

  load() {
    if (!this.path || !existsSync(this.path)) {
      return;
    }
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8"));
      const now = this.now();
      for (const [key, entry] of Object.entries(data.entries ?? {})) {
        const clean = { failures: (Array.isArray(entry?.failures) ? entry.failures : []).map(Number).filter(Number.isFinite), lockedUntil: Number(entry?.lockedUntil) || 0 };
        if (/^[0-9a-f]{40}$/.test(key) && this.live(clean, now)) {
          this.entries.set(key, clean);
        }
      }
    } catch {
      // a damaged file starts empty
    }
  }

  save() {
    if (!this.path) {
      return;
    }
    const now = this.now();
    const entries = {};
    for (const [key, entry] of this.entries) {
      if (this.live(entry, now)) {
        const lastFailure = entry.failures.length ? Math.max(...entry.failures) : 0;
        entries[key] = { failures: entry.failures, lockedUntil: entry.lockedUntil, expiresAt: Math.max(entry.lockedUntil, lastFailure + this.windowMs) };
      }
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = this.path + "." + process.pid + ".tmp";
      writeFileSync(temporary, JSON.stringify({ version: 1, entries }) + "\n", { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, this.path);
    } catch {
      // the in-memory counters still apply
    }
  }

  /** `{ allowed, retryAfterMs }` for every key together. */
  check(keys) {
    const now = this.now();
    let retryAfterMs = 0;
    for (const key of keys.filter(Boolean)) {
      const entry = this.entries.get(LoginGuard.keyOf(key));
      if (entry?.lockedUntil && entry.lockedUntil > now) {
        retryAfterMs = Math.max(retryAfterMs, entry.lockedUntil - now);
      }
    }
    return { allowed: retryAfterMs === 0, retryAfterMs };
  }

  fail(keys) {
    const now = this.now();
    for (const key of keys.filter(Boolean)) {
      const hashed = LoginGuard.keyOf(key);
      const entry = this.entries.get(hashed) ?? { failures: [], lockedUntil: 0 };
      entry.failures = entry.failures.filter((at) => now - at < this.windowMs);
      entry.failures.push(now);
      if (entry.failures.length >= this.attempts) {
        entry.lockedUntil = now + this.lockMs;
        entry.failures = [];
      }
      this.entries.set(hashed, entry);
    }
    if (this.entries.size > 5000) {
      for (const [key, entry] of this.entries) {
        if (!this.live(entry, now)) {
          this.entries.delete(key);
        }
      }
    }
    this.save();
  }

  succeed(keys) {
    let changed = false;
    for (const key of keys.filter(Boolean)) {
      changed = this.entries.delete(LoginGuard.keyOf(key)) || changed;
    }
    if (changed) {
      this.save();
    }
  }
}
