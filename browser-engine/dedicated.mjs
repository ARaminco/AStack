import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { findBrowserBinary, findFreePort } from "./launcher.mjs";

export const PLAYWRIGHT_MCP_PACKAGE = "@playwright/mcp";
// Pinned: a new Playwright MCP release reaches projects with an AStack
// release, never by itself.
export const PLAYWRIGHT_MCP_VERSION = "0.0.83";
export const DEDICATED_SERVER_ID = "browser";
export const PORT_RANGE = [9410, 9599];

const DEFAULTS = {
  enabled: true,
  profile: ".astack/browser/dedicated/profile",
  output: ".astack/browser/dedicated/output",
  port: null,
  headless: false,
  window: "1440,1000",
  args: [],
  caps: "pdf",
  playwright_version: PLAYWRIGHT_MCP_VERSION
};

/**
 * The project's own browser.
 *
 * One Chromium window per project, with a persistent profile under the
 * project's `.astack/`, so the owner signs in once and every later run (AStack
 * flows over CDP, and the Playwright MCP tools of Claude Code and Codex) works
 * in that same signed-in window. Each project gets its own stable debugging
 * port, derived from its path, so two projects never share a browser by
 * accident and a project never attaches to another one's.
 *
 * The browser outlives the session that started it (it is detached) and is
 * started only when a tool first needs it.
 */
export class DedicatedBrowser {
  constructor(root, { config = {}, env = process.env, fetchImpl = globalThis.fetch, spawnImpl = spawn } = {}) {
    this.root = root;
    this.config = { ...DEFAULTS, ...(config ?? {}) };
    this.env = env;
    this.fetch = fetchImpl;
    this.spawn = spawnImpl;
    this.stateDir = join(root, ".astack", "browser", "dedicated");
    this.statePath = join(this.stateDir, "state.json");
  }

  resolvePath(value) {
    return isAbsolute(value) ? value : resolve(this.root, value);
  }

  profileDir() {
    return this.resolvePath(this.config.profile);
  }

  outputDir() {
    return this.resolvePath(this.config.output);
  }

  /** The project's stable port: configured, or derived from its path. */
  preferredPort() {
    if (this.config.port) {
      return Number(this.config.port);
    }
    const digest = createHash("sha1").update(resolve(this.root).toLowerCase()).digest();
    const span = PORT_RANGE[1] - PORT_RANGE[0] + 1;
    return PORT_RANGE[0] + (digest.readUInt32BE(0) % span);
  }

  readState() {
    try {
      return existsSync(this.statePath) ? JSON.parse(readFileSync(this.statePath, "utf8")) : null;
    } catch {
      return null;
    }
  }

  writeState(state) {
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
    return state;
  }

