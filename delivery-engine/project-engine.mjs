import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { completionProbability, criticalPath } from "./scheduling.mjs";
import { rankBacklog } from "./prioritization.mjs";
import { rankRisks, riskScore } from "./risk.mjs";
import { earnedValue, estimateAccuracy, healthScore, scopeCreep, throughputDrift, totalPoints, velocity, weeklyThroughput, wipViolations } from "./metrics.mjs";
import { forecastDates, monteCarloForecast } from "./forecasting.mjs";

const templatesPath = join(dirname(fileURLToPath(import.meta.url)), "templates.json");

const DAY = 24 * 60 * 60 * 1000;
export const phases = ["initiation", "planning", "execution", "closing", "closed"];
export const itemStatuses = ["backlog", "ready", "in-progress", "in-review", "done", "blocked", "descoped"];
export const itemTypes = ["epic", "story", "task", "bug"];
const pointBearingTypes = ["story", "task", "bug"];

export class ProjectEngine {
  constructor(root, { clock, memory, eventBus, defaults } = {}) {
    this.root = root;
    this.directory = join(root, ".astack", "projects");
    this.clock = clock ?? (() => new Date());
    this.memory = memory ?? null;
    this.eventBus = eventBus ?? null;
    this.defaults = { sprintDays: 14, sprintCapacity: 20, wipLimits: { "in-progress": 3, "in-review": 2 }, ...defaults };
  }

  now() {
    return this.clock().toISOString();
  }

