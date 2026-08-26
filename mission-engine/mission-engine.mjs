import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shortHash } from "../lib/text.mjs";

export const missionStates = ["created", "running", "waiting-approval", "paused", "blocked", "completed", "failed", "cancelled"];
export const stepStates = ["pending", "running", "waiting-approval", "done", "failed", "skipped"];

/**
 * Durable, resumable missions.
 *
 * A mission is the unit of work that survives a restart: an ordered plan of
 * tool steps, the authority each step needs, the approvals it collected, the
 * artifacts it produced and the exact point it stopped at. Anything that takes
 * longer than one conversation — a tax filing, a court deadline, a migration —
 * lives here rather than in a chat transcript.
 */
export class MissionEngine {
  constructor(root, { clock, eventBus, tools = null, approvals = null, audit = null, learning = null, memory = null, router = null, runtimes = null } = {}) {
    this.root = root;
    this.directory = join(root, ".astack", "missions");
    this.clock = clock ?? (() => new Date());
    this.eventBus = eventBus ?? null;
    this.tools = tools;
    this.approvals = approvals;
    this.audit = audit;
    this.learning = learning;
    this.memory = memory;
    this.router = router;
    this.runtimes = runtimes;
  }

  now() {
    return this.clock().toISOString();
  }

  path(id) {
    return join(this.directory, id + ".json");
  }

  exists(id) {
    return existsSync(this.path(id));
  }

  get(id) {
    if (this.simulating && this.projection?.id === id) {
      return this.projection;
    }
    if (!this.exists(id)) {
      throw new Error("Unknown mission: " + id);
    }
    return JSON.parse(readFileSync(this.path(id), "utf8"));
  }

  save(mission) {
    if (this.simulating) {
      // A dry run projects the plan; it never touches the mission on disk.
      mission.updatedAt = this.now();
      this.projection = mission;
      return mission;
    }
    mkdirSync(this.directory, { recursive: true });
    mission.updatedAt = this.now();
    writeFileSync(this.path(mission.id), JSON.stringify(mission, null, 2) + "\n", "utf8");
    return mission;
  }

