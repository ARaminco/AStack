import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shortHash } from "../lib/text.mjs";

export const sessionStates = ["created", "running", "paused", "waiting-approval", "completed", "failed", "cancelled", "handed-off"];

/**
 * The runtime abstraction.
 *
 * A runtime is whatever actually executes an agent turn: Claude Code today, a
 * CLI based coding agent, a local model, or a future service. Everything above
 * this interface — teams, missions, skills, tools — is provider independent.
 */
export class AgentRuntime {
  constructor(id, { root, clock, eventBus, config = {} } = {}) {
    this.id = id;
    this.root = root;
    this.clock = clock ?? (() => new Date());
    this.eventBus = eventBus ?? null;
    this.config = config;
    this.directory = join(root, ".astack", "runtimes", id);
  }

  now() {
    return this.clock().toISOString();
  }

  /** Metadata used by the model router and `astack runtime list`. */
  describe() {
    return {
      id: this.id,
      name: this.id,
      status: "mock-only",
      capabilities: [],
      strengths: [],
      contextWindow: null,
      costClass: "unknown",
      available: false
    };
  }

  sessionPath(sessionId) {
    return join(this.directory, sessionId + ".json");
  }

  saveSession(session) {
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(this.sessionPath(session.id), JSON.stringify(session, null, 2) + "\n", "utf8");
    return session;
  }

  readSession(sessionId) {
    const path = this.sessionPath(sessionId);
    if (!existsSync(path)) {
      throw new Error("Unknown runtime session: " + sessionId);
    }
    return JSON.parse(readFileSync(path, "utf8"));
  }

  sessions() {
    if (!existsSync(this.directory)) {
      return [];
    }
    return readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.readSession(name.replace(/\.json$/, "")));
  }

  start({ mission = null, role = "generalist", objective, brief = {}, model = null }) {
    if (!objective) {
      throw new Error("A runtime session needs an objective");
    }
    const createdAt = this.now();
    const session = {
      id: "S-" + shortHash(this.id, objective, createdAt).slice(0, 10),
      runtime: this.id,
      mission,
      role,
      objective,
      brief,
      model,
      state: "created",
      createdAt,
      updatedAt: createdAt,
      steps: [],
      artifacts: [],
      report: null,
      metrics: { turns: 0, tokens: 0, durationMs: 0 }
    };
    this.saveSession(session);
    this.eventBus?.emit("runtime.session.started", { runtime: this.id, session: session.id, mission });
    return session;
  }

  async run(sessionId) {
    const session = this.readSession(sessionId);
    return this.saveSession({ ...session, state: "failed", updatedAt: this.now(), report: "runtime " + this.id + " has no execution adapter installed" });
  }

  resume(sessionId, { note = null } = {}) {
    const session = this.readSession(sessionId);
    return this.saveSession({ ...session, state: "running", updatedAt: this.now(), steps: [...session.steps, { at: this.now(), event: "resumed", note }] });
  }

  pause(sessionId, { reason = null } = {}) {
    const session = this.readSession(sessionId);
    return this.saveSession({ ...session, state: "paused", updatedAt: this.now(), steps: [...session.steps, { at: this.now(), event: "paused", reason }] });
  }

  cancel(sessionId, { reason = null } = {}) {
    const session = this.readSession(sessionId);
    return this.saveSession({ ...session, state: "cancelled", updatedAt: this.now(), steps: [...session.steps, { at: this.now(), event: "cancelled", reason }] });
  }

  /** Structured handoff: never a raw transcript, always a compact package. */
  handoff(sessionId, { to, task, whatWasDone = "", findings = [], artifacts = [], openQuestions = [], recommendedNextStep = "" }) {
    const session = this.readSession(sessionId);
    const packet = { from: session.id, to, task, whatWasDone, findings, artifacts, openQuestions, recommendedNextStep, at: this.now() };
    this.saveSession({ ...session, state: "handed-off", updatedAt: this.now(), steps: [...session.steps, { at: this.now(), event: "handoff", to }] });
    this.eventBus?.emit("runtime.handoff", { runtime: this.id, session: session.id, to });
    return packet;
  }

  spawn({ parentSessionId, objective, role = "specialist", model = null }) {
    const parent = this.readSession(parentSessionId);
    const child = this.start({ mission: parent.mission, role, objective, brief: { parent: parent.id }, model });
    this.saveSession({ ...parent, steps: [...parent.steps, { at: this.now(), event: "spawned", child: child.id }] });
    return child;
  }

  report(sessionId, { summary, findings = [], artifacts = [], tokens = 0, durationMs = 0, outcome = "done" }) {
    const session = this.readSession(sessionId);
    const updated = {
      ...session,
      state: outcome === "done" ? "completed" : "failed",
      updatedAt: this.now(),
      report: { summary, findings, artifacts, outcome, at: this.now() },
      artifacts: [...session.artifacts, ...artifacts],
      metrics: {
        turns: session.metrics.turns + 1,
        tokens: session.metrics.tokens + Number(tokens || 0),
        durationMs: session.metrics.durationMs + Number(durationMs || 0)
      }
    };
    this.saveSession(updated);
    this.eventBus?.emit("runtime.session.reported", { runtime: this.id, session: sessionId, outcome });
    return updated;
  }

  status(sessionId = null) {
    if (sessionId) {
      const session = this.readSession(sessionId);
      return { id: session.id, state: session.state, runtime: this.id, updatedAt: session.updatedAt, metrics: session.metrics };
    }
    const sessions = this.sessions();
    return {
      runtime: this.id,
      sessions: sessions.length,
      active: sessions.filter((session) => ["created", "running", "paused", "waiting-approval"].includes(session.state)).length,
      completed: sessions.filter((session) => session.state === "completed").length
    };
  }
}

/**
 * Registry of installed runtimes. Adapters register themselves here so the
 * model router and the CLI can enumerate what this workspace can actually run.
 */
export class RuntimeRegistry {
  constructor(root, { clock, eventBus } = {}) {
    this.root = root;
    this.clock = clock;
    this.eventBus = eventBus;
    this.runtimes = new Map();
  }

  register(runtime) {
    this.runtimes.set(runtime.id, runtime);
    return runtime;
  }

  get(id) {
    const runtime = this.runtimes.get(id);
    if (!runtime) {
      throw new Error("Unknown runtime: " + id + ". Available: " + [...this.runtimes.keys()].join(", "));
    }
    return runtime;
  }

  has(id) {
    return this.runtimes.has(id);
  }

  list() {
    return [...this.runtimes.values()].map((runtime) => runtime.describe());
  }

  available() {
    return this.list().filter((runtime) => runtime.available);
  }

  status() {
    return [...this.runtimes.values()].map((runtime) => runtime.status());
  }
}