  list() {
    if (!existsSync(this.directory)) {
      return [];
    }
    return readdirSync(this.directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(this.directory, entry.name, "project.json")))
      .map((entry) => this.get(entry.name));
  }

  get(id) {
    const path = join(this.directory, id, "project.json");
    if (!existsSync(path)) {
      throw new Error("Unknown project: " + id);
    }
    return JSON.parse(readFileSync(path, "utf8"));
  }

  save(project) {
    const dir = join(this.directory, project.id);
    mkdirSync(dir, { recursive: true });
    project.updatedAt = this.now();
    writeFileSync(join(dir, "project.json"), JSON.stringify(project, null, 2) + "\n", "utf8");
    return project;
  }

  templates() {
    return JSON.parse(readFileSync(templatesPath, "utf8")).templates;
  }

  create({ name, description = "", targetDate = null, owner = "product", template = null }) {
    const id = slug(name);
    if (existsSync(join(this.directory, id, "project.json"))) {
      throw new Error("Project already exists: " + id);
    }
    const project = {
      id,
      name,
      description,
      owner,
      phase: "initiation",
      createdAt: this.now(),
      targetDate,
      charter: { outcome: "", successCriteria: [], constraints: [], outOfScope: [] },
      milestones: [],
      workItems: [],
      sprints: [],
      risks: [],
      decisions: [],
      retrospectives: [],
      board: { wipLimits: { ...this.defaults.wipLimits } },
      baseline: null,
      counters: { item: 0, risk: 0, sprint: 0, milestone: 0, decision: 0 },
      events: []
    };
    this.record(project, "project-created", { name });
    this.save(project);
    if (template) {
      this.applyTemplate(id, template);
    }
    return this.get(id);
  }

  applyTemplate(id, templateId) {
    const template = this.templates().find((entry) => entry.id === templateId);
    if (!template) {
      throw new Error("Unknown template: " + templateId + ". Available: " + this.templates().map((entry) => entry.id).join(", "));
    }
    const project = this.get(id);
    const base = this.clock().getTime();
    for (const milestone of template.milestones ?? []) {
      this.addMilestone(id, { title: milestone.title, due: new Date(base + milestone.dueInDays * DAY).toISOString().slice(0, 10) });
    }
    for (const risk of template.risks ?? []) {
      this.addRisk(id, risk);
    }
    const epicIds = new Map();
    for (const epic of template.epics ?? []) {
      const created = this.addWorkItem(id, { type: "epic", title: epic.title, department: epic.department, moscow: epic.moscow });
      epicIds.set(epic.title, created.id);
      for (const story of epic.stories ?? []) {
        this.addWorkItem(id, { ...story, type: story.type ?? "story", parent: created.id, department: story.department ?? epic.department });
      }
    }
    const updated = this.get(id);
    this.record(updated, "template-applied", { template: templateId });
    this.save(updated);
    return updated;
  }

  scaffold(id, { goal, departments }) {
    const project = this.get(id);
    if (!departments?.length) {
      throw new Error("Scaffold requires at least one department");
    }
    for (const department of departments) {
      const epic = this.addWorkItem(id, { type: "epic", title: department.name + " workstream: " + goal, department: department.id, moscow: "must" });
      for (const stage of ["Design", "Implement", "Verify"]) {
        this.addWorkItem(id, {
          type: "story",
          title: stage + " " + department.name.toLowerCase() + " scope",
          parent: epic.id,
          department: department.id,
          points: 3,
          moscow: stage === "Verify" ? "should" : "must",
          wsjf: { businessValue: 5, timeCriticality: 3, riskReduction: 2, jobSize: 3 }
        });
      }
    }
    const updated = this.get(id);
    this.record(updated, "scaffolded", { goal, departments: departments.map((department) => department.id) });
    this.save(updated);
    return updated;
  }

  record(project, type, payload = {}) {
    const event = { at: this.now(), type, ...payload };
    project.events.push(event);
    this.eventBus?.emit("delivery." + type, { projectId: project.id, ...payload });
    return event;
  }

  setCharter(id, charter) {
    const project = this.get(id);
    project.charter = { ...project.charter, ...charter };
    this.record(project, "charter-updated", {});
    return this.save(project);
  }

  addMilestone(id, { title, due }) {
    const project = this.get(id);
    project.counters.milestone += 1;
    const milestone = { id: "M-" + project.counters.milestone, title, due, status: "open" };
    project.milestones.push(milestone);
    this.record(project, "milestone-added", { milestoneId: milestone.id, title });
    this.save(project);
    return milestone;
  }

  completeMilestone(id, milestoneId) {
    const project = this.get(id);
    const milestone = project.milestones.find((entry) => entry.id === milestoneId);
    if (!milestone) {
      throw new Error("Unknown milestone: " + milestoneId);
    }
    milestone.status = "done";
    milestone.completedAt = this.now();
    this.record(project, "milestone-completed", { milestoneId });
    return this.save(project);
  }

  addWorkItem(id, input) {
    const project = this.get(id);
    if (input.type && !itemTypes.includes(input.type)) {
      throw new Error("Unknown work item type: " + input.type);
    }
    project.counters.item += 1;
    const item = {
      id: "T-" + project.counters.item,
      type: input.type ?? "task",
      title: input.title,
      parent: input.parent ?? null,
      status: "backlog",
      points: Number(input.points ?? 0),
      estimate: input.estimate ?? null,
      dependsOn: input.dependsOn ?? [],
      department: input.department ?? null,
      assignee: input.assignee ?? null,
      moscow: input.moscow ?? "should",
      wsjf: input.wsjf ?? null,
      rice: input.rice ?? null,
      sprint: null,
      createdAt: this.now(),
      startedAt: null,
      completedAt: null,
      actualEffort: null,
      blockedReason: null
    };
    for (const dep of item.dependsOn) {
      if (!project.workItems.some((existing) => existing.id === dep)) {
        throw new Error("Unknown dependency: " + dep);
      }
    }
    if (item.parent && !project.workItems.some((existing) => existing.id === item.parent)) {
      throw new Error("Unknown parent: " + item.parent);
    }
    project.workItems.push(item);
    this.record(project, "item-added", { itemId: item.id, title: item.title });
    this.save(project);
    return item;
  }

  moveItem(id, itemId, status, { force = false, actualEffort = null, reason = null } = {}) {
    if (!itemStatuses.includes(status)) {
      throw new Error("Unknown status: " + status);
    }
    const project = this.get(id);
    const item = requireItem(project, itemId);
    if (status === "in-progress" && !force) {
      const unmetDeps = item.dependsOn.filter((dep) => requireItem(project, dep).status !== "done");
      if (unmetDeps.length) {
        throw new Error("Dependencies not done for " + itemId + ": " + unmetDeps.join(", "));
      }
    }
    if (["in-progress", "in-review"].includes(status) && !force) {
      const occupants = project.workItems.filter((entry) => entry.status === status && entry.id !== itemId);
      const limit = project.board.wipLimits[status];
      if (limit !== undefined && occupants.length >= limit) {
        const oldest = occupants.sort((a, b) => new Date(a.startedAt ?? a.createdAt) - new Date(b.startedAt ?? b.createdAt))[0];
        throw new Error("WIP limit reached for " + status + " (" + limit + "). Finish " + oldest.id + " (" + oldest.title + ") first");
      }
    }
    if (status === "ready" && pointBearingTypes.includes(item.type) && !(Number(item.points) > 0)) {
      throw new Error("Definition of ready not met for " + itemId + ": points must be set before ready");
    }
    const from = item.status;
    item.status = status;
    if (status === "in-progress" && !item.startedAt) {
      item.startedAt = this.now();
    }
    if (status === "done") {
      item.completedAt = this.now();
      if (actualEffort !== null) {
        item.actualEffort = Number(actualEffort);
      }
    }
    item.blockedReason = status === "blocked" ? reason : null;
    this.record(project, "status", { itemId, from, to: status });
    this.save(project);
    return item;
  }

  backlog(id) {
    const project = this.get(id);
    return rankBacklog(project.workItems.filter((item) => ["backlog", "ready"].includes(item.status) && pointBearingTypes.includes(item.type)));
  }

  board(id) {
    const project = this.get(id);
    const columns = {};
    for (const status of itemStatuses) {
      columns[status] = project.workItems.filter((item) => item.status === status);
    }
    return { columns, wipLimits: project.board.wipLimits, violations: wipViolations(project) };
  }

  setBaseline(id, { targetDate } = {}) {
    const project = this.get(id);
    const date = targetDate ?? project.targetDate;
    if (!date) {
      throw new Error("Baseline requires a target date");
    }
    project.targetDate = date;
    project.baseline = { totalPoints: totalPoints(project.workItems), setAt: this.now(), targetDate: date };
    this.record(project, "baseline-set", { totalPoints: project.baseline.totalPoints, targetDate: date });
    return this.save(project);
  }

  gate(project) {
    const unmet = [];
    if (project.phase === "initiation") {
      if (!project.charter.outcome) {
        unmet.push("charter-outcome-missing");
      }
      if (!project.charter.successCriteria.length) {
        unmet.push("success-criteria-missing");
      }
    }
    if (project.phase === "planning") {
      if (!project.milestones.length) {
        unmet.push("milestones-missing");
      }
      const estimated = project.workItems.filter((item) => pointBearingTypes.includes(item.type) && Number(item.points) > 0);
      if (estimated.length < 3) {
        unmet.push("estimated-items-missing");
      }
      if (!project.risks.length) {
        unmet.push("risks-missing");
      }
      if (!project.targetDate) {
        unmet.push("target-date-missing");
      }
    }
    if (project.phase === "execution") {
      const openMust = project.workItems.filter((item) => item.moscow === "must" && !["done", "descoped"].includes(item.status));
      if (openMust.length) {
        unmet.push("must-items-open");
      }
      if (project.sprints.some((sprint) => sprint.status === "active")) {
        unmet.push("sprint-still-active");
      }
    }
    if (project.phase === "closing" && !project.retrospectives.length) {
      unmet.push("retrospective-missing");
    }
    return { ok: unmet.length === 0, unmet };
  }

  advancePhase(id) {
    const project = this.get(id);
    const index = phases.indexOf(project.phase);
    if (index === phases.length - 1) {
      throw new Error("Project is already closed");
    }
    const gate = this.gate(project);
    if (!gate.ok) {
      return { advanced: false, phase: project.phase, unmet: gate.unmet };
    }
    const next = phases[index + 1];
    if (next === "execution" && !project.baseline) {
      this.save(project);
      this.setBaseline(id);
      return this.advanceRecorded(this.get(id), next);
    }
    if (next === "closed") {
      this.recordCalibration(project);
    }
    return this.advanceRecorded(project, next);
  }

  recordCalibration(project) {
    if (!this.memory) {
      return;
    }
    const evm = earnedValue(project, this.now());
    const accuracy = estimateAccuracy(project.workItems);
    const parts = ["[calibration] project=" + project.id];
    if (evm?.cpi) {
      parts.push("cpi=" + evm.cpi);
    }
    if (accuracy) {
      parts.push("effortRatio=" + accuracy.effortRatio, "mape=" + accuracy.mape);
    }
    if (parts.length > 1) {
      this.memory.append("decision", parts.join(" "));
    }
  }

  calibration() {
    if (!this.memory) {
      return null;
    }
    const entries = this.memory.read("decision").split(/\r?\n/).filter((line) => line.includes("[calibration]"));
    const ratios = entries
      .map((line) => Number(/effortRatio=([0-9.]+)/.exec(line)?.[1]))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (!ratios.length) {
      return null;
    }
    const effortRatio = ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
    return { samples: ratios.length, effortRatio: Math.round(effortRatio * 100) / 100 };
  }

  advanceRecorded(project, next) {
    const from = project.phase;
    project.phase = next;
    this.record(project, "phase-advanced", { from, to: next });
    this.save(project);
    return { advanced: true, phase: next, unmet: [] };
  }

  planSprint(id, { goal = "", days, capacity } = {}) {
    const project = this.get(id);
    if (project.sprints.some((sprint) => sprint.status === "active")) {
      throw new Error("A sprint is already active");
    }
    const sprintDays = Number(days ?? this.defaults.sprintDays);
    const sprintCapacity = Number(capacity ?? velocity(project.sprints).average ?? this.defaults.sprintCapacity);
    const start = this.clock().getTime();
    project.counters.sprint += 1;
    const sprint = {
      id: "S-" + project.counters.sprint,
      goal,
      start: new Date(start).toISOString(),
      end: new Date(start + sprintDays * DAY).toISOString(),
      capacity: sprintCapacity,
      status: "active",
      committed: [],
      completedPoints: null
    };
    let load = 0;
    const candidates = rankBacklog(project.workItems.filter((item) => item.status === "ready" && pointBearingTypes.includes(item.type)));
    for (const candidate of candidates) {
      const points = Number(candidate.points ?? 0);
      if (load + points > sprintCapacity) {
        continue;
      }
      const item = requireItem(project, candidate.id);
      item.sprint = sprint.id;
      sprint.committed.push(item.id);
      load += points;
    }
    project.sprints.push(sprint);
    this.record(project, "sprint-planned", { sprintId: sprint.id, committed: sprint.committed.length, capacity: sprintCapacity });
    this.save(project);
    return sprint;
  }

  closeSprint(id, { notes = "", actions = [] } = {}) {
    const project = this.get(id);
    const sprint = project.sprints.find((entry) => entry.status === "active");
    if (!sprint) {
      throw new Error("No active sprint");
    }
    const committed = project.workItems.filter((item) => item.sprint === sprint.id);
    sprint.completedPoints = committed
      .filter((item) => item.status === "done")
      .reduce((sum, item) => sum + Number(item.points ?? 0), 0);
    for (const item of committed) {
      if (item.status !== "done") {
        item.sprint = null;
      }
    }
    sprint.status = "closed";
    sprint.closedAt = this.now();
    project.retrospectives.push({ sprintId: sprint.id, at: this.now(), notes, actions });
    this.record(project, "sprint-closed", { sprintId: sprint.id, completedPoints: sprint.completedPoints });
    if (this.memory && (notes || actions.length)) {
      this.memory.append("decision", "[" + project.id + " " + sprint.id + " retrospective] " + [notes, ...actions].filter(Boolean).join("; "));
    }
    this.save(project);
    return sprint;
  }

  addRisk(id, { title, probability, impact, owner = null, mitigation = "", response = null }) {
    const project = this.get(id);
    riskScore({ probability, impact });
    project.counters.risk += 1;
    const risk = { id: "R-" + project.counters.risk, title, probability, impact, owner, mitigation, response, status: "open", createdAt: this.now() };
    project.risks.push(risk);
    this.record(project, "risk-added", { riskId: risk.id, title });
    this.save(project);
    return risk;
  }

  closeRisk(id, riskId) {
    const project = this.get(id);
    const risk = project.risks.find((entry) => entry.id === riskId);
    if (!risk) {
      throw new Error("Unknown risk: " + riskId);
    }
    risk.status = "closed";
    risk.closedAt = this.now();
    this.record(project, "risk-closed", { riskId });
    return this.save(project);
  }

  recordDecision(id, { title, context = "", choice }) {
    const project = this.get(id);
    project.counters.decision += 1;
    const decision = { id: "D-" + project.counters.decision, title, context, choice, at: this.now() };
    project.decisions.push(decision);
    this.record(project, "decision-recorded", { decisionId: decision.id, title });
    this.memory?.append("decision", "[" + project.id + "] " + title + ": " + choice);
    this.save(project);
    return decision;
  }

  criticalPath(id) {
    return this.criticalPathFrom(this.get(id));
  }

  forecast(id, { asOf, runs, seed } = {}) {
    const project = this.get(id);
    const now = asOf ?? this.now();
    const remainingPoints = totalPoints(project.workItems) - totalPoints(project.workItems.filter((item) => item.status === "done"));
    const samples = weeklyThroughput(project.workItems, now);
    const forecast = monteCarloForecast({ remainingPoints, throughputSamples: samples, runs, seed });
    return {
      remainingPoints,
      samples,
      forecast,
      dates: forecastDates({ forecast, from: now, periodDays: 7 }),
      targetDate: project.targetDate
    };
  }

  raci(id) {
    const project = this.get(id);
    const epics = project.workItems.filter((item) => item.type === "epic");
    const rows = [];
    for (const epic of epics) {
      const children = project.workItems.filter((item) => item.parent === epic.id);
      const responsible = [...new Set(children.map((item) => item.department).filter(Boolean))];
      rows.push({
        deliverable: epic.title,
        responsible: responsible.length ? responsible : ["engineering"],
        accountable: project.owner,
        consulted: ["architecture"],
        informed: ["qa", "documentation"]
      });
    }
    return rows;
  }

  digest(id, { sinceDays = 1, asOf } = {}) {
    const project = this.get(id);
    const now = new Date(asOf ?? this.now()).getTime();
    const since = now - sinceDays * DAY;
    const events = project.events.filter((event) => {
      const at = new Date(event.at).getTime();
      return at > since && at <= now;
    });
    const titles = new Map(project.workItems.map((item) => [item.id, item.title]));
    return {
      since: new Date(since).toISOString(),
      events: events.map((event) => ({ ...event, title: event.itemId ? titles.get(event.itemId) : undefined })),
      blocked: project.workItems.filter((item) => item.status === "blocked").map((item) => ({ id: item.id, title: item.title, reason: item.blockedReason }))
    };
  }

  status(id, { asOf } = {}) {
    const project = this.get(id);
    const now = asOf ?? this.now();
    const activeSprint = project.sprints.find((sprint) => sprint.status === "active") ?? null;
    const path = this.criticalPathFrom(project);
    const calibration = this.calibration();
    const calibratedDuration = calibration ? Math.round(path.duration * calibration.effortRatio * 100) / 100 : null;
    const remaining = project.workItems.filter((item) => pointBearingTypes.includes(item.type) && !["done", "descoped"].includes(item.status));
    const ids = new Set(remaining.map((item) => item.id));
    const scoped = remaining.map((item) => ({ ...item, dependsOn: item.dependsOn.filter((dep) => ids.has(dep)) }));
    const targetDays = project.targetDate ? (new Date(project.targetDate).getTime() - new Date(now).getTime()) / DAY : null;
    const samples = weeklyThroughput(project.workItems, now);
    return {
      project,
      health: healthScore(project, { asOf: now }),
      evm: earnedValue(project, now),
      velocity: velocity(project.sprints),
      scopeCreep: scopeCreep(project),
      estimateAccuracy: estimateAccuracy(project.workItems),
      criticalPath: path,
      calibration,
      calibratedDuration,
      onTimeProbability: targetDays !== null && scoped.length ? completionProbability(scoped, targetDays) : null,
      drift: samples.length >= 6 ? throughputDrift(samples) : null,
      forecast: this.forecast(id, { asOf: now }),
      risks: rankRisks(project.risks.filter((risk) => risk.status !== "closed")),
      activeSprint,
      nextActions: this.nextBestActions(project, { asOf: now })
    };
  }

  nextBestActions(project, { asOf, limit = 5 } = {}) {
    const now = new Date(asOf ?? this.now()).getTime();
    const actions = [];
    for (const item of project.workItems.filter((entry) => entry.status === "blocked")) {
      actions.push({ code: "unblock-item", priority: 1, params: { itemId: item.id, title: item.title, reason: item.blockedReason } });
    }
    for (const risk of rankRisks(project.risks.filter((entry) => entry.status !== "closed"))) {
      if (risk.band === "critical") {
        actions.push({ code: "mitigate-risk", priority: 1, params: { riskId: risk.id, title: risk.title } });
      }
    }
    if (project.phase === "execution" && !project.baseline) {
      actions.push({ code: "set-baseline", priority: 2, params: {} });
    }
    for (const violation of wipViolations(project)) {
      actions.push({ code: "reduce-wip", priority: 2, params: violation });
    }
    const path = this.criticalPathFrom(project);
    const byId = new Map(project.workItems.map((item) => [item.id, item]));
    const startable = path.path.map((itemId) => byId.get(itemId)).find((item) => item && item.status === "ready");
    if (startable) {
      actions.push({ code: "start-critical-item", priority: 2, params: { itemId: startable.id, title: startable.title } });
    }
    const activeSprint = project.sprints.find((sprint) => sprint.status === "active");
    if (activeSprint && new Date(activeSprint.end).getTime() < now) {
      actions.push({ code: "close-sprint", priority: 2, params: { sprintId: activeSprint.id } });
    }
    if (!activeSprint && project.phase === "execution") {
      actions.push({ code: "plan-sprint", priority: 3, params: {} });
    }
    for (const milestone of project.milestones) {
      if (milestone.status === "open" && milestone.due && new Date(milestone.due).getTime() < now) {
        actions.push({ code: "milestone-overdue", priority: 2, params: { milestoneId: milestone.id, title: milestone.title } });
      }
    }
    if (project.phase !== "closed" && this.gate(project).ok) {
      actions.push({ code: "advance-phase", priority: 3, params: { phase: project.phase } });
    }
    return actions.sort((a, b) => a.priority - b.priority).slice(0, limit);
  }

  criticalPathFrom(project) {
    const remaining = project.workItems.filter((item) => pointBearingTypes.includes(item.type) && !["done", "descoped"].includes(item.status));
    const ids = new Set(remaining.map((item) => item.id));
    return criticalPath(remaining.map((item) => ({ ...item, dependsOn: item.dependsOn.filter((dep) => ids.has(dep)) })));
  }
}

function requireItem(project, itemId) {
  const item = project.workItems.find((entry) => entry.id === itemId);
  if (!item) {
    throw new Error("Unknown work item: " + itemId);
  }
  return item;
}

function slug(name) {
  const value = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!value) {
    throw new Error("Project name must contain latin letters or digits");
  }
  return value;
}
