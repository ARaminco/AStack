import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { shortHash } from "../lib/text.mjs";

export const approvalStates = ["pending", "approved", "rejected", "expired", "consumed"];

const HOUR = 60 * 60 * 1000;

/**
 * Human in the loop, made durable.
 *
 * A request describes exactly what will happen if the owner says yes: the
 * action, its parameters, the evidence gathered so far and the mission it
 * belongs to. The answer becomes a receipt with a scope and an expiry, and it
 * authorizes that action only — never the next one.
 */
export class ApprovalEngine {
  constructor(root, { clock, eventBus, audit = null } = {}) {
    this.root = root;
    this.directory = join(root, ".astack", "approvals");
    this.path = join(this.directory, "requests.jsonl");
    this.clock = clock ?? (() => new Date());
    this.eventBus = eventBus ?? null;
    this.audit = audit;
  }

  now() {
    return this.clock().toISOString();
  }

  all() {
    if (!existsSync(this.path)) {
      return [];
    }
    const merged = new Map();
    for (const line of readFileSync(this.path, "utf8").split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const record = JSON.parse(line);
        merged.set(record.id, { ...(merged.get(record.id) ?? {}), ...record });
      } catch {
        continue;
      }
    }
    return [...merged.values()];
  }

  write(record) {
    mkdirSync(this.directory, { recursive: true });
    appendFileSync(this.path, JSON.stringify(record) + "\n", "utf8");
    return record;
  }

  get(id) {
    const record = this.all().find((entry) => entry.id === id);
    if (!record) {
      throw new Error("Unknown approval request: " + id);
    }
    return this.refresh(record);
  }

  refresh(record) {
    if (record.state === "pending" && record.expiresAt && new Date(record.expiresAt).getTime() <= this.clock().getTime()) {
      return this.write({ ...record, state: "expired", updatedAt: this.now() });
    }
    return record;
  }

  list({ state = null, mission = null, limit = 50 } = {}) {
    return this.all()
      .map((record) => this.refresh(record))
      .filter((record) => !state || record.state === state)
      .filter((record) => !mission || record.mission === mission)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  }

  request({
    action,
    summary,
    parameters = {},
    level = "L4",
    mission = null,
    project = null,
    tool = null,
    target = null,
    evidence = [],
    risk = null,
    expiresInMs = 24 * HOUR,
    requestedBy = "astack"
  }) {
    if (!action) {
      throw new Error("An approval request needs an action");
    }
    const createdAt = this.now();
    const record = {
      // Two requests for the same action in the same instant must not share
      // an id: the second would overwrite the first, approval and all.
      id: "AP-" + shortHash(action, target ?? "", createdAt, randomBytes(6).toString("hex")).slice(0, 10),
      action,
      summary: summary ?? action,
      parameters,
      level,
      mission,
      project,
      tool,
      target,
      evidence,
      risk,
      requestedBy,
      state: "pending",
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(new Date(createdAt).getTime() + expiresInMs).toISOString(),
      decidedAt: null,
      decidedBy: null,
      note: null,
      receipt: null
    };
    this.write(record);
    this.eventBus?.emit("approval.requested", { id: record.id, action, level, mission });
    this.audit?.record({
      actor: requestedBy,
      action: "approval-requested",
      target: target ?? action,
      tool,
      riskLevel: level,
      approval: "pending",
      result: record.id,
      mission,
      project
    });
    return record;
  }

  decide(id, { approve, by = "owner", note = null, scope = "single-action", extendMs = 0 }) {
    const record = this.get(id);
    if (record.state !== "pending") {
      throw new Error("Approval " + id + " is already " + record.state);
    }
    const decidedAt = this.now();
    const receipt = approve
      ? {
          id: "RC-" + shortHash(record.id, decidedAt).slice(0, 10),
          approvedAt: decidedAt,
          approvedBy: by,
          action: record.action,
          parameters: record.parameters,
          scope,
          mission: record.mission,
          expiresAt: new Date(new Date(decidedAt).getTime() + (extendMs || 2 * HOUR)).toISOString()
        }
      : null;
    const updated = {
      ...record,
      state: approve ? "approved" : "rejected",
      decidedAt,
      decidedBy: by,
      note,
      receipt,
      updatedAt: decidedAt
    };
    this.write(updated);
    this.eventBus?.emit(approve ? "approval.granted" : "approval.rejected", { id, action: record.action, by });
    this.audit?.record({
      actor: by,
      action: approve ? "approval-granted" : "approval-rejected",
      target: record.target ?? record.action,
      tool: record.tool,
      riskLevel: record.level,
      approval: approve ? "granted" : "rejected",
      result: receipt?.id ?? "rejected",
      mission: record.mission,
      project: record.project
    });
    return updated;
  }

  approve(id, options = {}) {
    return this.decide(id, { ...options, approve: true });
  }

  reject(id, options = {}) {
    return this.decide(id, { ...options, approve: false });
  }

  /**
   * A receipt authorizes one action once. Consuming it makes it unusable, so a
   * single "yes" can never be replayed for a second submission.
   */
  consume(id, { by = "astack" } = {}) {
    const record = this.get(id);
    if (record.state !== "approved") {
      throw new Error("Approval " + id + " is " + record.state + ", not approved");
    }
    if (record.receipt?.expiresAt && new Date(record.receipt.expiresAt).getTime() <= this.clock().getTime()) {
      this.write({ ...record, state: "expired", updatedAt: this.now() });
      throw new Error("Approval " + id + " expired before it was used");
    }
    const consumed = { ...record, state: "consumed", consumedAt: this.now(), consumedBy: by, updatedAt: this.now() };
    this.write(consumed);
    this.eventBus?.emit("approval.consumed", { id, action: record.action });
    return consumed;
  }

  isAuthorized({ action, mission = null }) {
    return this.list({ state: "approved", mission }).find((record) => record.action === action) ?? null;
  }

  pending() {
    return this.list({ state: "pending" });
  }
}
