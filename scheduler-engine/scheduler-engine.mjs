import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { slugify } from "../lib/text.mjs";
import { AutomationPolicy } from "../permission-system/automation-policy.mjs";
import { describeSchedule, nextRun, parseInterval } from "./cron.mjs";
import { handlers, jobKinds } from "./monitors.mjs";

export const jobStatuses = ["idle", "running", "ok", "failed", "disabled"];

const DEFAULT_POLICY = {
  timeoutMs: 30000,
  retries: 1,
  backoffMs: 15000,
  catchUp: false,
  jitterMs: 0
};

const DEFAULT_ALERT = {
  failuresBefore: 2,
  notifyOnRecovery: true,
  escalateToAgent: null
};

/**
 * Background operations for the whole platform.
 *
 * One store holds every kind of unattended work: watching a web service every
 * ten minutes, dispatching agent missions, refreshing the context map, mining
 * skills, consolidating memory, processing inbound webhooks and driving the
 * internal browser. Jobs keep their own run history, retry with backoff, open
 * an incident when they keep failing and close it when they recover.
 */
export class SchedulerEngine {
  constructor(root, { clock, eventBus, services = {}, policy = null } = {}) {
    this.root = root;
    this.directory = join(root, ".astack", "scheduler");
    this.jobsDirectory = join(this.directory, "jobs");
    this.runsDirectory = join(this.directory, "runs");
    this.clock = clock ?? (() => new Date());
    this.eventBus = eventBus ?? null;
    this.services = services;
    this.policy = policy ?? new AutomationPolicy(root);
  }

  now() {
    return this.clock().toISOString();
  }

  kinds() {
    return [...jobKinds];
  }

  list({ kind = null, enabled = null, tag = null } = {}) {
    if (!existsSync(this.jobsDirectory)) {
      return [];
    }
    return readdirSync(this.jobsDirectory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.read(name.replace(/\.json$/, "")))
      .filter((job) => !kind || job.kind === kind)
      .filter((job) => enabled === null || job.enabled === enabled)
      .filter((job) => !tag || (job.tags ?? []).includes(tag))
      .sort((a, b) => String(a.state.next ?? "").localeCompare(String(b.state.next ?? "")) || a.id.localeCompare(b.id));
  }

  path(id) {
    return join(this.jobsDirectory, id + ".json");
  }

  read(id) {
    const path = this.path(id);
    if (!existsSync(path)) {
      throw new Error("Unknown job: " + id);
    }
    return JSON.parse(readFileSync(path, "utf8"));
  }

  exists(id) {
    return existsSync(this.path(id));
  }

  save(job) {
    mkdirSync(this.jobsDirectory, { recursive: true });
    job.updatedAt = this.now();
    writeFileSync(this.path(job.id), JSON.stringify(job, null, 2) + "\n", "utf8");
    return job;
  }

  create({ id = null, name, kind, schedule = {}, payload = {}, policy = {}, alert = {}, tags = [], domain = null, project = null, enabled = true } = {}) {
    if (!jobKinds.includes(kind)) {
      throw new Error("Unknown job kind: " + kind + ". Use: " + jobKinds.join(", "));
    }
    if (!name) {
      throw new Error("A job needs a name");
    }
    const jobId = this.uniqueId(id ?? name);
    if (schedule.every) {
      parseInterval(schedule.every);
    }
    const job = {
      id: jobId,
      name,
      kind,
      enabled,
      domain,
      project,
      tags,
      schedule,
      payload,
      policy: { ...DEFAULT_POLICY, ...policy },
      alert: { ...DEFAULT_ALERT, ...alert },
      createdAt: this.now(),
      updatedAt: this.now(),
      state: {
        next: schedule.at ? new Date(schedule.at).toISOString() : nextRun(schedule, { from: this.clock() }),
        last: null,
        lastStatus: null,
        consecutiveFailures: 0,
        attempt: 0,
        runs: 0,
        successes: 0,
        failures: 0,
        incident: null
      },
      history: []
    };
    this.save(job);
    this.eventBus?.emit("scheduler.job.created", { id: job.id, kind, schedule: describeSchedule(schedule) });
    return job;
  }

  uniqueId(base) {
    const slug = slugify(base, { fallback: "job" });
    if (!this.exists(slug)) {
      return slug;
    }
    let counter = 2;
    while (this.exists(slug + "-" + counter)) {
      counter += 1;
    }
    return slug + "-" + counter;
  }

  update(id, patch = {}) {
    const job = this.read(id);
    const next = {
      ...job,
      ...patch,
      id: job.id,
      schedule: { ...job.schedule, ...(patch.schedule ?? {}) },
      payload: { ...job.payload, ...(patch.payload ?? {}) },
      policy: { ...job.policy, ...(patch.policy ?? {}) },
      alert: { ...job.alert, ...(patch.alert ?? {}) },
      state: job.state
    };
    if (patch.schedule) {
      next.state = { ...next.state, next: nextRun(next.schedule, { from: this.clock() }) };
    }
    return this.save(next);
  }

