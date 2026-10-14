import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Background services, in the order the daemon starts them. Each is a
 * `<dir>/service.mjs` exporting `createService({ runtime, config, log })`
 * (see documentation/V3-Plan.md). A missing file is skipped silently.
 */
export const SERVICE_DIRECTORIES = [
  "runner-engine",
  "scheduler-engine",
  "signal-engine",
  "gateway-engine",
  "search-engine",
  "skill-hub",
  "console",
  "board-engine"
];

const DEFAULTS = {
  restartBackoffMs: 1000,
  restartBackoffMaxMs: 60000,
  healthIntervalMs: 5000,
  stopTimeoutMs: 15000
};

/**
 * One background process for everything that must keep running while no
 * agent session is open: the runner queue, the scheduler, the webhook
 * listener and whichever later services are installed.
 *
 * The daemon supervises; it adds no authority. Every service runs through
 * the same runtime object, so policy, approvals and audit apply unchanged.
 */
export class DaemonEngine {
  constructor({ runtime, coreRoot = null, workspaceRoot = null, config = null, log = null, services = null, entry = null } = {}) {
    this.runtime = runtime;
    this.coreRoot = coreRoot ?? runtime?.root;
    this.workspaceRoot = workspaceRoot ?? runtime?.workspaceRoot ?? this.coreRoot;
    this.config = config ?? runtime?.configuration?.section("daemon", {}) ?? {};
    this.directory = join(this.workspaceRoot, ".astack", "daemon");
    this.pidPath = join(this.directory, "daemon.json");
    this.statePath = join(this.directory, "state.json");
    this.logPath = join(this.directory, "daemon.log");
    this.eventsPath = join(this.directory, "events.jsonl");
    this.stopPath = join(this.directory, "stop.request");
    this.serviceOverride = services;
    this.entry = entry ?? join(this.coreRoot, "bin", "astack.mjs");
    this.echo = log;
    this.settings = {
      restartBackoffMs: Number(this.config.restart_backoff_ms ?? DEFAULTS.restartBackoffMs),
      restartBackoffMaxMs: Number(this.config.restart_backoff_max_ms ?? DEFAULTS.restartBackoffMaxMs),
      healthIntervalMs: Number(this.config.health_interval_ms ?? DEFAULTS.healthIntervalMs),
      stopTimeoutMs: Number(this.config.stop_timeout_ms ?? DEFAULTS.stopTimeoutMs)
    };
    this.supervised = [];
    this.stopping = false;
    this.healthTimer = null;
    this.stopWaiters = [];
  }

  // ------------------------------------------------------------ bookkeeping

  log(line, { service = null } = {}) {
    const text = "[" + new Date().toISOString() + "]" + (service ? " [" + service + "]" : "") + " " + line;
    try {
      mkdirSync(this.directory, { recursive: true });
      this.rotateLog();
      appendFileSync(this.logPath, text + "\n", "utf8");
    } catch {
      // Logging must never take a service down.
    }
    this.echo?.(text);
  }

  rotateLog() {
    try {
      if (existsSync(this.logPath) && statSync(this.logPath).size > 5 * 1024 * 1024) {
        renameSync(this.logPath, this.logPath + ".1");
      }
    } catch {
      // A held file is rotated on the next line.
    }
  }

  record(event, payload = {}) {
    try {
      mkdirSync(this.directory, { recursive: true });
      appendFileSync(this.eventsPath, JSON.stringify({ at: new Date().toISOString(), event, ...payload }) + "\n", "utf8");
    } catch {
      // see log()
    }
    this.runtime?.eventBus?.emit("daemon." + event, payload);
  }

  readPid() {
    if (!existsSync(this.pidPath)) {
      return null;
    }
    try {
      return JSON.parse(readFileSync(this.pidPath, "utf8"));
    } catch {
      return null;
    }
  }

  writeState() {
    try {
      mkdirSync(this.directory, { recursive: true });
      const state = {
        pid: process.pid,
        at: new Date().toISOString(),
        services: this.supervised.map((entry) => this.describeService(entry))
      };
      writeFileSync(this.statePath + ".tmp", JSON.stringify(state, null, 2) + "\n", "utf8");
      renameSync(this.statePath + ".tmp", this.statePath);
    } catch {
      // A missed heartbeat only makes `status` stale.
    }
  }

  describeService(entry) {
    let detail = {};
    try {
      detail = entry.service?.status?.() ?? {};
    } catch (error) {
      detail = { error: error.message };
    }
    return {
      name: entry.name,
      directory: entry.directory,
      state: entry.state,
      restarts: entry.restarts,
      lastCrash: entry.lastCrash,
      nextRestartAt: entry.nextRestartAt,
      detail
    };
  }

  // -------------------------------------------------------------- discovery

