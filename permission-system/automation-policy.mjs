import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";

const DEFAULT_POLICY = {
  commands: {
    mode: "allowlist",
    allow: ["node", "npm", "git", "astack"],
    deny: ["rm", "rmdir", "del", "format", "mkfs", "shutdown", "reboot", "curl", "wget", "powershell", "bash"]
  },
  network: {
    mode: "allow",
    allowHosts: [],
    denyHosts: [],
    allowPrivateNetworks: false
  },
  actions: {
    allow: ["notify", "record-episode", "memory-append", "create-mission", "create-work-item", "assign-agent", "run-job", "open-incident", "browser-task"],
    confirm: ["run-command", "delete", "publish"]
  }
};

const EVAL_FLAGS = {
  node: ["-e", "--eval", "-p", "--print", "--input-type"],
  python: ["-c"],
  python3: ["-c"],
  perl: ["-e"],
  ruby: ["-e"],
  php: ["-r"],
  deno: ["eval"],
  bun: ["-e"]
};

const INTERNAL_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "metadata", "metadata.google.internal"]);

/**
 * Loopback, private, link-local, carrier-grade NAT and cloud metadata
 * addresses, in both address families. The cloud metadata endpoint is the one
 * an unattended job is most likely to be pointed at by mistake.
 */
function unwrapMappedIPv4(host) {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
  if (dotted) {
    return dotted[1];
  }
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (hex) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }
  return host;
}

function isInternalHost(host) {
  if (!host || INTERNAL_NAMES.has(host) || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    return true;
  }
  // A URL normalises ::ffff:127.0.0.1 to ::ffff:7f00:1, so both spellings of an
  // IPv4 mapped address have to be decoded back to the address they carry.
  const candidate = unwrapMappedIPv4(host);
  const version = isIP(candidate);
  if (version === 4) {
    const parts = candidate.split(".").map(Number);
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return true;
    }
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 127 ||
      a === 10 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (version === 6) {
    const value = candidate.toLowerCase();
    return (
      value === "::" ||
      value === "::1" ||
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      value.startsWith("fe80") ||
      value.startsWith("ff")
    );
  }
  return false;
}

/**
 * Least privilege for everything that runs without a human in the loop:
 * scheduled jobs, webhook reactions and browser automation.
 *
 * The defaults deny shell execution unless a command is allowlisted and deny
 * private network targets, because a background job and an inbound webhook are
 * exactly the two places where a mistake runs unattended.
 */
export class AutomationPolicy {
  constructor(root, { policy = null } = {}) {
    this.root = root;
    this.path = join(root, ".astack", "security", "automation.json");
    this.policy = policy ?? this.load();
  }

  load() {
    if (!existsSync(this.path)) {
      return structuredClone(DEFAULT_POLICY);
    }
    try {
      const stored = JSON.parse(readFileSync(this.path, "utf8"));
      return {
        commands: { ...DEFAULT_POLICY.commands, ...(stored.commands ?? {}) },
        network: { ...DEFAULT_POLICY.network, ...(stored.network ?? {}) },
        actions: { ...DEFAULT_POLICY.actions, ...(stored.actions ?? {}) }
      };
    } catch {
      return structuredClone(DEFAULT_POLICY);
    }
  }

  save(policy = this.policy) {
    mkdirSync(join(this.root, ".astack", "security"), { recursive: true });
    writeFileSync(this.path, JSON.stringify(policy, null, 2) + "\n", "utf8");
    this.policy = policy;
    return this.path;
  }

