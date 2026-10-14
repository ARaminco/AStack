import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { redactSecrets } from "../lib/text.mjs";
import { describeSchedule } from "../scheduler-engine/cron.mjs";
import { describeKind } from "../scheduler-engine/monitors.mjs";
import { levelValue } from "../trust-engine/authority.mjs";

/**
 * The console's JSON API over the runtime.
 *
 * Reads go straight to the engines. The only writes are owner decisions —
 * approve or deny, pause, resume or cancel a mission, start a runner job,
 * run a safe background job now — and each one goes through the same engine
 * the CLI uses, with the actor `owner@console`, so authority, approvals and
 * audit apply exactly as they do everywhere else.
 */

export const CONSOLE_ACTOR = "owner@console";

/** Job kinds that only read, refresh or tidy. Anything that runs a command or drives a browser is never started from a tap. */
export const SAFE_JOB_KINDS = ["http-check", "heartbeat", "context-refresh", "learning-mine", "memory-consolidate", "project-digest", "signal-process"];

/** Verbs that cannot be taken back once the step runs. */
const IRREVERSIBLE = /(^|[^a-z])(send|pay|payment|submit|delete|remove|publish|post|transfer|purchase|buy|sign|deploy|drop|wire|refund|cancel|commit|merge|push|email|sms|whatsapp)([^a-z]|$)/i;

const SERVICE_DIRECTORIES = ["runner-engine", "scheduler-engine", "signal-engine", "gateway-engine", "search-engine", "skill-hub", "console", "board-engine"];

export class HttpError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function features(runtime) {
  return {
    runner: typeof runtime.runner?.execute === "function",
    gateway: typeof runtime.gateway?.status === "function",
    search: typeof runtime.search?.query === "function",
    skillHub: Boolean(runtime.skillHub),
    board: Boolean(runtime.board),
    sandbox: Boolean(runtime.sandbox),
    daemon: Boolean(runtime.daemon) || existsSync(join(runtime.root, "daemon-engine"))
  };
}

export function isIrreversible(record) {
  let level = 0;
  try {
    level = levelValue(record.level ?? "L4");
  } catch {
    level = 4;
  }
  const words = [record.action, record.tool, record.summary].filter(Boolean).join(" ").replace(/[._:/-]+/g, " ");
  return level >= 4 || IRREVERSIBLE.test(words);
}

/** The short code the owner types to approve something irreversible: the last four characters of the request id. */
export function confirmCode(id) {
  return String(id ?? "").replace(/[^A-Za-z0-9]/g, "").slice(-4).toUpperCase();
}

function riskOf(record) {
  if (record.risk) {
    return String(record.risk);
  }
  let level = 4;
  try {
    level = levelValue(record.level ?? "L4");
  } catch {
    level = 4;
  }
  return level >= 4 ? "high" : level === 3 ? "medium" : "low";
}

const SECRET_KEY = /secret|password|passwd|token|cookie|credential|api[_-]?key|authorization|bearer|otp|pin|cvv|card/i;