  list({ state = null, project = null, domain = null, limit = 50 } = {}) {
    if (!existsSync(this.directory)) {
      return [];
    }
    return readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.get(name.replace(/\.json$/, "")))
      .filter((mission) => !state || mission.state === state)
      .filter((mission) => !project || mission.project === project)
      .filter((mission) => !domain || mission.domain === domain)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  }

  create({ title, goal = null, domain = null, project = null, team = null, steps = [], priority = "normal", deadline = null, tags = [], context = null, runtime = null }) {
    if (!title) {
      throw new Error("A mission needs a title");
    }
    const createdAt = this.now();
    const mission = {
      id: "M-" + shortHash(title, createdAt).slice(0, 10),
      title,
      goal: goal ?? title,
      domain,
      project,
      team,
      priority,
      deadline,
      tags,
      runtime,
      state: "created",
      createdAt,
      updatedAt: createdAt,
      currentStep: 0,
      steps: steps.map((step, index) => ({
        id: "S" + (index + 1),
        order: index + 1,
        title: step.title ?? step.action ?? "step " + (index + 1),
        tool: step.tool ?? null,
        action: step.action ?? null,
        params: step.params ?? {},
        authority: step.authority ?? null,
        runtime: step.runtime ?? null,
        state: "pending",
        attempts: 0,
        result: null,
        startedAt: null,
        finishedAt: null
      })),
      approvals: [],
      artifacts: [],
      findings: [],
      context,
      metrics: { steps: steps.length, done: 0, failed: 0, durationMs: 0, tokens: 0 },
      events: [{ at: createdAt, event: "created", title }]
    };
    this.save(mission);
    this.eventBus?.emit("mission.created", { id: mission.id, title, domain, steps: mission.steps.length });
    this.audit?.record({ actor: "mission-engine", action: "mission-created", target: mission.id, riskLevel: "L1", result: title, mission: mission.id, project });
    return mission;
  }

  record(mission, event, payload = {}) {
    mission.events = [...(mission.events ?? []), { at: this.now(), event, ...payload }].slice(-200);
    return mission;
  }

  /**
   * Run the mission from wherever it stopped. Every step goes through the tool
   * registry, so authority, policy and audit apply uniformly. A step that
   * needs approval parks the mission instead of guessing.
   */
  async run(id, options = {}) {
    if (options.dryRun) {
      this.simulating = true;
      this.projection = JSON.parse(JSON.stringify(this.get(id)));
      try {
        return await this.execute(id, options);
      } finally {
        this.simulating = false;
        this.projection = null;
      }
    }
    return this.execute(id, options);
  }

  async execute(id, { dryRun = false, maxSteps = 50, actor = "astack" } = {}) {
    let mission = this.get(id);
    if (["completed", "cancelled"].includes(mission.state)) {
      return { mission, ran: 0, summary: "mission is already " + mission.state };
    }
    mission.state = "running";
    this.save(mission);
    let ran = 0;
    const started = Date.now();
    for (let index = mission.currentStep; index < mission.steps.length && ran < maxSteps; index += 1) {
      mission = this.get(id);
      const step = mission.steps[index];
      if (step.state === "done" || step.state === "skipped") {
        mission.currentStep = index + 1;
        this.save(mission);
        continue;
      }
      // The receipt is verified and consumed by the tool registry, which is the
      // one place every external call passes through. Here we only decide
      // whether the mission may move at all.
      const approval = step.approvalId ? this.safeApproval(step.approvalId) : null;
      if (approval && approval.state !== "approved") {
        mission.state = approval.state === "pending" ? "waiting-approval" : "blocked";
        this.record(mission, "approval-" + approval.state, { step: step.id, approval: approval.id });
        this.save(mission);
        return {
          mission,
          ran,
          summary: approval.state === "consumed"
            ? "approval " + approval.id + " was already used; step " + step.id + " needs a new decision"
            : "waiting for approval " + approval.id + " on step " + step.id
        };
      }
      step.state = "running";
      step.startedAt = this.now();
      step.attempts += 1;
      mission.currentStep = index;
      this.save(mission);
      const outcome = await this.executeStep(mission, step, { dryRun, actor, approvalId: approval?.id ?? null });
      mission = this.get(id);
      const current = mission.steps[index];
      if (outcome.requiresApproval && !dryRun) {
        const request = this.approvals?.request({
          action: (step.tool ?? "mission") + "." + (step.action ?? step.title),
          summary: step.title,
          parameters: step.params,
          level: outcome.decision?.level ?? step.authority ?? "L4",
          mission: mission.id,
          project: mission.project,
          tool: step.tool,
          target: step.params?.url ?? step.params?.path ?? null,
          evidence: mission.artifacts.slice(-3)
        });
        current.state = "waiting-approval";
        current.approvalId = request?.id ?? null;
        mission.state = "waiting-approval";
        mission.approvals = [...new Set([...mission.approvals, request?.id].filter(Boolean))];
        this.record(mission, "approval-requested", { step: step.id, approval: request?.id });
        this.save(mission);
        this.eventBus?.emit("mission.waiting", { id: mission.id, step: step.id, approval: request?.id });
        return { mission, ran, summary: "stopped for approval on step " + step.id + " (" + step.title + ")", approval: request };
      }
      if (outcome.requiresApproval && dryRun) {
        current.state = "skipped";
        current.finishedAt = this.now();
        current.result = { ok: true, summary: "would stop here and ask the owner (" + (step.authority ?? "L4") + ")", data: null, durationMs: 0 };
        mission.currentStep = index + 1;
        this.record(mission, "dry-run-approval-point", { step: step.id });
        this.save(mission);
        ran += 1;
        continue;
      }
      current.state = outcome.ok ? "done" : "failed";
      current.finishedAt = this.now();
      current.result = {
        ok: outcome.ok,
        summary: outcome.summary ?? null,
        data: compact(outcome.data),
        durationMs: outcome.durationMs ?? 0
      };
      if (outcome.artifacts?.length) {
        mission.artifacts = [...mission.artifacts, ...outcome.artifacts];
      }
      if (outcome.findings?.length) {
        mission.findings = [...mission.findings, ...outcome.findings];
      }
      mission.metrics.done += outcome.ok ? 1 : 0;
      mission.metrics.failed += outcome.ok ? 0 : 1;
      ran += 1;
      if (!outcome.ok && step.required !== false) {
        mission.state = "failed";
        this.record(mission, "step-failed", { step: step.id, summary: outcome.summary });
        this.save(mission);
        this.eventBus?.emit("mission.failed", { id: mission.id, step: step.id });
        this.router?.recordOutcome(mission.runtime ?? "claude-code", {
          taskClass: this.router.classify(mission.title),
          outcome: "failed",
          durationMs: mission.metrics.durationMs,
          tokens: mission.metrics.tokens
        });
        await this.learn(mission, "failed");
        return { mission, ran, summary: "step " + step.id + " failed: " + outcome.summary };
      }
      mission.currentStep = index + 1;
      this.record(mission, "step-done", { step: step.id, summary: outcome.summary });
      this.save(mission);
    }
    mission = this.get(id);
    mission.metrics.durationMs += Date.now() - started;
    if (mission.currentStep >= mission.steps.length || dryRun) {
      mission.state = dryRun ? "created" : "completed";
      this.record(mission, dryRun ? "dry-run-finished" : "completed", {});
      this.save(mission);
      if (!dryRun) {
        this.eventBus?.emit("mission.completed", { id: mission.id, steps: mission.steps.length });
        this.audit?.record({
          actor,
          action: "mission-completed",
          target: mission.id,
          riskLevel: "L2",
          result: mission.title,
          mission: mission.id,
          project: mission.project,
          evidence: mission.artifacts
        });
        await this.learn(mission, "done");
        // Feed the router what actually happened, so later routing is based on
        // this owner's real workload rather than on the declared strengths.
        this.router?.recordOutcome(mission.runtime ?? "claude-code", {
          taskClass: this.router.classify(mission.title),
          outcome: "done",
          durationMs: mission.metrics.durationMs,
          tokens: mission.metrics.tokens
        });
      }
    } else {
      this.save(mission);
    }
    return { mission, ran, summary: mission.state === "completed" ? "mission completed" : "ran " + ran + " steps" };
  }

  safeApproval(id) {
    try {
      return this.approvals?.get(id) ?? null;
    } catch {
      return null;
    }
  }

  async executeStep(mission, step, { dryRun, actor, approvalId }) {
    if (!step.tool) {
      return { ok: true, summary: "manual step recorded: " + step.title };
    }
    if (!this.tools) {
      return { ok: false, summary: "no tool registry is wired into the mission engine" };
    }
    const result = await this.tools.invoke(step.tool, step.action, { ...step.params, mission: mission.id }, {
      mission: mission.id,
      actor,
      approvalId,
      dryRun,
      domain: mission.domain
    });
    const artifacts = result?.data?.artifacts ?? [];
    return { ...result, artifacts };
  }

  /**
   * Turn a finished mission into experience, but only when it is substantial
   * enough to be worth a learning pass.
   */
  async learn(mission, outcome) {
    if (!this.learning) {
      return null;
    }
    const meaningful = mission.steps.length >= 2 || outcome === "failed";
    if (!meaningful) {
      return null;
    }
    return this.learning.record({
      task: mission.title,
      domain: mission.domain ?? "general",
      project: mission.project,
      steps: mission.steps.map((step) => ({ action: step.title, tool: step.tool, target: step.params?.url ?? null })),
      outcome: outcome === "done" ? "done" : "failed",
      durationMs: mission.metrics.durationMs,
      artifacts: mission.artifacts,
      notes: mission.findings.slice(0, 5).join(" | ") || null
    });
  }

  resume(id, { note = null } = {}) {
    const mission = this.get(id);
    if (!["paused", "waiting-approval", "blocked", "failed"].includes(mission.state)) {
      return mission;
    }
    mission.state = "running";
    const step = mission.steps[mission.currentStep];
    if (step && step.state === "failed") {
      step.state = "pending";
    }
    this.record(mission, "resumed", { note });
    this.save(mission);
    this.eventBus?.emit("mission.resumed", { id });
    return mission;
  }

  pause(id, { reason = null } = {}) {
    const mission = this.get(id);
    mission.state = "paused";
    this.record(mission, "paused", { reason });
    this.save(mission);
    return mission;
  }

  cancel(id, { reason = null } = {}) {
    const mission = this.get(id);
    mission.state = "cancelled";
    this.record(mission, "cancelled", { reason });
    this.save(mission);
    this.audit?.record({ actor: "owner", action: "mission-cancelled", target: id, riskLevel: "L1", result: reason ?? "cancelled", mission: id });
    return mission;
  }

  addStep(id, step) {
    const mission = this.get(id);
    const order = mission.steps.length + 1;
    mission.steps.push({
      id: "S" + order,
      order,
      title: step.title ?? step.action ?? "step " + order,
      tool: step.tool ?? null,
      action: step.action ?? null,
      params: step.params ?? {},
      authority: step.authority ?? null,
      runtime: step.runtime ?? null,
      state: "pending",
      attempts: 0,
      result: null,
      startedAt: null,
      finishedAt: null
    });
    mission.metrics.steps = mission.steps.length;
    this.save(mission);
    return mission;
  }

  report(id, { summary, findings = [], artifacts = [], outcome = "done" }) {
    const mission = this.get(id);
    mission.findings = [...mission.findings, ...findings];
    mission.artifacts = [...mission.artifacts, ...artifacts];
    mission.report = { summary, at: this.now(), outcome };
    mission.state = outcome === "done" ? "completed" : "failed";
    this.record(mission, "reported", { outcome });
    this.save(mission);
    return mission;
  }

  /**
   * Replay a finished mission without side effects: the same plan is executed
   * in dry run so a skill or a regression can be checked against real history.
   */
  async replay(id, { actor = "astack" } = {}) {
    const original = this.get(id);
    const copy = this.create({
      title: "[replay] " + original.title,
      goal: original.goal,
      domain: original.domain,
      project: original.project,
      steps: original.steps.map((step) => ({ title: step.title, tool: step.tool, action: step.action, params: step.params, authority: step.authority })),
      tags: [...(original.tags ?? []), "replay"]
    });
    const result = await this.run(copy.id, { dryRun: true, actor });
    return { original: original.id, replay: copy.id, summary: result.summary, steps: result.mission.steps.map((step) => ({ id: step.id, title: step.title, state: step.state })) };
  }

  status() {
    const missions = this.list({ limit: 500 });
    const byState = {};
    for (const mission of missions) {
      byState[mission.state] = (byState[mission.state] ?? 0) + 1;
    }
    return {
      missions: missions.length,
      active: missions.filter((mission) => ["running", "waiting-approval", "paused"].includes(mission.state)).length,
      waitingApproval: missions.filter((mission) => mission.state === "waiting-approval").length,
      byState,
      recent: missions.slice(0, 5).map((mission) => ({ id: mission.id, title: mission.title, state: mission.state, step: mission.currentStep + "/" + mission.steps.length }))
    };
  }
}

function compact(data) {
  if (data === null || data === undefined) {
    return null;
  }
  const text = JSON.stringify(data);
  if (!text || text.length <= 2000) {
    return data;
  }
  return { truncated: true, preview: text.slice(0, 2000) };
}
