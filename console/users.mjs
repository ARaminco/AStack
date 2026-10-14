import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

/**
 * Console users: username + password (+ optional TOTP) for Aramin.
 *
 * `.astack/console/users.json` holds, per user, an scrypt hash with its own
 * salt and parameters (never the password) and, when two-factor sign-in is
 * on, the TOTP secret. The file is written atomically with mode 0600 where
 * the OS supports it.
 */

export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, keylen: 64 };
export const MIN_PASSWORD_LENGTH = 10;
const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/;
// scrypt with N=2^15, r=8 needs 32 MiB; give it room.
const MAXMEM = 96 * 1024 * 1024;

export function normalizeUsername(value) {
  const name = String(value ?? "").trim().toLowerCase();
  return USERNAME.test(name) ? name : null;
}

export async function hashPassword(password, { N = SCRYPT_PARAMS.N, r = SCRYPT_PARAMS.r, p = SCRYPT_PARAMS.p, keylen = SCRYPT_PARAMS.keylen, salt = randomBytes(16) } = {}) {
  const key = await scrypt(String(password).normalize("NFC"), salt, keylen, { N, r, p, maxmem: MAXMEM });
  return ["scrypt", N, r, p, salt.toString("base64"), key.toString("base64")].join("$");
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

export class ConsoleUsers {
  constructor(directory, { clock = null } = {}) {
    this.directory = directory;
    this.path = join(directory, "users.json");
    this.clock = clock ?? (() => new Date());
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
      totp: Boolean(user.totp?.enabled)
    }));
  }

  get(username) {
    const name = normalizeUsername(username);
    return name ? this.read().users[name] ?? null : null;
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
    data.users[name] = { ...(existing ?? {}), hash, createdAt: existing?.createdAt ?? now, updatedAt: now };
    this.write(data);
    return { username: name, created: !existing };
  }

  remove(username) {
    const name = normalizeUsername(username);
    const data = this.read();
    if (!name || !data.users[name]) {
      return false;
    }
    delete data.users[name];
    this.write(data);
    return true;
  }

  enableTotp(username) {
    const name = normalizeUsername(username);
    const data = this.read();
    if (!name || !data.users[name]) {
      throw new Error("Unknown console user: " + username);
    }
    const secret = base32Encode(randomBytes(20));
    data.users[name].totp = { secret, enabled: true, createdAt: this.clock().toISOString(), lastCounter: -1 };
    data.users[name].updatedAt = this.clock().toISOString();
    this.write(data);
    return { username: name, secret, uri: otpauthUri({ secret, username: name }) };
  }

  disableTotp(username) {
    const name = normalizeUsername(username);
    const data = this.read();
    if (!name || !data.users[name]) {
      throw new Error("Unknown console user: " + username);
    }
    data.users[name].totp = null;
    data.users[name].updatedAt = this.clock().toISOString();
    this.write(data);
    return true;
  }

  /** Always costs one scrypt, known user or not. */
  async checkPassword(username, password) {
    const name = normalizeUsername(username);
    const user = name ? this.read().users[name] : null;
    const ok = await verifyPassword(password, user?.hash ?? (await dummy()));
    return ok && user ? name : null;
  }

  hasTotp(username) {
    return Boolean(this.get(username)?.totp?.enabled);
  }

  /** Check a code and burn its time step so it cannot be replayed. */
  useTotp(username, code) {
    const name = normalizeUsername(username);
    const data = this.read();
    const user = name ? data.users[name] : null;
    if (!user?.totp?.enabled) {
      return false;
    }
    const counter = verifyTotp(user.totp.secret, code, { time: this.clock().getTime(), lastCounter: Number(user.totp.lastCounter ?? -1) });
    if (counter === null) {
      return false;
    }
    user.totp.lastCounter = counter;
    this.write(data);
    return true;
  }
}

// ---------------------------------------------------------------- lockout

/**
 * Failed sign-ins per key (an address, a username). `attempts` failures
 * inside `windowMs` lock the key for `lockMs`. A success clears the key.
 */
export class LoginGuard {
  constructor({ attempts = 5, windowMs = 15 * 60 * 1000, lockMs = 15 * 60 * 1000, clock = null } = {}) {
    this.attempts = Math.max(1, Number(attempts) || 5);
    this.windowMs = windowMs;
    this.lockMs = lockMs;
    this.clock = clock ?? (() => new Date());
    this.entries = new Map();
  }

  now() {
    return this.clock().getTime();
  }

  /** `{ allowed, retryAfterMs }` for every key together. */
  check(keys) {
    const now = this.now();
    let retryAfterMs = 0;
    for (const key of keys.filter(Boolean)) {
      const entry = this.entries.get(key);
      if (entry?.lockedUntil && entry.lockedUntil > now) {
        retryAfterMs = Math.max(retryAfterMs, entry.lockedUntil - now);
      }
    }
    return { allowed: retryAfterMs === 0, retryAfterMs };
  }

  fail(keys) {
    const now = this.now();
    for (const key of keys.filter(Boolean)) {
      const entry = this.entries.get(key) ?? { failures: [], lockedUntil: 0 };
      entry.failures = entry.failures.filter((at) => now - at < this.windowMs);
      entry.failures.push(now);
      if (entry.failures.length >= this.attempts) {
        entry.lockedUntil = now + this.lockMs;
        entry.failures = [];
      }
      this.entries.set(key, entry);
    }
    if (this.entries.size > 5000) {
      for (const [key, entry] of this.entries) {
        if (!entry.failures.length && entry.lockedUntil <= now) {
          this.entries.delete(key);
        }
      }
    }
  }

  succeed(keys) {
    for (const key of keys.filter(Boolean)) {
      this.entries.delete(key);
    }
  }
}
