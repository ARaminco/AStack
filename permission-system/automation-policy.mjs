import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const PRIVATE_HOST = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|\[::1\])/i;

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
    const binary = String(command ?? "").trim().split(/[\s/\\]+/).filter(Boolean).pop() ?? "";
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
    return { allowed: true, reason: "Command is allowed." };
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
    const host = parsed.hostname;
    if ((this.policy.network.denyHosts ?? []).some((entry) => host === entry || host.endsWith("." + entry))) {
      return { allowed: false, reason: "Host is on the deny list: " + host };
    }
    if (PRIVATE_HOST.test(host) && !this.policy.network.allowPrivateNetworks) {
      return { allowed: false, reason: "Private network targets are disabled. Enable with: astack schedule policy allow-private" };
    }
    const allow = this.policy.network.allowHosts ?? [];
    if (this.policy.network.mode === "allowlist" && !allow.some((entry) => host === entry || host.endsWith("." + entry))) {
      return { allowed: false, reason: "Host is not allowlisted: " + host };
    }
    return { allowed: true, reason: "Host is allowed." };
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
