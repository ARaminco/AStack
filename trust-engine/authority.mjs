import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const authorityLevels = ["L0", "L1", "L2", "L3", "L4", "L5"];

export const authorityMeaning = {
  L0: { en: "no external action", fa: "بدون هیچ اقدام بیرونی" },
  L1: { en: "read and search only", fa: "فقط خواندن و جست‌وجو" },
  L2: { en: "create a draft", fa: "ساخت پیش‌نویس" },
  L3: { en: "modify or fill, never commit", fa: "تغییر و تکمیل بدون ثبت نهایی" },
  L4: { en: "commit only with owner approval", fa: "ثبت نهایی فقط با تأیید مالک" },
  L5: { en: "approved autonomous execution", fa: "اجرای خودکار مجاز" }
};

const DEFAULT_POLICY = {
  defaultLevel: "L2",
  autonomous: ["L0", "L1", "L2"],
  requireApproval: ["L4"],
  domains: {},
  tools: {},
  sites: {},
  deny: { global: [], domains: {}, tools: {}, sites: {} }
};

export function levelValue(level) {
  const index = authorityLevels.indexOf(String(level));
  if (index === -1) {
    throw new Error("Unknown authority level: " + level + ". Use: " + authorityLevels.join(", "));
  }
  return index;
}

/**
 * The authority engine answers one question before anything touches the world:
 * may this run now, may it run after the owner approves, or may it not run.
 *
 * Policy can be set globally and narrowed per domain, per tool and per site,
 * so "read anything, fill any form, never submit on the tax portal without me"
 * is expressible without code changes.
 */
export class AuthorityEngine {
  constructor(root, { clock, eventBus, policy = null } = {}) {
    this.root = root;
    this.path = join(root, ".astack", "security", "authority.json");
    this.clock = clock ?? (() => new Date());
    this.eventBus = eventBus ?? null;
    this.policy = policy ?? this.load();
  }

  load() {
    if (!existsSync(this.path)) {
      return structuredClone(DEFAULT_POLICY);
    }
    try {
      return { ...structuredClone(DEFAULT_POLICY), ...JSON.parse(readFileSync(this.path, "utf8")) };
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

  ceilingFor({ domain = null, tool = null, site = null } = {}) {
    const candidates = [this.policy.defaultLevel];
    if (domain && this.policy.domains?.[domain]) {
      candidates.push(this.policy.domains[domain]);
    }
    if (tool && this.policy.tools?.[tool]) {
      candidates.push(this.policy.tools[tool]);
    }
    if (site) {
      const host = normalizeHost(site);
      for (const [pattern, level] of Object.entries(this.policy.sites ?? {})) {
        if (host === pattern || host.endsWith("." + pattern)) {
          candidates.push(level);
        }
      }
    }
    return candidates.reduce((highest, level) => (levelValue(level) > levelValue(highest) ? level : highest), "L0");
  }

  /**
   * Decide whether an action can proceed.
   *
   * The ceiling is the highest level that may run on its own in this scope.
   * Anything above it is not forbidden — it is escalated to the owner. Only a
   * level on the deny list is refused outright, which is how "never on this
   * site" is expressed.
   */
  evaluate({ action = "action", level = "L1", domain = null, tool = null, site = null, mission = null } = {}) {
    const required = String(level);
    levelValue(required);
    const ceiling = this.ceilingFor({ domain, tool, site });
    const requireApproval = this.policy.requireApproval ?? DEFAULT_POLICY.requireApproval;
    const denied = this.denyFor({ domain, tool, site }).includes(required);
    const aboveCeiling = levelValue(required) > levelValue(ceiling);
    const needsApproval = !denied && (requireApproval.includes(required) || aboveCeiling);
    const decision = {
      action,
      level: required,
      ceiling,
      domain,
      tool,
      site,
      mission,
      allowed: !denied && !needsApproval,
      requiresApproval: needsApproval,
      blocked: denied,
      meaning: authorityMeaning[required]?.fa ?? required,
      reason: denied
        ? "authority " + required + " is denied for this scope"
        : aboveCeiling
          ? "authority " + required + " is above the autonomous ceiling " + ceiling + " and needs owner approval"
          : requireApproval.includes(required)
            ? "authority " + required + " always requires owner approval"
            : "authority " + required + " is inside the autonomous range"
    };
    this.eventBus?.emit("authority.evaluated", { action, level: required, allowed: decision.allowed, requiresApproval: decision.requiresApproval });
    return decision;
  }

  denyFor({ domain = null, tool = null, site = null } = {}) {
    const denied = new Set(this.policy.deny?.global ?? []);
    for (const [scope, key] of [["domains", domain], ["tools", tool], ["sites", site ? normalizeHost(site) : null]]) {
      if (!key) {
        continue;
      }
      for (const level of this.policy.deny?.[scope]?.[key] ?? []) {
        denied.add(level);
      }
    }
    return [...denied];
  }

  /**
   * Refuse a level outright for a scope, whatever the ceiling says.
   */
  deny(kind, key, levels) {
    const policy = this.load();
    policy.deny = policy.deny ?? { global: [], domains: {}, tools: {}, sites: {} };
    const list = Array.isArray(levels) ? levels : [levels];
    for (const level of list) {
      levelValue(level);
    }
    if (kind === "global") {
      policy.deny.global = [...new Set([...(policy.deny.global ?? []), ...list])];
    } else {
      const bucket = kind === "sites" ? normalizeHost(key) : key;
      policy.deny[kind] = { ...(policy.deny[kind] ?? {}), [bucket]: [...new Set([...(policy.deny[kind]?.[bucket] ?? []), ...list])] };
    }
    this.save(policy);
    return policy;
  }

  setDefault(level) {
    levelValue(level);
    const policy = this.load();
    policy.defaultLevel = level;
    this.save(policy);
    return policy;
  }

  setScope(kind, key, level) {
    levelValue(level);
    if (!["domains", "tools", "sites"].includes(kind)) {
      throw new Error("Authority scope must be domains, tools or sites");
    }
    const policy = this.load();
    policy[kind] = { ...(policy[kind] ?? {}), [kind === "sites" ? normalizeHost(key) : key]: level };
    this.save(policy);
    return policy;
  }

  describe() {
    return {
      defaultLevel: this.policy.defaultLevel,
      autonomous: this.policy.autonomous,
      requireApproval: this.policy.requireApproval,
      domains: this.policy.domains ?? {},
      tools: this.policy.tools ?? {},
      sites: this.policy.sites ?? {},
      deny: this.policy.deny ?? { global: [], domains: {}, tools: {}, sites: {} },
      levels: authorityLevels.map((level) => ({ level, meaning: authorityMeaning[level].fa }))
    };
  }
}

function normalizeHost(value) {
  try {
    return new URL(String(value)).hostname.toLowerCase();
  } catch {
    return String(value).toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
  }
}

export { DEFAULT_POLICY };