  /**
   * The services this workspace can run: `daemon.services` when configured,
   * otherwise every service file that exists.
   */
  plannedServices() {
    if (this.serviceOverride) {
      return this.serviceOverride.map((entry) => ({ ...entry, exists: entry.factory ? true : existsSync(entry.path) }));
    }
    const enabled = Array.isArray(this.config.services) && this.config.services.length ? this.config.services.map(String) : null;
    return SERVICE_DIRECTORIES
      .filter((directory) => !enabled || enabled.includes(directory))
      .map((directory) => {
        const path = join(this.coreRoot, directory, "service.mjs");
        return { directory, path, exists: existsSync(path) };
      });
  }

  async loadServices() {
    const loaded = [];
    for (const entry of this.plannedServices()) {
      if (!entry.exists) {
        continue;
      }
      let factory = entry.factory ?? null;
      if (!factory) {
        try {
          factory = (await import(pathToFileURL(entry.path).href)).createService;
        } catch (error) {
          this.log("could not load " + entry.directory + "/service.mjs: " + error.message);
          this.record("service-load-failed", { directory: entry.directory, error: error.message });
          continue;
        }
      }
      if (typeof factory !== "function") {
        this.log(entry.directory + "/service.mjs does not export createService; skipped");
        continue;
      }
      loaded.push({
        directory: entry.directory,
        factory,
        name: entry.directory,
        service: null,
        state: "pending",
        restarts: 0,
        lastCrash: null,
        nextRestartAt: null,
        timer: null
      });
    }
    return loaded;
  }

  serviceConfig(directory) {
    return this.config[directory] ?? {};
  }

  // ------------------------------------------------------------ supervision

  async startEntry(entry) {
    if (this.stopping) {
      return;
    }
    try {
      entry.service = entry.factory({
        runtime: this.runtime,
        config: this.serviceConfig(entry.directory),
        log: (line) => this.log(line, { service: entry.name }),
        fail: (error) => this.crashed(entry, error)
      });
      entry.name = entry.service?.name ?? entry.directory;
      entry.state = "starting";
      await entry.service.start();
      entry.state = "running";
      entry.nextRestartAt = null;
      this.log("started", { service: entry.name });
      this.record("service-started", { service: entry.name, restarts: entry.restarts });
    } catch (error) {
      this.crashed(entry, error);
    }
  }

  crashed(entry, error) {
    if (this.stopping || entry.state === "backoff") {
      return;
    }
    entry.state = "backoff";
    entry.restarts += 1;
    entry.lastCrash = { at: new Date().toISOString(), error: String(error?.message ?? error).slice(0, 300) };
    const delay = Math.min(this.settings.restartBackoffMaxMs, this.settings.restartBackoffMs * Math.pow(2, Math.min(entry.restarts - 1, 16)));
    entry.nextRestartAt = new Date(Date.now() + delay).toISOString();
    this.log("crashed: " + entry.lastCrash.error + "; restart in " + Math.round(delay / 1000) + "s (restart " + entry.restarts + ")", { service: entry.name });
    this.record("service-crashed", { service: entry.name, error: entry.lastCrash.error, restarts: entry.restarts, delayMs: delay });
    this.runtime?.audit?.record({
      actor: "daemon",
      action: "daemon-service-crashed",
      target: entry.name,
      riskLevel: "L0",
      result: entry.lastCrash.error,
      metadata: { restarts: entry.restarts, delayMs: delay }
    });
    const previous = entry.service;
    entry.timer = setTimeout(async () => {
      entry.timer = null;
      try {
        await previous?.stop?.();
      } catch {
        // A crashed service may not stop cleanly; a fresh instance replaces it.
      }
      await this.startEntry(entry);
    }, delay);
  }

  healthCheck() {
    for (const entry of this.supervised) {
      if (entry.state !== "running") {
        continue;
      }
      let status = null;
      try {
        status = entry.service?.status?.() ?? null;
      } catch (error) {
        this.crashed(entry, error);
        continue;
      }
      if (status?.state === "crashed") {
        this.crashed(entry, new Error(status.lastError ?? "service reported a crash"));
      }
    }
    this.writeState();
    if (existsSync(this.stopPath)) {
      rmSync(this.stopPath, { force: true });
      this.log("stop requested");
      this.shutdown("stop-request");
    }
  }

