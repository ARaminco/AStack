import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shortHash } from "../lib/text.mjs";

const REFERENCE = /^credential:\/\/([a-z0-9._-]+)\/([a-z0-9._-]+)$/i;

/**
 * Secret broker.
 *
 * Agents, skills, memories, prompts and logs only ever see a reference such as
 * `credential://emaratax/company-a`. The value itself is resolved at the last
 * possible moment, inside the tool that needs it, from an environment variable
 * or an owner managed local store, and every resolution is audited.
 *
 * The registry file holds metadata only: which references exist, where their
 * value comes from, who may use them and when they expire.
 */
export class SecretBroker {
  constructor(root, { clock, eventBus, audit = null, env = process.env } = {}) {
    this.root = root;
    this.directory = join(root, ".astack", "security");
    this.path = join(this.directory, "credentials.json");
    this.clock = clock ?? (() => new Date());
    this.eventBus = eventBus ?? null;
    this.audit = audit;
    this.env = env;
  }

  now() {
    return this.clock().toISOString();
  }

  read() {
    if (!existsSync(this.path)) {
      return { credentials: [] };
    }
    try {
      return JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      return { credentials: [] };
    }
  }

  write(state) {
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(this.path, JSON.stringify(state, null, 2) + "\n", "utf8");
    return state;
  }

  static parse(reference) {
    const match = REFERENCE.exec(String(reference ?? ""));
    if (!match) {
      throw new Error("Not a credential reference: " + reference + ". Expected credential://<provider>/<name>");
    }
    return { provider: match[1].toLowerCase(), name: match[2].toLowerCase() };
  }

  static envVariable(reference) {
    const { provider, name } = SecretBroker.parse(reference);
    return "ASTACK_CRED_" + provider.replace(/[^a-z0-9]/gi, "_").toUpperCase() + "_" + name.replace(/[^a-z0-9]/gi, "_").toUpperCase();
  }

  list() {
    return this.read().credentials.map((credential) => ({
      ...credential,
      available: this.available(credential.reference),
      value: undefined
    }));
  }

  /**
   * Register a reference. The value is never passed here: only where to find
   * it and who may use it.
   */
  register({ reference, description = "", source = "env", scope = [], site = null, owner = "owner", expiresAt = null }) {
    const { provider, name } = SecretBroker.parse(reference);
    const state = this.read();
    const record = {
      reference: "credential://" + provider + "/" + name,
      provider,
      name,
      description,
      source,
      envVariable: SecretBroker.envVariable(reference),
      scope,
      site,
      owner,
      expiresAt,
      createdAt: this.now(),
      lastUsedAt: null,
      uses: 0,
      fingerprint: null
    };
    state.credentials = [...state.credentials.filter((entry) => entry.reference !== record.reference), record];
    this.write(state);
    this.eventBus?.emit("secret.registered", { reference: record.reference, source });
    return { ...record, value: undefined };
  }

  get(reference) {
    const record = this.read().credentials.find((entry) => entry.reference === String(reference));
    if (!record) {
      throw new Error("Unknown credential reference: " + reference + ". Register it with: astack secret register " + reference);
    }
    return record;
  }

  available(reference) {
    try {
      const record = this.get(reference);
      if (record.source === "env") {
        return Boolean(this.env[record.envVariable]);
      }
      if (record.source === "file") {
        return existsSync(join(this.directory, "vault", record.provider + "." + record.name));
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Resolve a reference to its value. Callers must declare who is asking and
   * why; the value is returned to the caller and never written anywhere.
   */
  resolve(reference, { requester = "astack", purpose = "tool-use", scope = null, mission = null } = {}) {
    const record = this.get(reference);
    if (record.expiresAt && new Date(record.expiresAt).getTime() <= this.clock().getTime()) {
      throw new Error("Credential expired: " + reference);
    }
    if (record.scope?.length && scope && !record.scope.includes(scope)) {
      throw new Error("Credential " + reference + " is not scoped for " + scope);
    }
    let value = null;
    if (record.source === "env") {
      value = this.env[record.envVariable] ?? null;
    } else if (record.source === "file") {
      const path = join(this.directory, "vault", record.provider + "." + record.name);
      value = existsSync(path) ? readFileSync(path, "utf8").trim() : null;
    }
    if (!value) {
      throw new Error(
        "Credential " + reference + " has no value available. Set the environment variable " + record.envVariable + " and try again."
      );
    }
    const state = this.read();
    const index = state.credentials.findIndex((entry) => entry.reference === record.reference);
    state.credentials[index] = {
      ...record,
      uses: (record.uses ?? 0) + 1,
      lastUsedAt: this.now(),
      fingerprint: shortHash(value).slice(0, 8)
    };
    this.write(state);
    this.audit?.record({
      actor: requester,
      action: "credential-resolved",
      target: record.reference,
      riskLevel: "L3",
      approval: "policy",
      result: "delivered to " + requester + " for " + purpose,
      mission,
      metadata: { fingerprint: state.credentials[index].fingerprint }
    });
    this.eventBus?.emit("secret.resolved", { reference: record.reference, requester, purpose });
    return value;
  }

  /**
   * Metadata only. This is what an agent or a skill is allowed to see.
   */
  describe(reference) {
    const record = this.get(reference);
    return {
      reference: record.reference,
      provider: record.provider,
      name: record.name,
      description: record.description,
      site: record.site,
      scope: record.scope,
      available: this.available(reference),
      expiresAt: record.expiresAt,
      lastUsedAt: record.lastUsedAt,
      uses: record.uses
    };
  }

  remove(reference) {
    const state = this.read();
    const record = state.credentials.find((entry) => entry.reference === String(reference)) ?? null;
    state.credentials = state.credentials.filter((entry) => entry.reference !== String(reference));
    this.write(state);
    return record;
  }
}

export { REFERENCE };
