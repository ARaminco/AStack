import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "./http.mjs";
import { processAlive, readJson, writeJsonAtomic } from "./state.mjs";

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "bridges", "whatsapp-baileys");

/**
 * Lifecycle of the linked-device WhatsApp bridge.
 *
 * The bridge's npm dependencies (Baileys) are installed on demand into
 * `.astack/gateway/bridge/app/`, never into the AStack core, which stays
 * dependency free. Session credentials live in `.astack/gateway/bridge/auth/`.
 *
 * Ownership follows Hermes Agent's rule (MIT, NousResearch/hermes-agent:
 * plugins/platforms/whatsapp/bridge_ownership.py): a process is only treated
 * as ours when it proves it — here by answering /health with our token and the
 * instance id we started it with. A pid that merely exists is never signalled.
 */
export class BridgeManager {
  constructor(directory, { policy = null, config = {}, log = () => {}, nodePath = process.execPath } = {}) {
    this.directory = directory;
    this.appDirectory = join(directory, "app");
    this.authDirectory = join(directory, "auth");
    this.configPath = join(directory, "bridge.json");
    this.pidPath = join(directory, "bridge.pid.json");
    this.statusPath = join(directory, "status.json");
    this.logPath = join(directory, "bridge.log");
    this.policy = policy;
    this.config = config;
    this.log = log;
    this.nodePath = nodePath;
  }

  sourceFiles() {
    const files = [];
    const walk = (relative) => {
      for (const name of readdirSync(join(SOURCE, relative))) {
        const path = join(relative, name);
        if (statSync(join(SOURCE, path)).isDirectory()) {
          walk(path);
        } else {
          files.push(path);
        }
      }
    };
    walk("");
    return files;
  }

  installed() {
    return existsSync(join(this.appDirectory, "node_modules", "@whiskeysockets", "baileys", "package.json"));
  }

  connection() {
    const current = readJson(this.configPath, {});
    if (current.token && current.port) {
      return current;
    }
    const created = {
      port: Number(this.config.port ?? current.port ?? 8790),
      token: randomBytes(24).toString("hex"),
      createdAt: new Date().toISOString()
    };
    writeJsonAtomic(this.configPath, created);
    return created;
  }

  npmInvocation(args) {
    // Since Node 20.12 a .cmd cannot be spawned without a shell; running npm's
    // own entry point with this node avoids both the shell and the PATH lookup.
    const cli = join(dirname(this.nodePath), "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(cli)) {
      return { command: this.nodePath, args: [cli, ...args], checked: "npm" };
    }
    return { command: process.platform === "win32" ? "npm.cmd" : "npm", args, checked: "npm", shell: process.platform === "win32" };
  }

  /**
   * Copy the shipped bridge source and install its pinned dependencies.
   */
  setup({ dryRun = false, install = true } = {}) {
    const files = this.sourceFiles();
    const npmArgs = ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-save"];
    const plan = { appDirectory: this.appDirectory, files, install: install ? "npm " + npmArgs.join(" ") : null };
    if (dryRun) {
      return { ...plan, dryRun: true };
    }
    const verdict = this.policy?.allowInvocation?.("npm", npmArgs) ?? { allowed: true };
    if (install && !verdict.allowed) {
      return { ...plan, ok: false, reason: verdict.reason };
    }
    mkdirSync(this.appDirectory, { recursive: true });
    for (const file of files) {
      mkdirSync(dirname(join(this.appDirectory, file)), { recursive: true });
      copyFileSync(join(SOURCE, file), join(this.appDirectory, file));
    }
    this.connection();
    if (!install) {
      return { ...plan, ok: true, installed: this.installed() };
    }
    const npm = this.npmInvocation(npmArgs);
    const result = spawnSync(npm.command, npm.args, { cwd: this.appDirectory, encoding: "utf8", shell: npm.shell ?? false, timeout: 10 * 60 * 1000 });
    return {
      ...plan,
      ok: result.status === 0 && this.installed(),
      exitCode: result.status,
      output: String(result.stdout ?? "").slice(-1500) + String(result.stderr ?? "").slice(-1500),
      installed: this.installed()
    };
  }

  selfTest() {
    if (!this.installed()) {
      return { ok: false, reason: "bridge not installed: run astack gateway whatsapp setup" };
    }
    const script = join(this.appDirectory, "bridge.mjs");
    const verdict = this.policy?.allowInvocation?.("node", [script, "--self-test"]) ?? { allowed: true };
    if (!verdict.allowed) {
      return { ok: false, reason: verdict.reason };
    }
    const result = spawnSync(this.nodePath, [script, "--self-test"], { cwd: this.appDirectory, encoding: "utf8", timeout: 60000 });
    return { ok: result.status === 0, output: String(result.stdout ?? "").trim() + String(result.stderr ?? "").trim().slice(0, 500) };
  }

  bridgeStatusFile() {
    return readJson(this.statusPath, null);
  }

  async probe(connection = this.connection(), path = "/health") {
    try {
      const response = await request({
        url: "http://127.0.0.1:" + connection.port + path,
        headers: { "x-astack-bridge-token": connection.token },
        timeoutMs: 3000,
        label: "bridge " + path
      });
      return response.status === 200 ? response.json() : null;
    } catch {
      return null;
    }
  }

