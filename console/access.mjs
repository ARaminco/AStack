import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";

/**
 * Cloudflare Access verification for the remote listener (defence in depth:
 * cloudflared enforces Access too).
 *
 * Every request must carry `Cf-Access-Jwt-Assertion`: an RS256 JWT signed by
 * one of the team's keys from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`.
 * The signature, `aud` (must contain the application's AUD tag), `iss` (the
 * team domain), `exp` and `nbf` are checked with node:crypto only. Keys are
 * cached for an hour; an unknown key id refetches at most once a minute.
 */

const LEEWAY_SECONDS = 30;
const KEYS_TTL_MS = 60 * 60 * 1000;
const REFETCH_MS = 60 * 1000;

export function accessTeamOrigin(team) {
  const value = String(team ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\.cloudflareaccess\.com\/?$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
    throw new Error("console.remote.access.team must be the Cloudflare Access team name (the <team> in <team>.cloudflareaccess.com)");
  }
  return "https://" + value + ".cloudflareaccess.com";
}

function decodePart(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

export class AccessVerifier {
  constructor({ team, aud, fetch = globalThis.fetch, certsUrl = null, clock = null } = {}) {
    this.issuer = accessTeamOrigin(team);
    this.aud = String(aud ?? "").trim();
    if (!this.aud) {
      throw new Error("console.remote.access.aud is required with console.remote.access.team");
    }
    this.certsUrl = certsUrl ?? this.issuer + "/cdn-cgi/access/certs";
    this.fetch = fetch;
    this.clock = clock ?? (() => new Date());
    this.keys = new Map();
    this.fetchedAt = 0;
    this.pending = null;
    this.verified = new Map();
  }

  async loadKeys(force = false) {
    const now = this.clock().getTime();
    if (!force && this.keys.size && now - this.fetchedAt < KEYS_TTL_MS) {
      return this.keys;
    }
    if (force && now - this.fetchedAt < REFETCH_MS && this.keys.size) {
      return this.keys;
    }
    if (!this.pending) {
      this.pending = (async () => {
        const response = await this.fetch(this.certsUrl, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) {
          throw new Error("Access certs answered HTTP " + response.status);
        }
        const body = await response.json();
        const keys = new Map();
        for (const jwk of body.keys ?? []) {
          if (jwk.kty !== "RSA" || !jwk.kid) {
            continue;
          }
          try {
            keys.set(jwk.kid, createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: "jwk" }));
          } catch {
            continue;
          }
        }
        if (!keys.size) {
          throw new Error("Access certs held no RSA key");
        }
        this.keys = keys;
        this.fetchedAt = this.clock().getTime();
        return keys;
      })().finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  /** `{ ok: true, email, sub }` or `{ ok: false, reason }`. Never throws. */
  async verify(token) {
    try {
      return await this.check(String(token ?? "").trim());
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  }

  async check(token) {
    if (!token) {
      return { ok: false, reason: "missing Cf-Access-Jwt-Assertion" };
    }
    const nowSeconds = Math.floor(this.clock().getTime() / 1000);
    const cacheKey = createHash("sha256").update(token).digest("hex");
    const cached = this.verified.get(cacheKey);
    if (cached && cached.exp > nowSeconds - LEEWAY_SECONDS) {
      return { ok: true, email: cached.email, sub: cached.sub };
    }
    const parts = token.split(".");
    if (parts.length !== 3) {
      return { ok: false, reason: "malformed assertion" };
    }
    const header = decodePart(parts[0]);
    const claims = decodePart(parts[1]);
    if (header.alg !== "RS256") {
      return { ok: false, reason: "unexpected algorithm " + header.alg };
    }
    let keys = await this.loadKeys();
    if (!keys.has(header.kid)) {
      keys = await this.loadKeys(true);
    }
    const key = keys.get(header.kid);
    if (!key) {
      return { ok: false, reason: "unknown signing key" };
    }
    const signed = Buffer.from(parts[0] + "." + parts[1]);
    if (!verifySignature("RSA-SHA256", signed, key, Buffer.from(parts[2], "base64url"))) {
      return { ok: false, reason: "bad signature" };
    }
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(this.aud)) {
      return { ok: false, reason: "wrong audience" };
    }
    if (String(claims.iss ?? "").replace(/\/+$/, "") !== this.issuer) {
      return { ok: false, reason: "wrong issuer" };
    }
    if (typeof claims.exp !== "number" || claims.exp + LEEWAY_SECONDS < nowSeconds) {
      return { ok: false, reason: "expired" };
    }
    if (typeof claims.nbf === "number" && claims.nbf - LEEWAY_SECONDS > nowSeconds) {
      return { ok: false, reason: "not yet valid" };
    }
    if (this.verified.size > 500) {
      this.verified.clear();
    }
    this.verified.set(cacheKey, { exp: claims.exp, email: claims.email ?? null, sub: claims.sub ?? null });
    return { ok: true, email: claims.email ?? null, sub: claims.sub ?? null };
  }
}
