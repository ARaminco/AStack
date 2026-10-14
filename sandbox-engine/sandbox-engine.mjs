import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { redactSecrets } from "../lib/text.mjs";
import { redactResolvedSecrets } from "../trust-engine/redaction.mjs";

/**
 * Isolated command execution through the Docker CLI.
 *
 * Every run is a fresh, throwaway container: no network unless asked for, a
 * read-only root filesystem, every Linux capability dropped, no privilege
 * escalation, a process limit, memory and CPU caps, and mounts that are
 * read-only by default. Places that hold secrets inside a mounted workspace
 * (.astack/security, .astack/vault, browser sessions and profiles, .env files)
 * are hidden behind empty overlays.
 *
 * The automation policy stays the gate: a command it denies is denied here
 * too. The sandbox only relaxes one thing, and only when the run is fully
 * isolated (no network, nothing writable): an interpreter's inline-script flag
 * such as `node -e`, because inside that container the code cannot reach
 * anything the owner cares about. Every run, allowed or denied, is audited.
 */

export const SANDBOX_DEFAULTS = {
  image: "node:22-alpine",
  network: "none",
  memory: "512m",
  cpus: "1",
  pids_limit: 128,
  timeout_ms: 120000,
  user: "65534:65534",
  tmpfs_size: "64m",
  allow_inline_eval_when_isolated: true,
  allow_mounts_outside_workspace: false,
  docker: "docker"
};

const NETWORKS = ["none", "bridge"];

const SENSITIVE_DIRECTORIES = [".astack/security", ".astack/vault", ".astack/browser/sessions", ".astack/browser/profiles"];
const SENSITIVE_FILES = [".env", ".env.local", ".env.production", ".env.development"];

