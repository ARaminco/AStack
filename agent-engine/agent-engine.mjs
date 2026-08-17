import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const agentStatuses = ["idle", "active", "paused", "retired"];
export const assignmentStatuses = ["scheduled", "dispatched", "done", "failed", "cancelled"];

const UNITS = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000, w: 7 * 24 * 60 * 60 * 1000 };

export function parseInterval(value) {
  const match = /^(\d+)([mhdw])$/.exec(String(value ?? "").trim());
  if (!match) {
    throw new Error("Invalid interval: " + value + ". Use forms like 30m, 4h, 1d, 1w");
  }
  return Number(match[1]) * UNITS[match[2]];
}

export class AgentEngine {
  constructor(root, { clock, memory, eventBus } = {}) {
    this.root = root;
    this.directory = join(root, ".astack", "agents");
    this.clock = clock ?? (() => new Date());
    this.memory = memory ?? null;
    this.eventBus = eventBus ?? null;
  }

  now() {
    return this.clock().toISOString();
  }

  list() {
    if (!existsSync(this.directory)) {
      return [];
    }
    return readdirSync(this.directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(this.directory, entry.name, "agent.json")))
      .map((entry) => this.get(entry.name));
  }

  get(id) {
    const path = join(this.directory, id, "agent.json");
    if (!existsSync(path)) {
      throw new Error("Unknown agent: " + id);
    }
    return JSON.parse(readFileSync(path, "utf8"));
  }

  save(agent) {
    const dir = join(this.directory, agent.id);
    mkdirSync(dir, { recursive: true });
    agent.updatedAt = this.now();
    writeFileSync(join(dir, "agent.json"), JSON.stringify(agent, null, 2) + "\n", "utf8");
    return agent;
  }

  create({ name, role, department = null, team = null, mission = "", provider = "claude-code" }) {
    if (!role) {
      throw new Error("Agent requires a role");
    }
    const id = this.uniqueSlug(name ?? role);
    const agent = {
      id,
      name: name ?? role,
      role,
      department,
      team,
      mission,
      provider,
      status: "idle",
      createdAt: this.now(),
      assignments: [],
      counters: { assignment: 0, run: 0 },
      events: []
    };
    this.record(agent, "agent-created", { role, team });
    this.save(agent);
    this.eventBus?.emit("agent.created", { agentId: id, role, team });
    return agent;
  }

  uniqueSlug(name) {
    const base = slug(name);
    if (!existsSync(join(this.directory, base, "agent.json"))) {
      return base;
    }
    let counter = 2;
    while (existsSync(join(this.directory, base + "-" + counter, "agent.json"))) {
      counter += 1;
    }
    return base + "-" + counter;
  }

  record(agent, type, payload = {}) {
    agent.events.push({ at: this.now(), type, ...payload });
  }

  brief(id, mission) {
    const agent = this.get(id);
    agent.mission = mission;
    this.record(agent, "briefed", {});
    this.save(agent);
    return agent;
  }

  assign(id, { objective, every = null, at = null, deliverable = null, priority = "normal" }) {
    if (!objective) {
      throw new Error("Assignment requires an objective");
    }
    const everyMs = every ? parseInterval(every) : null;
    const agent = this.get(id);
    if (agent.status === "retired") {
      throw new Error("Agent is retired: " + id);
    }
    agent.counters.assignment += 1;
    const first = at ? new Date(at).toISOString() : this.now();
    const assignment = {
      id: "A-" + agent.counters.assignment,
      objective,
      deliverable,
      priority,
      schedule: { every, at: at ?? null, next: first },
      status: "scheduled",
      createdAt: this.now(),
      runs: []
    };
    if (everyMs !== null && everyMs <= 0) {
      throw new Error("Interval must be positive");
    }
    agent.assignments.push(assignment);
    if (agent.status === "idle") {
      agent.status = "active";
    }
    this.record(agent, "assigned", { assignmentId: assignment.id });
    this.save(agent);
    this.eventBus?.emit("agent.assigned", { agentId: id, assignmentId: assignment.id });
    return assignment;
  }

  cancel(id, assignmentId) {
    const agent = this.get(id);
    const assignment = requireAssignment(agent, assignmentId);
    assignment.status = "cancelled";
    this.record(agent, "assignment-cancelled", { assignmentId });
    this.save(agent);
    return assignment;
  }

  due({ asOf } = {}) {
    const cutoff = new Date(asOf ?? this.now()).getTime();
    const results = [];
    for (const agent of this.list()) {
      if (agent.status !== "active") {
        continue;
      }
      for (const assignment of agent.assignments) {
        if (assignment.status === "scheduled" && new Date(assignment.schedule.next).getTime() <= cutoff) {
          results.push({ agent, assignment });
        }
      }
    }
    return results;
  }

  runDue({ asOf } = {}) {
    const stamp = new Date(asOf ?? this.now()).toISOString();
    const dispatched = [];
    for (const { agent, assignment } of this.due({ asOf })) {
      const fresh = this.get(agent.id);
      const target = requireAssignment(fresh, assignment.id);
      fresh.counters.run += 1;
      const run = {
        id: "R-" + fresh.counters.run,
        assignmentId: target.id,
        startedAt: stamp,
        status: "open",
        summary: null,
        completedAt: null
      };
      const workOrder = this.writeWorkOrder(fresh, target, run);
      run.workOrder = workOrder;
      target.runs.push(run);
      target.status = "dispatched";
      this.record(fresh, "dispatched", { assignmentId: target.id, runId: run.id });
      this.save(fresh);
      this.memory?.append("agent", "[dispatch] agent=" + fresh.id + " assignment=" + target.id + " run=" + run.id);
      this.eventBus?.emit("agent.dispatched", { agentId: fresh.id, assignmentId: target.id, runId: run.id, workOrder });
      dispatched.push({ agentId: fresh.id, assignmentId: target.id, runId: run.id, workOrder });
    }
    return dispatched;
  }

  writeWorkOrder(agent, assignment, run) {
    const dir = join(this.directory, agent.id, "outbox");
    mkdirSync(dir, { recursive: true });
    const fileName = assignment.id + "-" + run.id + ".md";
    const lines = [
      "# Work Order " + assignment.id + "/" + run.id,
      "",
      "- Agent: " + agent.name + " (" + agent.role + ")",
      "- Team: " + (agent.team ?? "-"),
      "- Department: " + (agent.department ?? "-"),
      "- Priority: " + assignment.priority,
      "- Issued: " + run.startedAt,
      "- Provider: " + agent.provider,
      "",
      "## Mission Context",
      agent.mission || "-",
      "",
      "## Objective",
      assignment.objective,
      "",
      "## Expected Deliverable",
      assignment.deliverable ?? "A written result the team lead can review.",
      "",
      "## Reporting",
      "Run `astack agent report " + agent.id + " " + assignment.id + " --summary \"...\"` when the work is complete.",
      ""
    ];
    writeFileSync(join(dir, fileName), lines.join("\n"), "utf8");
    return [".astack", "agents", agent.id, "outbox", fileName].join("/");
  }

  report(id, assignmentId, { summary = "", result = "done" } = {}) {
    if (!["done", "failed"].includes(result)) {
      throw new Error("Report result must be done or failed");
    }
    const agent = this.get(id);
    const assignment = requireAssignment(agent, assignmentId);
    const run = [...assignment.runs].reverse().find((entry) => entry.status === "open");
    if (!run) {
      throw new Error("No open run for assignment " + assignmentId + " on agent " + id);
    }
    run.status = result;
    run.summary = summary;
    run.completedAt = this.now();
    if (assignment.schedule.every) {
      const everyMs = parseInterval(assignment.schedule.every);
      assignment.schedule.next = new Date(this.clock().getTime() + everyMs).toISOString();
      assignment.status = "scheduled";
    } else {
      assignment.status = result;
    }
    this.record(agent, "reported", { assignmentId, runId: run.id, result });
    this.save(agent);
    this.memory?.append("agent", "[report] agent=" + agent.id + " assignment=" + assignmentId + " result=" + result + (summary ? " summary=" + summary : ""));
    this.eventBus?.emit("agent.reported", { agentId: agent.id, assignmentId, result });
    return run;
  }

  setStatus(id, status) {
    if (!agentStatuses.includes(status)) {
      throw new Error("Unknown agent status: " + status + ". Use: " + agentStatuses.join(", "));
    }
    const agent = this.get(id);
    agent.status = status;
    this.record(agent, "status-changed", { status });
    this.save(agent);
    return agent;
  }

  pause(id) {
    return this.setStatus(id, "paused");
  }

  resume(id) {
    return this.setStatus(id, "active");
  }

  retire(id) {
    return this.setStatus(id, "retired");
  }

  openRuns() {
    const open = [];
    for (const agent of this.list()) {
      for (const assignment of agent.assignments) {
        for (const run of assignment.runs) {
          if (run.status === "open") {
            open.push({ agent, assignment, run });
          }
        }
      }
    }
    return open;
  }

  standup({ asOf } = {}) {
    const cutoff = new Date(asOf ?? this.now()).getTime();
    return this.list().map((agent) => {
      const openAssignments = agent.assignments.filter((entry) => ["scheduled", "dispatched"].includes(entry.status));
      const nextDue = openAssignments
        .filter((entry) => entry.status === "scheduled")
        .map((entry) => entry.schedule.next)
        .sort()[0] ?? null;
      const lastReport = agent.assignments
        .flatMap((entry) => entry.runs)
        .filter((run) => run.completedAt)
        .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))[0] ?? null;
      return {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        team: agent.team,
        status: agent.status,
        open: openAssignments.length,
        overdue: openAssignments.filter((entry) => entry.status === "scheduled" && new Date(entry.schedule.next).getTime() <= cutoff).length,
        nextDue,
        lastReport: lastReport ? { at: lastReport.completedAt, status: lastReport.status, summary: lastReport.summary } : null
      };
    });
  }

  workload(id) {
    const agent = this.get(id);
    const byStatus = {};
    for (const status of assignmentStatuses) {
      byStatus[status] = agent.assignments.filter((entry) => entry.status === status).length;
    }
    return { agentId: id, total: agent.assignments.length, byStatus };
  }
}

function requireAssignment(agent, assignmentId) {
  const assignment = agent.assignments.find((entry) => entry.id === assignmentId);
  if (!assignment) {
    throw new Error("Unknown assignment on agent " + agent.id + ": " + assignmentId);
  }
  return assignment;
}

function slug(name) {
  const value = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!value) {
    throw new Error("Agent name must contain latin letters or digits");
  }
  return value;
}