  setEnabled(id, enabled) {
    const job = this.read(id);
    job.enabled = Boolean(enabled);
    if (job.enabled && !job.state.next) {
      job.state.next = nextRun(job.schedule, { from: this.clock() });
    }
    this.eventBus?.emit("scheduler.job." + (enabled ? "enabled" : "disabled"), { id });
    return this.save(job);
  }

  remove(id) {
    const job = this.read(id);
    rmSync(this.path(id), { force: true });
    this.eventBus?.emit("scheduler.job.removed", { id });
    return job;
  }

  due({ asOf = null } = {}) {
    const cutoff = new Date(asOf ?? this.now()).getTime();
    return this.list({ enabled: true }).filter((job) => job.state.next && new Date(job.state.next).getTime() <= cutoff);
  }

  /**
   * Execute one job now, regardless of its schedule.
   */
  async runJob(id, { asOf = null, manual = false } = {}) {
    const job = this.read(id);
    const handler = handlers[job.kind];
    if (!handler) {
      throw new Error("No handler for job kind: " + job.kind);
    }
    const startedAt = new Date(asOf ?? this.now()).toISOString();
    const started = Date.now();
    this.eventBus?.emit("scheduler.run.started", { id: job.id, kind: job.kind, manual });
    let outcome = null;
    try {
      outcome = await handler(job, { root: this.root, services: this.services, policy: this.policy, clock: this.clock });
    } catch (error) {
      outcome = { status: "failed", summary: "handler error: " + error.message };
    }
    const durationMs = Date.now() - started;
    const run = {
      id: "R-" + (job.state.runs + 1),
      startedAt,
      finishedAt: new Date(new Date(startedAt).getTime() + durationMs).toISOString(),
      durationMs,
      status: outcome.status,
      summary: outcome.summary ?? "",
      metrics: outcome.metrics ?? {},
      output: outcome.output ? String(outcome.output).slice(0, 4000) : null,
      manual,
      attempt: job.state.attempt + 1
    };
    this.applyRun(job, run);
    this.appendRunLog(job.id, run);
    this.eventBus?.emit("scheduler.run.finished", { id: job.id, status: run.status, summary: run.summary, durationMs });
    return { job: this.read(job.id), run };
  }

  applyRun(job, run) {
    const state = job.state;
    state.runs += 1;
    state.last = run.finishedAt;
    state.lastStatus = run.status;
    if (run.status === "ok") {
      state.successes += 1;
      state.attempt = 0;
      if (state.consecutiveFailures > 0 && state.incident) {
        this.closeIncident(job, run);
      }
      state.consecutiveFailures = 0;
      state.next = this.computeNext(job, run);
    } else {
      state.failures += 1;
      state.consecutiveFailures += 1;
      const retries = job.policy.retries ?? 0;
      if (state.attempt < retries) {
        state.attempt += 1;
        const backoff = (job.policy.backoffMs ?? DEFAULT_POLICY.backoffMs) * Math.pow(2, state.attempt - 1);
        state.next = new Date(new Date(run.finishedAt).getTime() + backoff).toISOString();
      } else {
        state.attempt = 0;
        state.next = this.computeNext(job, run);
      }
      if (state.consecutiveFailures >= (job.alert.failuresBefore ?? DEFAULT_ALERT.failuresBefore) && !state.incident) {
        this.openIncident(job, run);
      }
    }
    job.history = [...(job.history ?? []), { at: run.finishedAt, status: run.status, summary: run.summary, durationMs: run.durationMs }].slice(-20);
    this.save(job);
  }

  computeNext(job, run) {
    if (job.schedule.at && !job.schedule.every && !job.schedule.cron) {
      return null;
    }
    const base = job.policy.catchUp ? new Date(job.state.next ?? run.finishedAt) : new Date(run.finishedAt);
    const next = nextRun(job.schedule, { from: base, lastRun: job.policy.catchUp ? job.state.next : run.finishedAt });
    const jitter = job.policy.jitterMs ? Math.round(job.policy.jitterMs / 2) : 0;
    return jitter ? new Date(new Date(next).getTime() + jitter).toISOString() : next;
  }

  appendRunLog(jobId, run) {
    mkdirSync(this.runsDirectory, { recursive: true });
    appendFileSync(join(this.runsDirectory, jobId + ".jsonl"), JSON.stringify(run) + "\n", "utf8");
  }

  runLog(jobId, { limit = 20 } = {}) {
    const path = join(this.runsDirectory, jobId + ".jsonl");
    if (!existsSync(path)) {
      return [];
    }
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .slice(-limit)
      .reverse();
  }

  incidentsPath() {
    return join(this.directory, "incidents.jsonl");
  }

