import { isIP } from "node:net";

/**
 * Small shared helpers for AStack's inbound HTTP listeners (signals, gateway
 * webhooks, A2A).
 */

/** 127.0.0.0/8, ::1 and localhost. Anything else is reachable from outside. */
export function isLoopbackHost(host) {
  const value = String(host ?? "").replace(/^\[|\]$/g, "").toLowerCase();
  if (value === "localhost" || value === "::1") {
    return true;
  }
  return isIP(value) === 4 && value.startsWith("127.");
}

/**
 * Refuse to bind a non-loopback host unless the owner set `allow_remote`
 * deliberately. Exposing a listener is the owner's decision, never a default.
 */
export function assertBindable(host, { allowRemote = false, setting = "allow_remote" } = {}) {
  if (!isLoopbackHost(host) && allowRemote !== true) {
    throw new Error("Refusing to listen on " + host + ": only loopback is allowed. Set " + setting + ": true in astack.config.yaml to expose it deliberately.");
  }
}

/**
 * Fixed-window rate limit per address with a bounded map: stale windows are
 * pruned, and when more than `maxEntries` addresses are tracked the oldest
 * are dropped, so a flood of spoofed addresses cannot grow memory without
 * limit.
 */
export class RateLimiter {
  constructor({ limit = 60, windowMs = 60000, maxEntries = 5000, now = () => Date.now() } = {}) {
    this.limit = Number(limit);
    this.windowMs = Number(windowMs);
    this.maxEntries = Math.max(1, Number(maxEntries));
    this.now = now;
    this.hits = new Map();
  }

  prune(now) {
    for (const [address, entry] of this.hits) {
      if (now - entry.since > this.windowMs) {
        this.hits.delete(address);
      }
    }
    // Map iteration order is insertion order: the oldest windows go first.
    while (this.hits.size > this.maxEntries) {
      this.hits.delete(this.hits.keys().next().value);
    }
  }

  allow(address) {
    const now = this.now();
    const key = String(address ?? "unknown");
    let entry = this.hits.get(key);
    if (!entry || now - entry.since > this.windowMs) {
      this.hits.delete(key);
      entry = { count: 0, since: now };
      if (this.hits.size >= this.maxEntries) {
        this.prune(now);
        while (this.hits.size >= this.maxEntries) {
          this.hits.delete(this.hits.keys().next().value);
        }
      }
      this.hits.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  get size() {
    return this.hits.size;
  }
}
