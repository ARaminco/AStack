import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { slugify } from "../lib/text.mjs";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Profiles and sessions for the internal browser.
 *
 * A profile is a real, persistent browser profile directory. The owner logs
 * into their sites once in a visible window; every later automated run reuses
 * the same profile, so the agent browses as an already authenticated user
 * without a single credential ever being typed by the system.
 */
export class SessionStore {
  constructor(root, { clock } = {}) {
    this.root = root;
    this.directory = join(root, ".astack", "browser");
    this.profilesPath = join(this.directory, "profiles.json");
    this.clock = clock ?? (() => new Date());
  }

  now() {
    return this.clock().toISOString();
  }

  read() {
    if (!existsSync(this.profilesPath)) {
      return { profiles: [] };
    }
    try {
      return JSON.parse(readFileSync(this.profilesPath, "utf8"));
    } catch {
      return { profiles: [] };
    }
  }

  write(state) {
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(this.profilesPath, JSON.stringify(state, null, 2) + "\n", "utf8");
    return state;
  }

  list() {
    return this.read().profiles;
  }

  get(id) {
    const profile = this.list().find((entry) => entry.id === id);
    if (!profile) {
      throw new Error("Unknown browser profile: " + id + ". Create it with: astack browser profile create " + id);
    }
    return profile;
  }

  exists(id) {
    return this.list().some((entry) => entry.id === id);
  }

  userDataDir(id) {
    return join(this.directory, "profiles", id);
  }

  create({ id = null, name = null, description = "", locale = "fa-IR", headless = true } = {}) {
    const profileId = slugify(id ?? name ?? "default", { fallback: "default" });
    const state = this.read();
    if (state.profiles.some((entry) => entry.id === profileId)) {
      return this.get(profileId);
    }
    const profile = {
      id: profileId,
      name: name ?? profileId,
      description,
      locale,
      headless,
      userDataDir: this.userDataDir(profileId),
      createdAt: this.now(),
      lastUsedAt: null,
      sites: []
    };
    mkdirSync(profile.userDataDir, { recursive: true });
    state.profiles.push(profile);
    this.write(state);
    return profile;
  }

  update(id, patch = {}) {
    const state = this.read();
    const index = state.profiles.findIndex((entry) => entry.id === id);
    if (index === -1) {
      throw new Error("Unknown browser profile: " + id);
    }
    state.profiles[index] = { ...state.profiles[index], ...patch, id };
    this.write(state);
    return state.profiles[index];
  }

  touch(id) {
    return this.update(id, { lastUsedAt: this.now() });
  }

  remove(id) {
    const state = this.read();
    const profile = state.profiles.find((entry) => entry.id === id);
    state.profiles = state.profiles.filter((entry) => entry.id !== id);
    this.write(state);
    return profile ?? null;
  }

  sessionPath(id) {
    return join(this.directory, "sessions", id + ".json");
  }

  /**
   * Snapshot the cookies of a profile. Values stay on disk inside .astack,
   * which is never committed and never printed by any command.
   */
  saveSession(id, cookies = []) {
    const path = this.sessionPath(id);
    mkdirSync(join(this.directory, "sessions"), { recursive: true });
    const payload = {
      profile: id,
      savedAt: this.now(),
      cookies: cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path ?? "/",
        expires: cookie.expires && cookie.expires > 0 ? new Date(cookie.expires * 1000).toISOString() : null,
        httpOnly: Boolean(cookie.httpOnly),
        secure: Boolean(cookie.secure),
        sameSite: cookie.sameSite ?? null
      }))
    };
    writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
    const hosts = new Map();
    for (const cookie of payload.cookies) {
      const host = String(cookie.domain ?? "").replace(/^\./, "");
      const entry = hosts.get(host) ?? { host, cookieCount: 0, expiresAt: null };
      entry.cookieCount += 1;
      if (cookie.expires && (!entry.expiresAt || cookie.expires < entry.expiresAt)) {
        entry.expiresAt = cookie.expires;
      }
      hosts.set(host, entry);
    }
    const profile = this.get(id);
    const sites = [...hosts.values()].map((entry) => ({
      ...entry,
      loggedInAt: profile.sites.find((site) => site.host === entry.host)?.loggedInAt ?? this.now()
    }));
    this.update(id, { sites, lastUsedAt: this.now() });
    return { path, cookies: payload.cookies.length, hosts: sites.length };
  }

  loadSession(id) {
    const path = this.sessionPath(id);
    if (!existsSync(path)) {
      return null;
    }
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  }

  /**
   * Build a Cookie header for a URL from a stored session, so an authenticated
   * endpoint can be watched by a scheduled http-check without a browser.
   */
  cookieHeader(id, url) {
    const session = this.loadSession(id);
    if (!session) {
      return null;
    }
    let target = null;
    try {
      target = new URL(url);
    } catch {
      return null;
    }
    const now = this.clock().getTime();
    const matches = session.cookies.filter((cookie) => {
      const domain = String(cookie.domain ?? "").replace(/^\./, "");
      if (!domain || !(target.hostname === domain || target.hostname.endsWith("." + domain))) {
        return false;
      }
      if (!target.pathname.startsWith(cookie.path ?? "/")) {
        return false;
      }
      if (cookie.secure && target.protocol !== "https:") {
        return false;
      }
      if (cookie.expires && new Date(cookie.expires).getTime() <= now) {
        return false;
      }
      return true;
    });
    return matches.length ? matches.map((cookie) => cookie.name + "=" + cookie.value).join("; ") : null;
  }

  /**
   * Session health per site: which logins are still valid, which are about to
   * expire and which need the owner to sign in again.
   */
  health(id, { warnDays = 7 } = {}) {
    const profile = this.get(id);
    const now = this.clock().getTime();
    const sites = profile.sites.map((site) => {
      const expiresAt = site.expiresAt ? new Date(site.expiresAt).getTime() : null;
      const daysLeft = expiresAt ? Number(((expiresAt - now) / DAY).toFixed(2)) : null;
      const state = expiresAt === null
        ? "session"
        : expiresAt <= now
          ? "expired"
          : daysLeft <= warnDays
            ? "expiring"
            : "valid";
      return { host: site.host, cookies: site.cookieCount, loggedInAt: site.loggedInAt, expiresAt: site.expiresAt, daysLeft, state };
    });
    return {
      profile: profile.id,
      lastUsedAt: profile.lastUsedAt,
      sites,
      needsLogin: sites.filter((site) => site.state === "expired").map((site) => site.host),
      expiringSoon: sites.filter((site) => site.state === "expiring").map((site) => site.host)
    };
  }
}