  allowCommand(command) {
    const raw = String(command ?? "").trim();
    if (!raw) {
      return { allowed: false, reason: "No command given." };
    }
    // A command string is a single program, never a shell fragment: chaining,
    // piping, substitution and redirection are how an allowlist gets walked past.
    if (/[;&|`$\n\r><]/.test(raw)) {
      return { allowed: false, reason: "Command contains shell control characters: " + raw.slice(0, 60) };
    }
    const first = raw.split(/\s+/)[0];
    const binary = first.split(/[/\\]+/).filter(Boolean).pop() ?? "";
    const normalized = binary.toLowerCase().replace(/\.(exe|cmd|bat|ps1|sh)$/, "");
    if (!normalized) {
      return { allowed: false, reason: "No command given." };
    }
    if ((this.policy.commands.deny ?? []).includes(normalized)) {
      return { allowed: false, reason: "Command is on the deny list: " + normalized };
    }
    if (this.policy.commands.mode === "allowlist" && !(this.policy.commands.allow ?? []).includes(normalized)) {
      return {
        allowed: false,
        reason: "Command is not allowlisted: " + normalized + ". Add it with: astack schedule policy allow-command " + normalized
      };
    }
    return { allowed: true, reason: "Command is allowed.", binary: normalized };
  }

  /**
   * The arguments matter as much as the binary: an allowlisted interpreter
   * handed an inline script is arbitrary code execution.
   */
  allowInvocation(command, args = []) {
    const verdict = this.allowCommand(command);
    if (!verdict.allowed) {
      return verdict;
    }
    const evalFlags = EVAL_FLAGS[verdict.binary] ?? [];
    const offending = (args ?? []).map((argument) => String(argument)).find((argument) => evalFlags.includes(argument.toLowerCase()));
    if (offending) {
      return {
        allowed: false,
        reason: "Inline script execution is not allowed for " + verdict.binary + " (" + offending + "). Run a file instead."
      };
    }
    for (const argument of args ?? []) {
      if (/[;&|`$\n\r]/.test(String(argument))) {
        return { allowed: false, reason: "Argument contains shell control characters: " + String(argument).slice(0, 60) };
      }
    }
    return verdict;
  }

  allowHost(url) {
    let parsed = null;
    try {
      parsed = new URL(String(url));
    } catch {
      return { allowed: false, reason: "Invalid URL: " + url };
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { allowed: false, reason: "Only http and https targets are allowed." };
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if ((this.policy.network.denyHosts ?? []).some((entry) => host === entry || host.endsWith("." + entry))) {
      return { allowed: false, reason: "Host is on the deny list: " + host };
    }
    if (isInternalHost(host) && !this.policy.network.allowPrivateNetworks) {
      return {
        allowed: false,
        reason: "Internal and link-local targets are disabled (" + host + "). Enable deliberately with: astack schedule policy allow-private"
      };
    }
    const allow = this.policy.network.allowHosts ?? [];
    if (this.policy.network.mode === "allowlist" && !allow.some((entry) => host === entry || host.endsWith("." + entry))) {
      return { allowed: false, reason: "Host is not allowlisted: " + host };
    }
    return { allowed: true, reason: "Host is allowed.", host };
  }

  allowAction(action) {
    if ((this.policy.actions.allow ?? []).includes(action)) {
      return { allowed: true, reason: "Action is allowed." };
    }
    if ((this.policy.actions.confirm ?? []).includes(action)) {
      return { allowed: false, reason: "Action needs owner confirmation: " + action };
    }
    return { allowed: false, reason: "Unknown automation action: " + action };
  }

  allowCommandPermanently(command) {
    const policy = this.load();
    policy.commands.allow = [...new Set([...(policy.commands.allow ?? []), String(command).toLowerCase()])];
    return this.save(policy);
  }

  allowHostPermanently(host) {
    const policy = this.load();
    policy.network.allowHosts = [...new Set([...(policy.network.allowHosts ?? []), String(host).toLowerCase()])];
    return this.save(policy);
  }

  allowActionPermanently(action) {
    const policy = this.load();
    policy.actions.allow = [...new Set([...(policy.actions.allow ?? []), String(action)])];
    policy.actions.confirm = (policy.actions.confirm ?? []).filter((entry) => entry !== action);
    return this.save(policy);
  }
}

export { DEFAULT_POLICY };