  /**
   * Run in this process until stopped. `astack daemon start --foreground`
   * and the OS service both end up here.
   */
  async run({ handleSignals = true } = {}) {
    const existing = this.readPid();
    if (existing && existing.pid !== process.pid && alive(existing.pid)) {
      throw new Error("the AStack daemon is already running (pid " + existing.pid + "); stop it first: astack daemon stop");
    }
    mkdirSync(this.directory, { recursive: true });
    rmSync(this.stopPath, { force: true });
    this.stopping = false;
    this.supervised = await this.loadServices();
    writeFileSync(
      this.pidPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), workspace: this.workspaceRoot, services: this.supervised.map((entry) => entry.directory) }, null, 2) + "\n",
      "utf8"
    );
    this.log("daemon started (pid " + process.pid + ") with " + (this.supervised.map((entry) => entry.directory).join(", ") || "no services"));
    this.record("started", { pid: process.pid, services: this.supervised.map((entry) => entry.directory) });
    this.runtime?.audit?.record({ actor: "daemon", action: "daemon-started", target: "daemon", riskLevel: "L0", result: "pid " + process.pid });
    const signalHandler = () => this.shutdown("signal");
    if (handleSignals) {
      process.on("SIGINT", signalHandler);
      process.on("SIGTERM", signalHandler);
      process.on("SIGBREAK", signalHandler);
    }
    for (const entry of this.supervised) {
      await this.startEntry(entry);
    }
    this.writeState();
    this.healthTimer = setInterval(() => this.healthCheck(), this.settings.healthIntervalMs);
    await new Promise((resolve) => this.stopWaiters.push(resolve));
    if (handleSignals) {
      process.off("SIGINT", signalHandler);
      process.off("SIGTERM", signalHandler);
      process.off("SIGBREAK", signalHandler);
    }
    return { stopped: true };
  }

  async shutdown(reason = "requested") {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    clearInterval(this.healthTimer);
    for (const entry of [...this.supervised].reverse()) {
      clearTimeout(entry.timer);
      if (!entry.service || !["running", "starting", "backoff"].includes(entry.state)) {
        entry.state = "stopped";
        continue;
      }
      try {
        await withTimeout(entry.service.stop(), this.settings.stopTimeoutMs);
        this.log("stopped", { service: entry.name });
      } catch (error) {
        this.log("stop failed: " + error.message, { service: entry.name });
      }
      entry.state = "stopped";
    }
    this.writeState();
    if (this.readPid()?.pid === process.pid) {
      rmSync(this.pidPath, { force: true });
    }
    this.log("daemon stopped (" + reason + ")");
    this.record("stopped", { reason });
    this.runtime?.audit?.record({ actor: "daemon", action: "daemon-stopped", target: "daemon", riskLevel: "L0", result: reason });
    for (const resolve of this.stopWaiters.splice(0)) {
      resolve();
    }
  }

  // ------------------------------------------------------------ control CLI

  /**
   * Start the daemon as a detached background process that outlives this
   * command. Its output goes to `.astack/daemon/daemon.log`.
   */
  async startBackground({ waitMs = 8000 } = {}) {
    const existing = this.readPid();
    if (existing && alive(existing.pid)) {
      return { started: false, pid: existing.pid, reason: "already running" };
    }
    mkdirSync(this.directory, { recursive: true });
    const child = spawn(process.execPath, [this.entry, "daemon", "start", "--foreground", "--quiet"], {
      cwd: this.workspaceRoot,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const pid = this.readPid();
      if (pid?.pid === child.pid) {
        return { started: true, pid: child.pid };
      }
      if (child.exitCode !== null) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return { started: alive(child.pid), pid: child.pid, reason: alive(child.pid) ? "started; pid file not written yet" : "the daemon exited; see astack daemon logs" };
  }

  /**
   * Graceful first (a stop request the daemon picks up on its next health
   * check), forceful after the timeout.
   */
  async stop({ timeoutMs = 20000 } = {}) {
    const existing = this.readPid();
    if (!existing) {
      return { stopped: false, reason: "the daemon is not running" };
    }
    if (!alive(existing.pid)) {
      rmSync(this.pidPath, { force: true });
      return { stopped: true, pid: existing.pid, reason: "stale pid file removed" };
    }
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(this.stopPath, new Date().toISOString() + "\n", "utf8");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!alive(existing.pid)) {
        return { stopped: true, pid: existing.pid, reason: "graceful" };
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    try {
      process.kill(existing.pid, "SIGTERM");
    } catch (error) {
      return { stopped: false, pid: existing.pid, reason: error.message };
    }
    rmSync(this.stopPath, { force: true });
    if (this.readPid()?.pid === existing.pid) {
      rmSync(this.pidPath, { force: true });
    }
    return { stopped: true, pid: existing.pid, reason: "forced after " + Math.round(timeoutMs / 1000) + "s" };
  }

  status() {
    const pid = this.readPid();
    const running = Boolean(pid && alive(pid.pid));
    let state = null;
    if (existsSync(this.statePath)) {
      try {
        state = JSON.parse(readFileSync(this.statePath, "utf8"));
      } catch {
        state = null;
      }
    }
    return {
      running,
      pid: pid?.pid ?? null,
      startedAt: pid?.startedAt ?? null,
      heartbeatAt: running ? state?.at ?? null : null,
      services: running && state?.pid === pid.pid ? state.services : [],
      planned: this.plannedServices().map((entry) => ({ directory: entry.directory, exists: entry.exists })),
      log: this.logPath
    };
  }

  logs({ lines = 50 } = {}) {
    if (!existsSync(this.logPath)) {
      return [];
    }
    return readFileSync(this.logPath, "utf8").split(/\r?\n/).filter(Boolean).slice(-lines);
  }
}

function withTimeout(promise, milliseconds) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out after " + milliseconds + "ms")), milliseconds);
    })
  ]);
}

export function alive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
