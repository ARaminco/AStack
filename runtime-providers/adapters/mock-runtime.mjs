import { AgentRuntime } from "../agent-runtime.mjs";

/**
 * Deterministic runtime used by tests and by `astack runtime test`.
 *
 * It executes nothing outside the process: it echoes a structured result built
 * from the brief, which makes the whole mission lifecycle testable without a
 * model, a network call or a paid provider.
 */
export class MockRuntime extends AgentRuntime {
  constructor(options = {}) {
    super(options.id ?? "mock", options);
    this.behaviour = options.config?.behaviour ?? "succeed";
  }

  describe() {
    return {
      id: this.id,
      name: "Deterministic mock runtime",
      status: "mock-only",
      capabilities: ["reasoning", "tool-use"],
      strengths: ["testing"],
      contextWindow: 32000,
      costClass: "free",
      available: true,
      note: "Used for deterministic tests and dry runs."
    };
  }

  async run(sessionId) {
    const session = this.readSession(sessionId);
    if (this.behaviour === "fail") {
      return this.report(sessionId, { summary: "mock failure for " + session.objective, outcome: "failed", tokens: 120, durationMs: 5 });
    }
    if (this.behaviour === "approval") {
      return this.saveSession({
        ...session,
        state: "waiting-approval",
        updatedAt: this.now(),
        steps: [...session.steps, { at: this.now(), event: "approval-required", objective: session.objective }]
      });
    }
    const findings = (session.brief?.contextLines ?? []).slice(0, 3).map((line) => String(line).slice(0, 120));
    return this.report(sessionId, {
      summary: "mock completed: " + session.objective,
      findings,
      artifacts: [],
      tokens: 250,
      durationMs: 10,
      outcome: "done"
    });
  }
}