  openIncident(job, run) {
    const incident = {
      id: "INC-" + job.id + "-" + (job.state.runs ?? 0),
      jobId: job.id,
      jobName: job.name,
      kind: job.kind,
      openedAt: run.finishedAt,
      closedAt: null,
      failures: job.state.consecutiveFailures,
      summary: run.summary,
      severity: job.alert.severity ?? "high"
    };
    job.state.incident = incident.id;
    mkdirSync(this.directory, { recursive: true });
    appendFileSync(this.incidentsPath(), JSON.stringify(incident) + "\n", "utf8");
    this.eventBus?.emit("scheduler.incident.opened", incident);
    this.escalate(job, incident);
    return incident;
  }

  closeIncident(job, run) {
    const incident = {
      id: job.state.incident,
      jobId: job.id,
      jobName: job.name,
      kind: job.kind,
      closedAt: run.finishedAt,
      recovery: true,
      summary: "recovered: " + run.summary
    };
    job.state.incident = null;
    appendFileSync(this.incidentsPath(), JSON.stringify(incident) + "\n", "utf8");
    this.eventBus?.emit("scheduler.incident.closed", incident);
    return incident;
  }

  escalate(job, incident) {
    const agents = this.services?.agents;
    const target = job.alert.escalateToAgent;
    if (!agents || !target) {
      return null;
    }
    try {
      return agents.assign(target, {
        objective: "[incident " + incident.id + "] " + job.name + " keeps failing: " + incident.summary,
        deliverable: "Diagnose the failing job " + job.id + " and report the fix",
        priority: "high"
      });
    } catch {
      return null;
    }
  }

  incidents({ open = null, limit = 50 } = {}) {
    const path = this.incidentsPath();
    if (!existsSync(path)) {
      return [];
    }
    const byId = new Map();
    for (const line of readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        const current = byId.get(entry.id) ?? {};
        byId.set(entry.id, { ...current, ...entry });
      } catch {
        continue;
      }
    }
    return [...byId.values()]
      .filter((incident) => open === null || (open ? !incident.closedAt : Boolean(incident.closedAt)))
      .sort((a, b) => String(b.openedAt ?? b.closedAt).localeCompare(String(a.openedAt ?? a.closedAt)))
      .slice(0, limit);
  }

  /**
   * Run every job that is due. This is the single entry point used by the
   * daemon, by `astack schedule tick` and by an external cron.
   */
  async tick({ asOf = null, limit = 25, kind = null } = {}) {
    const due = this.due({ asOf }).filter((job) => !kind || job.kind === kind).slice(0, limit);
    const results = [];
    for (const job of due) {
      const { run } = await this.runJob(job.id, { asOf });
      results.push({ id: job.id, name: job.name, kind: job.kind, status: run.status, summary: run.summary, durationMs: run.durationMs });
    }
    return results;
  }

  status({ asOf = null } = {}) {
    const jobs = this.list();
    const now = new Date(asOf ?? this.now()).getTime();
    return {
      jobs: jobs.length,
      enabled: jobs.filter((job) => job.enabled).length,
      due: jobs.filter((job) => job.enabled && job.state.next && new Date(job.state.next).getTime() <= now).length,
      failing: jobs.filter((job) => job.state.consecutiveFailures > 0).length,
      incidents: this.incidents({ open: true }).length,
      nextDue: jobs
        .filter((job) => job.enabled && job.state.next)
        .map((job) => job.state.next)
        .sort()[0] ?? null,
      byKind: jobs.reduce((accumulator, job) => {
        accumulator[job.kind] = (accumulator[job.kind] ?? 0) + 1;
        return accumulator;
      }, {})
    };
  }

  /**
   * The recommended baseline: keep the platform's own maintenance running
   * without the owner having to think about it.
   */
  installDefaults() {
    const created = [];
    const defaults = [
      { id: "agent-missions", name: "Dispatch due agent missions", kind: "agent-missions", schedule: { every: "30m" }, tags: ["core"] },
      { id: "context-refresh", name: "Refresh the context map", kind: "context-refresh", schedule: { cron: "0 * * * *" }, tags: ["core"] },
      { id: "learning-mine", name: "Mine repeated work into skills", kind: "learning-mine", schedule: { cron: "0 3 * * *" }, tags: ["core"] },
      { id: "memory-consolidate", name: "Consolidate memory", kind: "memory-consolidate", schedule: { cron: "30 3 * * *" }, tags: ["core"] },
      { id: "signal-process", name: "Process inbound signals", kind: "signal-process", schedule: { every: "5m" }, tags: ["core"] }
    ];
    for (const definition of defaults) {
      if (this.exists(definition.id)) {
        continue;
      }
      created.push(this.create(definition));
    }
    return created;
  }
}

export { describeSchedule, nextRun, parseInterval };