  portFree(port) {
    return new Promise((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
  }

  /**
   * "free" | "ours" | "foreign" | "stale"
   */
  async ownership() {
    const connection = this.connection();
    const record = readJson(this.pidPath, null);
    const health = await this.probe(connection);
    if (record && health && health.instance === record.instance) {
      return { state: "ours", record, health };
    }
    if (record && !processAlive(record.pid)) {
      rmSync(this.pidPath, { force: true });
    }
    const free = await this.portFree(connection.port);
    if (!free) {
      return { state: "foreign", record, reason: "port " + connection.port + " is held by a process this workspace does not own" };
    }
    return { state: record && processAlive(record.pid) ? "stale" : "free", record };
  }

  async status() {
    const owner = await this.ownership();
    const file = this.bridgeStatusFile();
    return {
      installed: this.installed(),
      paired: existsSync(join(this.authDirectory, "creds.json")),
      ownership: owner.state,
      running: owner.state === "ours",
      state: owner.health?.state ?? file?.state ?? "stopped",
      qrAvailable: Boolean(file?.qr) && owner.state === "ours",
      statusFile: this.statusPath,
      port: this.connection().port
    };
  }

  environment({ allowedUsers = [], allowedGroups = [], instance }) {
    return {
      ...process.env,
      ASTACK_BRIDGE_TOKEN: this.connection().token,
      ASTACK_BRIDGE_INSTANCE: instance,
      ASTACK_WA_ALLOWED_USERS: allowedUsers.join(","),
      ASTACK_WA_ALLOWED_GROUPS: allowedGroups.join(",")
    };
  }

  /**
   * Start the bridge in the background, or adopt the one already running.
   */
  async start({ allowedUsers = [], allowedGroups = [], waitMs = 15000 } = {}) {
    if (!this.installed()) {
      return { ok: false, reason: "bridge not installed: run astack gateway whatsapp setup" };
    }
    if (!allowedUsers.length) {
      return { ok: false, reason: "no owner accounts for whatsapp-bridge in gateway.owners" };
    }
    const owner = await this.ownership();
    if (owner.state === "ours") {
      return { ok: true, adopted: true, pid: owner.record.pid };
    }
    if (owner.state === "foreign") {
      return { ok: false, reason: owner.reason };
    }
    if (owner.state === "stale") {
      return { ok: false, reason: "a process recorded in " + this.pidPath + " is alive but does not answer as our bridge; not touching it" };
    }
    const connection = this.connection();
    const script = join(this.appDirectory, "bridge.mjs");
    const args = [script, "--dir", this.directory, "--port", String(connection.port)];
    const verdict = this.policy?.allowInvocation?.("node", args) ?? { allowed: true };
    if (!verdict.allowed) {
      return { ok: false, reason: verdict.reason };
    }
    const instance = randomBytes(8).toString("hex");
    mkdirSync(this.directory, { recursive: true });
    const logHandle = openSync(this.logPath, "a");
    const child = spawn(this.nodePath, args, {
      cwd: this.appDirectory,
      env: this.environment({ allowedUsers, allowedGroups, instance }),
      detached: true,
      stdio: ["ignore", logHandle, logHandle],
      windowsHide: true
    });
    child.unref();
    writeJsonAtomic(this.pidPath, { pid: child.pid, port: connection.port, instance, startedAt: new Date().toISOString() });
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const health = await this.probe(connection);
      if (health?.instance === instance) {
        return { ok: true, pid: child.pid, state: health.state };
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return { ok: false, pid: child.pid, reason: "bridge did not answer within " + Math.round(waitMs / 1000) + "s; see " + this.logPath };
  }

  async stop() {
    const owner = await this.ownership();
    if (owner.state !== "ours") {
      return { ok: owner.state === "free", state: owner.state, reason: owner.reason ?? null };
    }
    const connection = this.connection();
    await request({
      url: "http://127.0.0.1:" + connection.port + "/shutdown",
      method: "POST",
      body: {},
      headers: { "x-astack-bridge-token": connection.token },
      timeoutMs: 5000,
      label: "bridge shutdown"
    }).catch(() => null);
    rmSync(this.pidPath, { force: true });
    return { ok: true, stopped: owner.record.pid };
  }

  /**
   * Foreground pairing: the bridge prints the QR in this terminal and also
   * writes it to status.json for the console. Exits once linked.
   */
  pair({ allowedUsers = [], allowedGroups = [] } = {}) {
    if (!this.installed()) {
      return { ok: false, reason: "bridge not installed: run astack gateway whatsapp setup" };
    }
    const script = join(this.appDirectory, "bridge.mjs");
    const args = [script, "--dir", this.directory, "--pair-only"];
    const verdict = this.policy?.allowInvocation?.("node", args) ?? { allowed: true };
    if (!verdict.allowed) {
      return { ok: false, reason: verdict.reason };
    }
    const result = spawnSync(this.nodePath, args, {
      cwd: this.appDirectory,
      env: this.environment({ allowedUsers, allowedGroups, instance: randomBytes(8).toString("hex") }),
      stdio: "inherit"
    });
    return { ok: result.status === 0, exitCode: result.status };
  }
}