function inside(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function toArgv(command, args) {
  if (Array.isArray(command)) {
    return [...command.map(String), ...(args ?? []).map(String)];
  }
  const words = String(command ?? "").trim().split(/\s+/).filter(Boolean);
  return [...words, ...(args ?? []).map(String)];
}

export class SandboxEngine {
  constructor(root, { clock, eventBus, audit = null, policy = null, config = {}, docker = null, spawnImpl = spawn, spawnSyncImpl = spawnSync } = {}) {
    this.root = root;
    this.directory = join(root, ".astack", "sandbox");
    this.clock = clock ?? (() => new Date());
    this.eventBus = eventBus ?? null;
    this.audit = audit;
    this.policy = policy;
    this.config = { ...SANDBOX_DEFAULTS, ...(config ?? {}) };
    const binary = docker ?? this.config.docker;
    // A command vector, so tests (and unusual installs) can point at a wrapper.
    this.docker = Array.isArray(binary) ? binary.map(String) : [String(binary)];
    this.spawnImpl = spawnImpl;
    this.spawnSyncImpl = spawnSyncImpl;
  }

  now() {
    return this.clock().toISOString();
  }

  dockerSync(args, { timeoutMs = 15000 } = {}) {
    const [command, ...prefix] = this.docker;
    const result = this.spawnSyncImpl(command, [...prefix, ...args], { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
    return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? ""), error: result.error ?? null };
  }

  /**
   * Is the Docker CLI installed, and is its daemon answering?
   */
  status() {
    const result = this.dockerSync(["version", "--format", "{{json .}}"]);
    const base = { image: this.config.image, network: this.config.network, docker: this.docker.join(" ") };
    if (result.error) {
      return {
        ...base,
        installed: false,
        running: false,
        client: null,
        server: null,
        message: result.error.code === "ENOENT" ? "Docker CLI is not installed" : "Docker CLI could not run: " + result.error.message
      };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(result.stdout.trim().split(/\r?\n/)[0] || "null");
    } catch {
      parsed = null;
    }
    const client = parsed?.Client?.Version ?? null;
    const server = parsed?.Server?.Version ?? null;
    const running = result.status === 0 && Boolean(server);
    return {
      ...base,
      installed: true,
      running,
      client,
      server,
      message: running
        ? "Docker " + server + " is running"
        : "Docker CLI " + (client ?? "") + " is installed but the daemon is not running: " + (result.stderr.trim().split(/\r?\n/).pop() ?? "").slice(0, 200)
    };
  }

  images() {
    const result = this.dockerSync(["image", "ls", "--format", "{{json .}}"]);
    if (result.error || result.status !== 0) {
      throw new Error("docker image ls failed: " + (result.error?.message ?? result.stderr.trim().slice(0, 200)));
    }
    return result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          const entry = JSON.parse(line);
          return { image: entry.Repository + ":" + entry.Tag, id: entry.ID, size: entry.Size, created: entry.CreatedSince };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  /**
   * Check a command against the automation policy. Returns the verdict and
   * whether the inline-script relaxation was used.
   */
  check(argv, { isolated }) {
    if (!argv.length) {
      return { allowed: false, reason: "No command given." };
    }
    if (!this.policy) {
      return { allowed: true, reason: "No automation policy loaded.", relaxed: false };
    }
    const [binary, ...args] = argv;
    const command = this.policy.allowCommand(binary);
    if (!command.allowed) {
      return command;
    }
    const invocation = this.policy.allowInvocation(binary, args);
    if (invocation.allowed) {
      return { ...invocation, relaxed: false };
    }
    const inline = /^Inline script execution/.test(invocation.reason);
    if (inline && isolated && this.config.allow_inline_eval_when_isolated !== false) {
      const control = args.find((argument) => /[;&|`$\n\r]/.test(argument));
      if (control) {
        return { allowed: false, reason: "Argument contains shell control characters: " + control.slice(0, 60) };
      }
      return { allowed: true, reason: "Inline script allowed inside an isolated sandbox (no network, nothing writable).", relaxed: true };
    }
    return invocation;
  }

  normalizeMounts(mounts = []) {
    return (mounts ?? []).map((mount) => {
      const entry = typeof mount === "string" ? parseMountSpec(mount) : { ...mount };
      if (!entry.source || !entry.target) {
        throw new Error("A mount needs a source and a target");
      }
      const source = resolve(this.root, String(entry.source));
      const target = String(entry.target);
      if (!target.startsWith("/") || target === "/" || /[,\n]/.test(target)) {
        throw new Error("Mount target must be an absolute container path other than /: " + target);
      }
      if (/[,\n]/.test(source)) {
        throw new Error("Mount source paths cannot contain commas: " + source);
      }
      if (!existsSync(source)) {
        throw new Error("Mount source does not exist: " + source);
      }
      if (!entry.allowOutside && !this.config.allow_mounts_outside_workspace && !inside(this.root, source)) {
        throw new Error("Mount source is outside the workspace: " + source + " (set sandbox.allow_mounts_outside_workspace to allow)");
      }
      return { source, target, readOnly: entry.readOnly !== false };
    });
  }

  emptyFile() {
    mkdirSync(this.directory, { recursive: true });
    const path = join(this.directory, "empty");
    if (!existsSync(path)) {
      writeFileSync(path, "", "utf8");
    }
    return path;
  }

  /**
   * Build the exact `docker run` argument vector. No shell is involved at any
   * point: the container receives the command as an argv (exec form).
   */
  plan({ command, args = [], image = null, workdir = null, mounts = [], network = null, timeoutMs = null, memory = null, cpus = null, env = {}, user = null } = {}) {
    const argv = toArgv(command, args);
    const resolvedNetwork = String(network ?? this.config.network);
    if (!NETWORKS.includes(resolvedNetwork)) {
      throw new Error("Sandbox network must be one of: " + NETWORKS.join(", "));
    }
    const resolvedMounts = this.normalizeMounts(mounts);
    const isolated = resolvedNetwork === "none" && resolvedMounts.every((mount) => mount.readOnly);
    const name = "astack-sbx-" + randomBytes(5).toString("hex");
    const docker = [
      "run", "--rm", "--name", name,
      "--label", "astack.sandbox=1",
      "--network", resolvedNetwork,
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", String(this.config.pids_limit),
      "--memory", String(memory ?? this.config.memory),
      "--cpus", String(cpus ?? this.config.cpus),
      "--user", String(user ?? this.config.user),
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=" + this.config.tmpfs_size,
      "--env", "HOME=/tmp"
    ];
    for (const [key, value] of Object.entries(env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error("Invalid environment variable name: " + key);
      }
      docker.push("--env", key + "=" + String(value));
    }
    for (const mount of resolvedMounts) {
      docker.push("--mount", "type=bind,source=" + mount.source + ",target=" + mount.target + (mount.readOnly ? ",readonly" : ""));
      for (const directory of SENSITIVE_DIRECTORIES) {
        if (existsSync(join(mount.source, directory))) {
          docker.push("--mount", "type=tmpfs,target=" + mount.target.replace(/\/$/, "") + "/" + directory + ",tmpfs-size=4096");
        }
      }
      for (const file of SENSITIVE_FILES) {
        if (existsSync(join(mount.source, file))) {
          docker.push("--mount", "type=bind,source=" + this.emptyFile() + ",target=" + mount.target.replace(/\/$/, "") + "/" + file + ",readonly");
        }
      }
    }
    const resolvedWorkdir = workdir ?? resolvedMounts[0]?.target ?? "/tmp";
    docker.push("--workdir", String(resolvedWorkdir));
    docker.push(String(image ?? this.config.image));
    docker.push(...argv);
    return {
      name,
      argv,
      docker,
      image: String(image ?? this.config.image),
      network: resolvedNetwork,
      isolated,
      mounts: resolvedMounts,
      timeoutMs: Number(timeoutMs ?? this.config.timeout_ms)
    };
  }

  record(plan, outcome, { source, verdict }) {
    this.audit?.record({
      actor: source,
      tool: "sandbox",
      action: "sandbox-exec",
      target: plan ? plan.argv.join(" ").slice(0, 300) : null,
      riskLevel: plan && !plan.isolated ? "L3" : "L2",
      approval: "policy",
      result: outcome,
      metadata: plan
        ? { image: plan.image, network: plan.network, mounts: plan.mounts.map((mount) => mount.target + (mount.readOnly ? ":ro" : ":rw")), relaxed: Boolean(verdict?.relaxed) }
        : {}
    });
  }

  /**
   * Run a command in a throwaway container. Resolves to
   * { ok, exitCode, stdout, stderr, durationMs, timedOut, denied, reason }.
   */
  async exec(options = {}) {
    const source = options.source ?? "cli";
    let plan = null;
    try {
      plan = this.plan(options);
    } catch (error) {
      this.record(null, "invalid: " + error.message, { source });
      return { ok: false, denied: true, reason: error.message, exitCode: null, stdout: "", stderr: "", durationMs: 0, timedOut: false };
    }
    const verdict = this.check(plan.argv, { isolated: plan.isolated });
    if (!verdict.allowed) {
      this.record(plan, "denied: " + verdict.reason, { source, verdict });
      this.eventBus?.emit("sandbox.denied", { argv: plan.argv, reason: verdict.reason });
      return { ok: false, denied: true, reason: verdict.reason, exitCode: null, stdout: "", stderr: "", durationMs: 0, timedOut: false, plan: publicPlan(plan) };
    }
    this.eventBus?.emit("sandbox.started", { name: plan.name, image: plan.image, network: plan.network });
    const started = Date.now();
    const [command, ...prefix] = this.docker;
    const outcome = await new Promise((resolveOutcome) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let child = null;
      const finish = (value) => {
        if (!settled) {
          settled = true;
          resolveOutcome(value);
        }
      };
      try {
        child = this.spawnImpl(command, [...prefix, ...plan.docker], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        finish({ exitCode: null, stdout, stderr: String(error.message), timedOut, error });
        return;
      }
      const limit = 4 * 1024 * 1024;
      child.stdout?.on("data", (chunk) => {
        if (stdout.length < limit) {
          stdout += chunk;
        }
      });
      child.stderr?.on("data", (chunk) => {
        if (stderr.length < limit) {
          stderr += chunk;
        }
      });
      const timer = setTimeout(() => {
        timedOut = true;
        // Kill the container itself, not only the CLI that is attached to it.
        this.dockerSync(["kill", plan.name], { timeoutMs: 10000 });
        child.kill();
      }, plan.timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        finish({ exitCode: null, stdout, stderr: stderr + String(error.message), timedOut, error });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        finish({ exitCode: code, stdout, stderr, timedOut });
      });
    });
    const durationMs = Date.now() - started;
    const scrub = (text) => redactResolvedSecrets(redactSecrets(String(text ?? "")));
    const result = {
      ok: outcome.exitCode === 0 && !outcome.timedOut,
      denied: false,
      exitCode: outcome.exitCode,
      stdout: scrub(outcome.stdout),
      stderr: scrub(outcome.stderr),
      durationMs,
      timedOut: outcome.timedOut,
      reason: outcome.error ? (outcome.error.code === "ENOENT" ? "Docker CLI is not installed" : outcome.error.message) : outcome.timedOut ? "timed out after " + plan.timeoutMs + "ms" : null,
      relaxed: Boolean(verdict.relaxed),
      plan: publicPlan(plan)
    };
    this.record(plan, (result.ok ? "exit 0" : "exit " + result.exitCode + (result.reason ? " (" + result.reason + ")" : "")) + " in " + durationMs + "ms", { source, verdict });
    this.eventBus?.emit(result.ok ? "sandbox.completed" : "sandbox.failed", { name: plan.name, exitCode: result.exitCode, durationMs });
    return result;
  }
}

function publicPlan(plan) {
  return { image: plan.image, network: plan.network, isolated: plan.isolated, argv: plan.argv, mounts: plan.mounts, docker: plan.docker };
}

/**
 * "src:dst" or "src:dst:rw". A Windows drive letter in the source is kept.
 */
export function parseMountSpec(spec) {
  const text = String(spec);
  const match = /^((?:[A-Za-z]:)?[^:]+):(\/[^:]*)(?::(ro|rw))?$/.exec(text);
  if (!match) {
    throw new Error("Mount must look like <source>:<target>[:ro|rw], got: " + text);
  }
  return { source: match[1], target: match[2], readOnly: match[3] !== "rw" };
}

/**
 * Used by the shell tool and command jobs when `sandbox.required_for` in the
 * automation policy matches: the command runs in the sandbox with its working
 * directory mounted read-only, or not at all (fail closed).
 */
export async function runRequiredSandbox(policy, { command, args = [], cwd = null, timeoutMs = null, source = "automation" } = {}) {
  const sandbox = policy?.sandboxEngine ?? null;
  if (!sandbox || typeof sandbox.exec !== "function") {
    return { ok: false, denied: true, exitCode: null, stdout: "", stderr: "", reason: "sandbox required by policy but the sandbox engine is not available" };
  }
  const mounts = cwd ? [{ source: cwd, target: "/work", readOnly: true, allowOutside: true }] : [];
  return sandbox.exec({ command, args, mounts, workdir: cwd ? "/work" : null, timeoutMs, source });
}