  async endpoint(port) {
    try {
      const response = await this.fetch("http://127.0.0.1:" + port + "/json/version", { signal: AbortSignal.timeout(1500) });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  }

  /**
   * Chrome holds a lock file in its profile while it runs. A debugging port
   * that answers while our profile is locked is our browser; a port that
   * answers while our profile is free belongs to someone else.
   */
  profileInUse() {
    const dir = this.profileDir();
    return ["lockfile", "SingletonLock", "SingletonSocket"].some((name) => existsSync(join(dir, name)));
  }

  /**
   * Ours: the port answers, the profile is locked, and the browser process
   * AStack started (when it recorded one) is still alive — a stale lock left
   * by a crash next to a foreign browser on the same port is not ours.
   */
  owns(state, version) {
    if (!version || !this.profileInUse()) {
      return false;
    }
    if (!state?.pid) {
      return true;
    }
    try {
      process.kill(state.pid, 0);
      return true;
    } catch (error) {
      return error.code === "EPERM";
    }
  }

  async status() {
    const state = this.readState();
    const port = state?.port ?? this.preferredPort();
    const version = await this.endpoint(port);
    const ours = this.owns(state, version);
    return {
      enabled: this.config.enabled !== false,
      running: ours,
      port,
      foreignPort: Boolean(version) && !ours,
      endpoint: "http://127.0.0.1:" + port,
      profile: this.profileDir(),
      output: this.outputDir(),
      binary: findBrowserBinary({ preferred: this.config.binary ?? null }),
      browser: ours ? version.Browser ?? null : null,
      startedAt: state?.startedAt ?? null,
      playwright: PLAYWRIGHT_MCP_PACKAGE + "@" + this.config.playwright_version
    };
  }

  /**
   * The port this project's browser runs on, fixed before anything attaches
   * to it: the running browser's port, else the project's preferred port
   * when it is free, else the next free one. Recorded so every later caller
   * agrees.
   */
  async reservePort() {
    const state = this.readState();
    if (state?.port && this.owns(state, await this.endpoint(state.port))) {
      return state.port;
    }
    const wanted = state?.port ?? this.preferredPort();
    const port = (await this.endpoint(wanted)) ? await findFreePort(PORT_RANGE[0]) : await findFreePort(wanted);
    if (port !== state?.port) {
      this.writeState({ ...(state ?? {}), port, reservedAt: new Date().toISOString() });
    }
    return port;
  }

  /**
   * Make sure the project's browser is running and return its endpoint.
   * Idempotent: a running browser is reused, never duplicated.
   */
  async ensure({ url = null, headless = null } = {}) {
    if (this.config.enabled === false) {
      throw new Error("The dedicated browser is turned off for this project (browser.dedicated.enabled: false).");
    }
    const current = await this.status();
    if (current.running) {
      return { ...current, started: false };
    }
    const binary = current.binary;
    if (!binary) {
      throw new Error("No Chrome, Edge or Chromium was found. Install one, or set ASTACK_BROWSER_PATH or browser.dedicated.binary.");
    }
    const port = await this.reservePort();
    const profile = this.profileDir();
    mkdirSync(profile, { recursive: true });
    mkdirSync(this.outputDir(), { recursive: true });
    // ASTACK_BROWSER_HEADLESS=1 keeps the window hidden (servers, tests, CI).
    const hidden = headless ?? (/^(1|true|yes)$/i.test(String(this.env.ASTACK_BROWSER_HEADLESS ?? "")) || this.config.headless === true);
    const headed = !hidden;
    const args = [
      "--remote-debugging-port=" + port,
      "--remote-debugging-address=127.0.0.1",
      "--user-data-dir=" + profile,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=" + String(this.config.window),
      ...(headed ? [] : ["--headless=new", "--disable-gpu"]),
      ...(Array.isArray(this.config.args) ? this.config.args.map(String) : []),
      ...(url ? [url] : [])
    ];
    const child = this.spawn(binary, args, { detached: true, stdio: "ignore", windowsHide: !headed });
    child.unref?.();
    const deadline = Date.now() + 20000;
    let version = null;
    while (Date.now() < deadline && !version) {
      version = await this.endpoint(port);
      if (!version) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
    }
    if (!version) {
      throw new Error("The dedicated browser did not open its debugging port " + port + " within 20 seconds.");
    }
    this.writeState({ port, pid: child.pid ?? null, binary, headed, profile, startedAt: new Date().toISOString() });
    return { ...(await this.status()), port, started: true };
  }

  /** Close the project's browser (the profile and its logins stay). */
  async stop() {
    const current = await this.status();
    if (!current.running) {
      return { stopped: false, reason: current.foreignPort ? "the port belongs to another browser" : "not running" };
    }
    const version = await this.endpoint(current.port);
    if (version?.webSocketDebuggerUrl && typeof WebSocket !== "undefined") {
      await new Promise((resolveClose) => {
        const socket = new WebSocket(version.webSocketDebuggerUrl);
        const done = () => resolveClose();
        socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Browser.close" })));
        socket.addEventListener("close", done);
        socket.addEventListener("error", done);
        setTimeout(done, 3000);
      });
    }
    return { stopped: true, port: current.port };
  }

  /**
   * The Playwright MCP command line attached to this browser.
   */
  playwrightArgs(port) {
    return [
      "-y",
      PLAYWRIGHT_MCP_PACKAGE + "@" + this.config.playwright_version,
      "--cdp-endpoint", "http://127.0.0.1:" + port,
      "--output-dir", this.outputDir(),
      "--viewport-size", String(this.config.window).replace(",", "x"),
      ...(this.config.caps ? ["--caps", String(this.config.caps)] : [])
    ];
  }
}

/** npx through the running node, so no shell is involved on any platform. */
export function npxCommand(execPath = process.execPath) {
  const candidates = [
    join(dirname(execPath), "node_modules", "npm", "bin", "npx-cli.js"),
    join(dirname(execPath), "..", "lib", "node_modules", "npm", "bin", "npx-cli.js")
  ];
  const cli = candidates.find((path) => existsSync(path));
  return cli
    ? { command: execPath, prefix: [cli], shell: false }
    : { command: process.platform === "win32" ? "npx.cmd" : "npx", prefix: [], shell: process.platform === "win32" };
}

/**
 * Fetch the pinned Playwright MCP package into the npm cache during setup, so
 * the first session does not wait for a download. Best effort: offline setup
 * still succeeds and the package is fetched on first use instead.
 */
export function prefetchPlaywright({ version = PLAYWRIGHT_MCP_VERSION, timeoutMs = 180000 } = {}) {
  const npx = npxCommand();
  const result = spawnSync(npx.command, [...npx.prefix, "-y", PLAYWRIGHT_MCP_PACKAGE + "@" + version, "--help"], {
    encoding: "utf8",
    timeout: timeoutMs,
    shell: npx.shell,
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.error?.message || "npx exited " + result.status).trim().split(/\r?\n/).slice(-1)[0]);
  }
  return PLAYWRIGHT_MCP_PACKAGE + "@" + version;
}

export { DEFAULTS as DEDICATED_DEFAULTS };
