import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets, shortHash } from "../lib/text.mjs";

/**
 * Append only audit trail for everything that touches the world.
 *
 * One record per meaningful action, with the actor, the tool, the target, the
 * authority level it ran under, whether an owner approved it, the result and
 * links to the evidence that proves it happened.
 */
export class AuditEngine {
  constructor(root, { clock, eventBus } = {}) {
    this.root = root;
    this.directory = join(root, ".astack", "audit");
    this.clock = clock ?? (() => new Date());
    this.eventBus = eventBus ?? null;
  }

  now() {
    return this.clock().toISOString();
  }

  path(date = null) {
    const stamp = String(date ?? this.now()).slice(0, 7);
    return join(this.directory, "audit-" + stamp + ".jsonl");
  }

  record({
    actor = "astack",
    agent = null,
    team = null,
    project = null,
    mission = null,
    tool = null,
    action,
    target = null,
    riskLevel = "L1",
    approval = "not-required",
    result = null,
    evidence = [],
    metadata = {}
  }) {
    if (!action) {
      throw new Error("An audit record needs an action");
    }
    const timestamp = this.now();
    const entry = {
      id: "AU-" + shortHash(action, target ?? "", timestamp).slice(0, 10),
      timestamp,
      actor,
      agent,
      team,
      project,
      mission,
      tool,
      action,
      target: target ? redactSecrets(String(target)).slice(0, 400) : null,
      riskLevel,
      approval,
      result: result ? redactSecrets(String(result)).slice(0, 1000) : null,
      evidence,
      metadata
    };
    mkdirSync(this.directory, { recursive: true });
    appendFileSync(this.path(timestamp), JSON.stringify(entry) + "\n", "utf8");
    this.eventBus?.emit("audit.recorded", { id: entry.id, action, riskLevel, approval });
    return entry;
  }

  months() {
    if (!existsSync(this.directory)) {
      return [];
    }
    return readdirSync(this.directory)
      .filter((name) => name.startsWith("audit-") && name.endsWith(".jsonl"))
      .map((name) => name.slice(6, -6))
      .sort()
      .reverse();
  }

  list({ limit = 50, action = null, mission = null, project = null, month = null, riskLevel = null } = {}) {
    const targets = month ? [month] : this.months();
    const entries = [];
    for (const stamp of targets) {
      const path = join(this.directory, "audit-" + stamp + ".jsonl");
      if (!existsSync(path)) {
        continue;
      }
      for (const line of readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean)) {
        try {
          entries.push(JSON.parse(line));
        } catch {
          continue;
        }
      }
    }
    return entries
      .filter((entry) => !action || entry.action === action)
      .filter((entry) => !mission || entry.mission === mission)
      .filter((entry) => !project || entry.project === project)
      .filter((entry) => !riskLevel || entry.riskLevel === riskLevel)
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
      .slice(0, limit);
  }

  get(id) {
    for (const stamp of this.months()) {
      const path = join(this.directory, "audit-" + stamp + ".jsonl");
      for (const line of readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean)) {
        try {
          const entry = JSON.parse(line);
          if (entry.id === id) {
            return entry;
          }
        } catch {
          continue;
        }
      }
    }
    return null;
  }

  stats({ month = null } = {}) {
    const entries = this.list({ limit: 100000, month });
    const byAction = {};
    const byRisk = {};
    for (const entry of entries) {
      byAction[entry.action] = (byAction[entry.action] ?? 0) + 1;
      byRisk[entry.riskLevel] = (byRisk[entry.riskLevel] ?? 0) + 1;
    }
    return {
      records: entries.length,
      approved: entries.filter((entry) => entry.approval === "granted").length,
      withEvidence: entries.filter((entry) => (entry.evidence ?? []).length > 0).length,
      byAction,
      byRisk,
      lastAt: entries[0]?.timestamp ?? null
    };
  }
}