/** Values the owner must see exactly, with anything shaped like a secret masked. A `credential://` reference is shown, never resolved. */
export function redactValue(value, key = "", depth = 0) {
  if (value === null || value === undefined) {
    return value ?? null;
  }
  if (typeof value === "string") {
    if (value.startsWith("credential://")) {
      return value;
    }
    if (SECRET_KEY.test(key)) {
      return "[redacted]";
    }
    return redactSecrets(value).slice(0, 2000);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return SECRET_KEY.test(key) && typeof value === "number" ? "[redacted]" : value;
  }
  if (depth > 4) {
    return "…";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => redactValue(entry, key, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [entryKey, entry] of Object.entries(value).slice(0, 60)) {
      out[entryKey] = redactValue(entry, entryKey, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function decorateApproval(record) {
  const irreversible = isIrreversible(record);
  return {
    id: record.id,
    action: record.action,
    summary: record.summary,
    target: record.target ?? null,
    tool: record.tool ?? null,
    level: record.level ?? null,
    risk: riskOf(record),
    parameters: redactValue(record.parameters ?? {}),
    evidence: redactValue((record.evidence ?? []).slice(0, 10)),
    mission: record.mission ?? null,
    project: record.project ?? null,
    requestedBy: record.requestedBy ?? null,
    state: record.state,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt ?? null,
    decidedAt: record.decidedAt ?? null,
    decidedBy: record.decidedBy ?? null,
    note: record.note ?? null,
    receipt: record.receipt
      ? { id: record.receipt.id, approvedAt: record.receipt.approvedAt, approvedBy: record.receipt.approvedBy, scope: record.receipt.scope, expiresAt: record.receipt.expiresAt }
      : null,
    irreversible,
    confirmCode: irreversible ? confirmCode(record.id) : null
  };
}

function missionCard(mission) {
  const steps = mission.steps ?? [];
  const done = steps.filter((step) => step.state === "done" || step.state === "skipped").length;
  return {
    id: mission.id,
    title: mission.title,
    goal: mission.goal,
    state: mission.state,
    domain: mission.domain ?? null,
    project: mission.project ?? null,
    priority: mission.priority ?? "normal",
    deadline: mission.deadline ?? null,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
    steps: steps.length,
    done,
    currentStep: mission.currentStep ?? 0,
    approvals: (mission.approvals ?? []).length
  };
}

async function settle(value) {
  return value && typeof value.then === "function" ? await value : value;
}

function attempt(fn, fallback = null) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

async function attemptAsync(fn, fallback = null) {
  try {
    const value = await settle(fn());
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

function asArray(value, keys = ["items", "runs", "results", "cards", "packs", "list"]) {
  if (Array.isArray(value)) {
    return value;
  }
  for (const key of keys) {
    if (Array.isArray(value?.[key])) {
      return value[key];
    }
  }
  return [];
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function pidAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Normalize the daemon's service map or list into rows the console can draw. */
function daemonServices(state) {
  const raw = state?.services;
  if (Array.isArray(raw)) {
    return raw.map((entry) => (typeof entry === "string" ? { name: entry, status: null } : { name: entry.name ?? entry.id ?? "?", status: entry.status ?? (entry.running === true ? "running" : entry.running === false ? "stopped" : null), error: entry.error ?? null, startedAt: entry.startedAt ?? null }));
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw).map(([name, entry]) => ({
      name,
      status: typeof entry === "string" ? entry : entry?.status ?? (entry?.running === true ? "running" : entry?.running === false ? "stopped" : null),
      error: entry?.error ?? null,
      startedAt: entry?.startedAt ?? null
    }));
  }
  return [];
}

function text(value, max = 400) {
  return value === null || value === undefined ? null : redactSecrets(String(value)).slice(0, max);
}

function matches(query, ...values) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return values.filter(Boolean).some((value) => String(value).toLowerCase().includes(needle));
}

function pageOf(items, { page = 1, size = 25 } = {}) {
  const safeSize = Math.min(100, Math.max(5, Number(size) || 25));
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / safeSize));
  const current = Math.min(pages, Math.max(1, Number(page) || 1));
  return { items: items.slice((current - 1) * safeSize, current * safeSize), page: current, pages, size: safeSize, total };
}

export class ConsoleApi {
  constructor(runtime, { events = null, server = null, clock = null } = {}) {
    this.runtime = runtime;
    this.events = events;
    this.server = server;
    this.clock = clock ?? (() => new Date());
    this.previews = new Map();
  }

  features() {
    return features(this.runtime);
  }

  audit(entry) {
    return attempt(() => this.runtime.audit.record({ actor: CONSOLE_ACTOR, riskLevel: "L1", ...entry }));
  }

  // ------------------------------------------------------------------ home

  async home() {
    const runtime = this.runtime;
    const standup = attempt(() => runtime.chief.standup(), null);
    const pending = attempt(() => runtime.approvals.pending(), []);
    const missions = attempt(() => runtime.missions.list({ limit: 200 }), []);
    const active = missions.filter((mission) => ["running", "waiting-approval", "paused", "blocked"].includes(mission.state));
    const scheduler = attempt(() => runtime.scheduler.status(), null);
    const incidents = attempt(() => runtime.scheduler.incidents({ open: true, limit: 5 }), []);
    const signals = attempt(() => runtime.signals.status(), null);
    const audit = attempt(() => runtime.audit.list({ limit: 8 }), []);
    const runs = this.features().runner ? asArray(await attemptAsync(() => runtime.runner.list({ limit: 5 }), [])) : null;
    const today = this.clock().toISOString().slice(0, 10);
    return {
      owner: standup?.capsule?.lines?.slice(0, 6) ?? [],
      counts: {
        approvals: pending.length,
        missionsActive: active.length,
        missionsWaiting: missions.filter((mission) => mission.state === "waiting-approval").length,
        missionsTotal: missions.length,
        incidents: scheduler?.incidents ?? incidents.length,
        jobs: scheduler?.jobs ?? 0,
        jobsFailing: scheduler?.failing ?? 0,
        hooks: signals?.hooks ?? 0,
        skills: attempt(() => runtime.skills.stats().skills, 0),
        auditToday: attempt(() => runtime.audit.list({ limit: 2000 }).filter((entry) => String(entry.timestamp).startsWith(today)).length, 0),
        runs: runs ? runs.length : null
      },
      approvals: pending.slice(0, 5).map(decorateApproval),
      missions: (active.length ? active : missions).slice(0, 5).map(missionCard),
      incidents: incidents.map((incident) => ({ id: incident.id, job: incident.jobName ?? incident.jobId, summary: text(incident.summary, 200), openedAt: incident.openedAt, severity: incident.severity ?? null })),
      scheduler: scheduler ? { jobs: scheduler.jobs, enabled: scheduler.enabled, due: scheduler.due, failing: scheduler.failing, nextDue: scheduler.nextDue } : null,
      learning: standup?.learning ?? null,
      runs: runs ? runs.slice(0, 5).map((run) => this.runCard(run)) : null,
      activity: audit.map((entry) => this.auditCard(entry)),
      features: this.features()
    };
  }

  // ------------------------------------------------------------- approvals

  approvals({ state = "pending", q = "", limit = 100 } = {}) {
    const list = state === "all"
      ? this.runtime.approvals.list({ limit: Math.min(500, Number(limit) || 100) })
      : this.runtime.approvals.list({ state, limit: Math.min(500, Number(limit) || 100) });
    const items = list.filter((record) => matches(q, record.id, record.action, record.summary, record.target, record.mission)).map(decorateApproval);
    return { items, pending: this.runtime.approvals.pending().length };
  }

  approval(id) {
    try {
      return decorateApproval(this.runtime.approvals.get(id));
    } catch (error) {
      throw new HttpError(404, error.message);
    }
  }

  decide(id, { decision, note = null, confirm = null } = {}) {
    if (!["approve", "deny"].includes(decision)) {
      throw new HttpError(400, "decision must be approve or deny");
    }
    let record;
    try {
      record = this.runtime.approvals.get(id);
    } catch (error) {
      throw new HttpError(404, error.message);
    }
    if (record.state !== "pending") {
      throw new HttpError(409, "Approval " + id + " is already " + record.state);
    }
    const approve = decision === "approve";
    if (approve && isIrreversible(record) && String(confirm ?? "").trim().toUpperCase() !== confirmCode(record.id)) {
      throw new HttpError(422, "typed confirmation does not match", { confirmRequired: true });
    }
    const cleanNote = note ? String(note).slice(0, 500) : null;
    const updated = approve
      ? this.runtime.approvals.approve(id, { by: CONSOLE_ACTOR, note: cleanNote })
      : this.runtime.approvals.reject(id, { by: CONSOLE_ACTOR, note: cleanNote });
    this.events?.soon();
    return decorateApproval(updated);
  }

  // -------------------------------------------------------------- missions

  missions({ state = null, q = "", limit = 100 } = {}) {
    const all = this.runtime.missions.list({ limit: 500 });
    const byState = {};
    for (const mission of all) {
      byState[mission.state] = (byState[mission.state] ?? 0) + 1;
    }
    const filtered = all
      .filter((mission) => !state || state === "all" || (state === "active" ? ["running", "waiting-approval", "paused", "blocked"].includes(mission.state) : mission.state === state))
      .filter((mission) => matches(q, mission.id, mission.title, mission.goal, mission.domain, mission.project))
      .slice(0, Math.min(500, Number(limit) || 100));
    return { items: filtered.map(missionCard), byState, total: all.length };
  }

  mission(id) {
    let mission;
    try {
      mission = this.runtime.missions.get(id);
    } catch (error) {
      throw new HttpError(404, error.message);
    }
    const approvals = (mission.approvals ?? []).map((approvalId) => attempt(() => decorateApproval(this.runtime.approvals.get(approvalId)), { id: approvalId, state: "unknown" }));
    return {
      ...missionCard(mission),
      tags: mission.tags ?? [],
      team: mission.team ?? null,
      runtime: mission.runtime ?? null,
      metrics: mission.metrics ?? null,
      report: mission.report ? { summary: text(mission.report.summary, 2000), at: mission.report.at, outcome: mission.report.outcome } : null,
      stepList: (mission.steps ?? []).map((step) => ({
        id: step.id,
        order: step.order,
        title: step.title,
        tool: step.tool,
        action: step.action,
        authority: step.authority,
        state: step.state,
        attempts: step.attempts,
        approvalId: step.approvalId ?? null,
        startedAt: step.startedAt,
        finishedAt: step.finishedAt,
        result: step.result ? { ok: step.result.ok, summary: text(step.result.summary, 600), durationMs: step.result.durationMs ?? 0 } : null
      })),
      timeline: (mission.events ?? []).slice(-80).reverse().map((event) => {
        const { at, event: name, ...rest } = event;
        return { at, event: name, details: redactValue(rest) };
      }),
      approvalList: approvals,
      artifacts: redactValue((mission.artifacts ?? []).slice(-20)),
      findings: (mission.findings ?? []).slice(-20).map((finding) => text(typeof finding === "string" ? finding : JSON.stringify(finding), 400))
    };
  }

  async missionAction(id, action, { reason = null } = {}) {
    const missions = this.runtime.missions;
    let mission;
    try {
      mission = missions.get(id);
    } catch (error) {
      throw new HttpError(404, error.message);
    }
    const note = reason ? String(reason).slice(0, 300) : null;
    if (action === "pause") {
      if (["completed", "cancelled"].includes(mission.state)) {
        throw new HttpError(409, "Mission " + id + " is already " + mission.state);
      }
      mission = missions.pause(id, { reason: note ?? "paused from the console" });
      this.audit({ action: "mission-paused", target: id, mission: id, result: note ?? "paused" });
    } else if (action === "resume") {
      if (!["paused", "waiting-approval", "blocked", "failed"].includes(mission.state)) {
        throw new HttpError(409, "Mission " + id + " is " + mission.state + " and cannot be resumed");
      }
      missions.resume(id, { note: note ?? "resumed from the console" });
      this.audit({ action: "mission-resumed", target: id, mission: id, riskLevel: "L2", result: note ?? "resumed" });
      // Resuming continues the run, exactly like `astack mission resume`. Every
      // step still passes through the tool registry, so a step above the
      // ceiling parks the mission again instead of running.
      setImmediate(() => {
        missions.run(id, { actor: CONSOLE_ACTOR }).catch((error) => {
          this.events?.notify("mission", { title: id, body: error.message, level: "error", link: "#/missions/" + id, ref: id });
        }).finally(() => this.events?.soon());
      });
      mission = missions.get(id);
    } else if (action === "cancel") {
      if (["completed", "cancelled"].includes(mission.state)) {
        throw new HttpError(409, "Mission " + id + " is already " + mission.state);
      }
      mission = missions.cancel(id, { reason: note ?? "cancelled from the console" });
      this.audit({ action: "mission-cancel-requested", target: id, mission: id, result: note ?? "cancelled" });
    } else {
      throw new HttpError(400, "Unknown mission action: " + action);
    }
    this.events?.soon();
    return missionCard(mission);
  }

  // ---------------------------------------------------------------- runner

  runCard(run) {
    return {
      id: run.id,
      objective: text(run.objective ?? run.summary, 300),
      status: run.status ?? "unknown",
      source: run.source ?? null,
      engine: run.engine ?? null,
      summary: text(run.summary, 600),
      missionId: run.missionId ?? null,
      approvals: run.approvals ?? [],
      startedAt: run.startedAt ?? run.createdAt ?? null,
      finishedAt: run.finishedAt ?? null,
      cost: run.cost ?? null,
      // The runner refuses a job on a budget, concurrency or engine limit and says why.
      reason: run.reason ? text(run.reason, 200) : null,
      dryRun: Boolean(run.dryRun) || run.status === "dry-run"
    };
  }

  async runs({ limit = 50 } = {}) {
    if (!this.features().runner) {
      return { installed: false, items: [] };
    }
    const items = asArray(await attemptAsync(() => this.runtime.runner.list({ limit: Math.min(200, Number(limit) || 50) }), []));
    const status = typeof this.runtime.runner.status === "function" ? redactValue(await attemptAsync(() => this.runtime.runner.status(), null)) : null;
    return { installed: true, status, items: items.map((run) => this.runCard(run)) };
  }

  async run(id) {
    if (!this.features().runner) {
      throw new HttpError(404, "runner not installed");
    }
    const run = await attemptAsync(() => this.runtime.runner.get(id), null);
    if (!run) {
      throw new HttpError(404, "Unknown run: " + id);
    }
    return { ...this.runCard(run), output: text(typeof run.output === "string" ? run.output : JSON.stringify(run.output ?? null), 8000) };
  }

  /**
   * Start a runner job. A real run is accepted only for an objective that was
   * previewed with a dry run in the same session in the last fifteen minutes.
   */
  async startRun(sessionKey, { objective, dryRun = true, previewId = null } = {}) {
    if (!this.features().runner) {
      throw new HttpError(404, "runner not installed");
    }
    const clean = String(objective ?? "").trim().slice(0, 2000);
    if (clean.length < 3) {
      throw new HttpError(400, "objective is required");
    }
    const digest = createHash("sha256").update(sessionKey + "\n" + clean).digest("hex").slice(0, 24);
    if (dryRun) {
      const result = await settle(this.runtime.runner.execute({ objective: clean, source: "console", dryRun: true }));
      this.previews.set(digest, Date.now() + 15 * 60 * 1000);
      return { dryRun: true, previewId: digest, result: this.runCard({ ...result, objective: clean, dryRun: true }), plan: text(typeof result?.output === "string" ? result.output : JSON.stringify(result?.output ?? null), 6000) };
    }
    const expires = this.previews.get(digest);
    if (!previewId || previewId !== digest || !expires || expires < Date.now()) {
      throw new HttpError(428, "run a dry run of this exact objective first", { dryRunRequired: true });
    }
    this.previews.delete(digest);
    this.audit({ action: "console-run-started", target: clean.slice(0, 200), riskLevel: "L2", result: "runner" });
    const pending = settle(this.runtime.runner.execute({ objective: clean, source: "console", dryRun: false }));
    pending.catch(() => {}).finally(() => this.events?.soon());
    const raced = await Promise.race([pending.catch((error) => ({ status: "failed", summary: error.message })), new Promise((resolve) => setTimeout(() => resolve(null), 1500))]);
    return { dryRun: false, result: raced ? this.runCard({ ...raced, objective: clean }) : { status: "queued", objective: clean } };
  }

  // ---------------------------------------------------------- jobs & hooks

  jobs() {
    const scheduler = this.runtime.scheduler;
    const jobs = attempt(() => scheduler.list(), []);
    return {
      status: attempt(() => scheduler.status(), null),
      daemon: this.schedulerDaemon(),
      safeKinds: SAFE_JOB_KINDS,
      items: jobs.map((job) => ({
        id: job.id,
        name: job.name,
        kind: job.kind,
        kindLabel: describeKind(job.kind),
        enabled: job.enabled,
        schedule: describeSchedule(job.schedule),
        tags: job.tags ?? [],
        target: job.kind === "http-check" ? text(job.payload?.url, 200) : null,
        next: job.state?.next ?? null,
        last: job.state?.last ?? null,
        lastStatus: job.state?.lastStatus ?? null,
        failures: job.state?.consecutiveFailures ?? 0,
        runs: job.state?.runs ?? 0,
        incident: job.state?.incident ?? null,
        runnable: SAFE_JOB_KINDS.includes(job.kind),
        history: (job.history ?? []).slice(-6).reverse().map((entry) => ({ at: entry.at, status: entry.status, summary: text(entry.summary, 200), durationMs: entry.durationMs }))
      })),
      incidents: attempt(() => scheduler.incidents({ limit: 20 }), []).map((incident) => ({
        id: incident.id,
        job: incident.jobName ?? incident.jobId,
        kind: incident.kind,
        summary: text(incident.summary, 300),
        openedAt: incident.openedAt ?? null,
        closedAt: incident.closedAt ?? null,
        severity: incident.severity ?? null
      }))
    };
  }

  schedulerDaemon() {
    const record = readJson(join(this.runtime.workspaceRoot, ".astack", "scheduler", "daemon.json"), null);
    return record ? { running: pidAlive(record.pid), startedAt: record.startedAt ?? null, intervalMs: record.intervalMs ?? null } : { running: false };
  }

  async runJob(id) {
    const scheduler = this.runtime.scheduler;
    let job;
    try {
      job = scheduler.read(id);
    } catch (error) {
      throw new HttpError(404, error.message);
    }
    if (!SAFE_JOB_KINDS.includes(job.kind)) {
      throw new HttpError(403, "Jobs of kind " + job.kind + " are not started from the console");
    }
    this.audit({ action: "job-run-now", target: id, result: job.kind });
    const { run } = await scheduler.runJob(id, { manual: true });
    this.events?.soon();
    return { id, status: run.status, summary: text(run.summary, 400), durationMs: run.durationMs };
  }

  hooks() {
    const signals = this.runtime.signals;
    const hooks = attempt(() => signals.list(), []);
    return {
      status: attempt(() => signals.status(), null),
      items: hooks.map((hook) => ({
        id: hook.id,
        name: hook.name,
        source: hook.source,
        enabled: hook.enabled,
        requireSignature: hook.requireSignature,
        path: "/hooks/" + hook.id,
        rules: (hook.rules ?? []).length,
        domain: hook.defaults?.domain ?? null,
        received: hook.state?.received ?? 0,
        processed: hook.state?.processed ?? 0,
        lastAt: hook.state?.lastAt ?? null
      })),
      inbox: attempt(() => signals.inbox({ limit: 200 }), []).slice(-15).reverse().map((event) => ({
        id: event.id,
        hook: event.hook ?? event.hookId ?? null,
        state: event.state,
        domain: event.domain ?? null,
        at: event.at,
        // Inbound text is data from outside; it is shown, escaped, and never interpreted.
        text: text(event.text ?? event.subject, 240)
      }))
    };
  }

  // ----------------------------------------------------------------- audit

  auditCard(entry) {
    return {
      id: entry.id,
      timestamp: entry.timestamp,
      actor: entry.actor,
      action: entry.action,
      target: entry.target,
      tool: entry.tool ?? null,
      riskLevel: entry.riskLevel,
      approval: entry.approval,
      result: entry.result,
      mission: entry.mission ?? null,
      project: entry.project ?? null,
      evidence: (entry.evidence ?? []).length
    };
  }

  auditLog({ action = null, risk = null, mission = null, month = null, actor = null, q = "", page = 1, size = 25 } = {}) {
    const audit = this.runtime.audit;
    const entries = audit
      .list({ limit: 100000, action: action || null, riskLevel: risk || null, mission: mission || null, month: month || null })
      .filter((entry) => !actor || entry.actor === actor)
      .filter((entry) => matches(q, entry.id, entry.action, entry.target, entry.result, entry.actor, entry.tool, entry.mission));
    const stats = attempt(() => audit.stats({ month: month || null }), { byAction: {}, byRisk: {} });
    const paged = pageOf(entries, { page, size });
    return {
      ...paged,
      items: paged.items.map((entry) => this.auditCard(entry)),
      months: attempt(() => audit.months(), []),
      actions: Object.keys(stats.byAction ?? {}).sort(),
      risks: Object.keys(stats.byRisk ?? {}).sort()
    };
  }

  // ---------------------------------------------------------------- memory

  memoryCard(record) {
    return {
      id: record.id,
      facet: record.facet ?? record.type ?? record.source ?? null,
      title: text(record.title ?? record.name ?? record.path, 240),
      body: text(record.body ?? record.text ?? record.snippet ?? record.excerpt, 900),
      tags: (record.tags ?? []).slice(0, 8),
      entities: (record.entities ?? []).slice(0, 8),
      project: record.project ?? null,
      domain: record.domain ?? null,
      confidence: record.confidence ?? null,
      score: record.score ?? null,
      at: record.at ?? record.updatedAt ?? null,
      source: record.source ?? null
    };
  }

  async memorySearch({ q = "", facet = null, limit = 20 } = {}) {
    const query = String(q ?? "").trim().slice(0, 300);
    const size = Math.min(50, Number(limit) || 20);
    if (query && this.features().search) {
      const result = await attemptAsync(() => this.runtime.search.query(query, { k: size }), null);
      const items = asArray(result, ["results", "items", "hits"]);
      // An unbuilt or empty index falls back to the memory engine below.
      if (result && result.indexed !== false && items.length) {
        return { engine: "search", query, items: items.map((item) => this.memoryCard(item)).filter((item) => !facet || item.facet === facet) };
      }
    }
    const facets = facet ? [facet] : undefined;
    const records = this.runtime.memory.recall({ query, limit: size, ...(facets ? { facets } : {}) });
    return { engine: "memory", query, items: records.map((record) => this.memoryCard(record)) };
  }

  memoryEntity({ q = "" } = {}) {
    const query = String(q ?? "").trim().slice(0, 200);
    if (!query) {
      return { query, items: [] };
    }
    const graph = this.runtime.graph;
    const hits = attempt(() => graph.resolve(query, { limit: 5 }), []);
    return {
      query,
      items: hits.map((hit) => ({
        id: hit.node.id,
        type: hit.node.type,
        name: hit.node.name,
        aliases: hit.node.aliases ?? [],
        score: hit.score,
        attributes: redactValue(hit.node.attributes ?? {}),
        neighbours: attempt(() => graph.neighbours(hit.node.id, { limit: 12 }), []).map((entry) => ({
          relation: entry.edge.type,
          direction: entry.edge.from === hit.node.id ? "out" : "in",
          id: entry.node.id,
          type: entry.node.type,
          name: entry.node.name
        }))
      }))
    };
  }

  memoryStats() {
    return {
      memory: attempt(() => this.runtime.memory.stats(), null),
      graph: attempt(() => this.runtime.graph.stats(), null),
      facets: attempt(() => this.runtime.memory.facetNames(), []),
      engine: this.features().search ? "search" : "memory",
      search: this.features().search ? attempt(() => this.runtime.search.status(), null) : null
    };
  }

  // ---------------------------------------------------------------- skills

  async skills({ q = "", source = null } = {}) {
    const catalog = this.runtime.skills;
    const query = String(q ?? "").trim();
    const all = attempt(() => catalog.list(), []);
    let items = all;
    if (query) {
      const ranked = attempt(() => catalog.search(query, { limit: 30 }), []);
      const ids = new Set(ranked.map((entry) => entry.id));
      items = all.filter((skill) => ids.has(skill.id) || matches(query, skill.id, skill.name, skill.nameFa, skill.description));
    }
    if (source) {
      items = items.filter((skill) => String(skill.source ?? "").startsWith(source));
    }
    const hub = this.runtime.skillHub;
    let packs = null;
    if (hub) {
      const raw = await attemptAsync(() => (hub.packs ?? hub.listPacks ?? hub.list)?.call(hub), null);
      packs = asArray(raw).map((pack) => ({
        id: pack.id ?? pack.name,
        name: pack.name ?? pack.id,
        skills: pack.skills?.length ?? pack.count ?? null,
        source: pack.source ?? null,
        status: pack.status ?? pack.label ?? null
      }));
    }
    return {
      stats: attempt(() => catalog.stats(), null),
      hub: hub ? { installed: true, status: await attemptAsync(() => hub.status?.(), null), packs } : { installed: false },
      items: items.slice(0, 300).map((skill) => ({
        id: skill.id,
        name: skill.nameFa ?? skill.name ?? skill.id,
        source: skill.source,
        status: skill.status ?? null,
        confidence: skill.confidence ?? null,
        domains: skill.domains ?? [],
        description: text(skill.description, 240),
        riskLevel: skill.riskLevel ?? null,
        label: skill.label ?? skill.scan?.label ?? null
      }))
    };
  }

  skill(id) {
    try {
      const skill = this.runtime.skills.show(id);
      return {
        id: skill.id,
        name: skill.nameFa ?? skill.name ?? skill.id,
        source: skill.source,
        status: skill.status ?? null,
        confidence: skill.confidence ?? null,
        domains: skill.domains ?? [],
        tokens: skill.tokens,
        path: skill.path,
        // Skill files are data: rendered as text, never executed or followed.
        content: String(skill.content ?? "").slice(0, 30000)
      };
    } catch (error) {
      throw new HttpError(404, error.message);
    }
  }

  // ------------------------------------------------- board, gateway, system

  async board() {
    const board = this.runtime.board;
    if (!board) {
      return { installed: false };
    }
    const status = await attemptAsync(() => board.status?.(), null);
    const raw = await attemptAsync(() => (board.list ?? board.cards)?.call(board, {}), null);
    const cards = asArray(raw, ["cards", "items", "tasks"]).slice(0, 300).map((card) => ({
      id: card.id,
      title: text(card.title ?? card.objective ?? card.name, 240),
      column: card.column ?? card.status ?? card.state ?? "todo",
      assignee: card.assignee ?? card.agent ?? null,
      attempts: card.attempts ?? card.retries ?? null,
      updatedAt: card.updatedAt ?? null
    }));
    const columns = asArray(status?.columns ?? null).length ? status.columns : [...new Set(cards.map((card) => card.column))];
    return { installed: true, status: redactValue(status), columns, cards };
  }

  async gateway() {
    const gateway = this.runtime.gateway;
    if (typeof gateway?.status !== "function") {
      return { installed: false };
    }
    return { installed: true, status: redactValue(await attemptAsync(() => gateway.status(), null)) };
  }

  async system() {
    const runtime = this.runtime;
    const pkg = readJson(join(runtime.root, "package.json"), {});
    const core = readJson(join(runtime.root, "core", "manifest.json"), {});
    const daemonStatus = runtime.daemon ? redactValue(await attemptAsync(() => runtime.daemon.status?.(), null)) : null;
    // `astack daemon` (P1) writes its supervisor state here; another process may own it.
    const daemonState = redactValue(readJson(join(runtime.workspaceRoot, ".astack", "daemon", "state.json"), null));
    const services = SERVICE_DIRECTORIES.map((directory) => ({ id: directory, present: existsSync(join(runtime.root, directory, "service.mjs")) }));
    const doctor = [
      ["departments", attempt(() => runtime.departments.length, 0)],
      ["domains", attempt(() => runtime.domains.list().length, 0)],
      ["providers", attempt(() => runtime.providers.length, 0)],
      ["knowledgePacks", attempt(() => runtime.knowledgePackRegistry.list().length, 0)],
      ["projects", attempt(() => runtime.projects.list().length, 0)],
      ["teams", attempt(() => runtime.teams.list().length, 0)],
      ["agents", attempt(() => runtime.agents.list().length, 0)],
      ["memoryFacets", attempt(() => runtime.memory.facetNames().length, 0)],
      ["skills", attempt(() => runtime.skills.stats().skills, 0)],
      ["tools", attempt(() => runtime.tools.stats().tools, 0)],
      ["jobs", attempt(() => runtime.scheduler.list().length, 0)],
      ["hooks", attempt(() => runtime.signals.list().length, 0)],
      ["missions", attempt(() => runtime.missions.list({ limit: 1000 }).length, 0)],
      ["browser", attempt(() => runtime.browser.status().driver, "none")],
      ["authorityDefault", attempt(() => runtime.authority.describe().defaultLevel, null)]
    ].map(([key, value]) => ({ key, value }));
    return {
      versions: { astack: pkg.version ?? null, core: core.version ?? null, node: process.versions.node, platform: process.platform + " " + process.arch },
      runtimes: attempt(() => runtime.runtimes.list().map((entry) => ({ id: entry.id, status: entry.status ?? null, available: entry.available ?? null })), []),
      doctor,
      features: this.features(),
      services,
      daemon: daemonStatus,
      daemonState: daemonState ? { ...daemonState, services: daemonServices(daemonState), alive: pidAlive(daemonState.pid) } : null,
      scheduler: this.schedulerDaemon(),
      console: this.server?.describe?.() ?? null
    };
  }

  // ------------------------------------------------------------ palette

  async search({ q = "" } = {}) {
    const query = String(q ?? "").trim().slice(0, 200);
    if (!query) {
      return { query, approvals: [], missions: [], memory: [], skills: [], runs: [] };
    }
    const approvals = attempt(() => this.runtime.approvals.list({ limit: 200 }), [])
      .filter((record) => matches(query, record.id, record.action, record.summary, record.target))
      .slice(0, 5)
      .map((record) => ({ id: record.id, label: record.summary || record.action, meta: record.action, state: record.state }));
    const missions = attempt(() => this.runtime.missions.list({ limit: 500 }), [])
      .filter((mission) => matches(query, mission.id, mission.title, mission.goal))
      .slice(0, 5)
      .map((mission) => ({ id: mission.id, label: mission.title, meta: mission.id, state: mission.state }));
    const memory = attempt(() => this.runtime.memory.recall({ query, limit: 5 }), []).map((record) => ({ id: record.id, label: text(record.title, 140), meta: record.facet }));
    const skills = attempt(() => this.runtime.skills.search(query, { limit: 5 }), []).map((skill) => ({ id: skill.id, label: skill.name ?? skill.id, meta: skill.source }));
    let runs = [];
    if (this.features().runner) {
      runs = asArray(await attemptAsync(() => this.runtime.runner.list({ limit: 100 }), []))
        .filter((run) => matches(query, run.id, run.objective, run.summary))
        .slice(0, 5)
        .map((run) => ({ id: run.id, label: text(run.objective ?? run.summary, 140), meta: run.status }));
    }
    return { query, approvals, missions, memory, skills, runs };
  }
}
