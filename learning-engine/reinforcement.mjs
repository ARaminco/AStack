export const PROMOTION_POLICY = {
  activate: { uses: 3, successRate: 0.75 },
  trust: { uses: 10, successRate: 0.85 },
  deprecate: { uses: 4, successRate: 0.5 },
  priorWeight: 4
};

/**
 * Closed loop quality control for learned skills.
 *
 * A skill is not trusted because it was generated; it is trusted because it
 * kept working. Every reported use moves its confidence with a Bayesian update
 * and can promote it, or retire it when it starts failing.
 */
export class Reinforcement {
  constructor(forge, { clock, memory, eventBus, policy = PROMOTION_POLICY } = {}) {
    this.forge = forge;
    this.clock = clock ?? (() => new Date());
    this.memory = memory ?? null;
    this.eventBus = eventBus ?? null;
    this.policy = policy;
  }

  now() {
    return this.clock().toISOString();
  }

  feedback(id, { outcome = "done", durationMs = 0, note = null, episode = null } = {}) {
    if (!["done", "failed", "partial"].includes(outcome)) {
      throw new Error("Feedback outcome must be done, failed or partial");
    }
    const manifest = this.forge.read(id);
    const metrics = { ...manifest.metrics };
    metrics.uses += 1;
    if (outcome === "done") {
      metrics.successes += 1;
    } else if (outcome === "failed") {
      metrics.failures += 1;
    }
    metrics.successRate = Number((metrics.successes / metrics.uses).toFixed(3));
    metrics.avgDurationMs = Math.round(((manifest.metrics.avgDurationMs ?? 0) * (metrics.uses - 1) + Number(durationMs || 0)) / metrics.uses);
    const prior = manifest.evidence?.successRate ?? 0.6;
    const weight = this.policy.priorWeight;
    manifest.confidence = Number(
      Math.min(0.95, (prior * weight + metrics.successes) / (weight + metrics.uses)).toFixed(3)
    );
    manifest.metrics = metrics;
    manifest.lastUsedAt = this.now();
    manifest.updatedAt = this.now();
    if (note) {
      manifest.guardrails = [...(manifest.guardrails ?? [])];
      if (outcome !== "done") {
        manifest.guardrails.push({ from: episode ?? "feedback", outcome, note: String(note).slice(0, 240) });
        manifest.guardrails = manifest.guardrails.slice(-12);
      }
    }
    const transition = this.evaluate(manifest);
    if (transition) {
      // A lifecycle change is worth a version of its own: it is the point a
      // rollback would want to return to.
      manifest.status = transition;
      manifest.version = (manifest.version ?? 1) + 1;
    }
    manifest.history = [
      ...(manifest.history ?? []),
      { at: this.now(), event: "feedback", outcome, confidence: manifest.confidence, status: manifest.status }
    ].slice(-40);
    this.forge.save(manifest);
    this.forge.writeDocuments(manifest, null);
    this.memory?.facets?.append("lesson", {
      title: "skill feedback: " + manifest.name + " -> " + outcome,
      body: note ?? "",
      tags: ["skill", manifest.id, outcome],
      refs: [manifest.id, episode].filter(Boolean),
      confidence: outcome === "done" ? 0.7 : 0.5,
      source: "reinforcement"
    });
    this.eventBus?.emit("skill.feedback", { id, outcome, status: manifest.status, confidence: manifest.confidence });
    return manifest;
  }

  evaluate(manifest) {
    const { uses, successRate } = manifest.metrics;
    if (manifest.status === "deprecated") {
      return null;
    }
    if (uses >= this.policy.deprecate.uses && successRate < this.policy.deprecate.successRate) {
      return "deprecated";
    }
    if (uses >= this.policy.trust.uses && successRate >= this.policy.trust.successRate) {
      return "trusted";
    }
    if (uses >= this.policy.activate.uses && successRate >= this.policy.activate.successRate && manifest.status === "draft") {
      return "active";
    }
    return null;
  }

  /**
   * Skills that are no longer earning their place: never used, or used and
   * failing. Surfaced so the owner can retire them deliberately.
   */
  review({ staleDays = 120, now = null } = {}) {
    const reference = new Date(now ?? this.now()).getTime();
    return this.forge.list().map((manifest) => {
      const lastUsed = manifest.lastUsedAt ? new Date(manifest.lastUsedAt).getTime() : new Date(manifest.createdAt).getTime();
      const idleDays = Math.round((reference - lastUsed) / (24 * 60 * 60 * 1000));
      const verdict = manifest.status === "deprecated"
        ? "retired"
        : manifest.metrics.uses === 0 && idleDays > staleDays
          ? "unused"
          : manifest.metrics.uses >= this.policy.deprecate.uses && manifest.metrics.successRate < this.policy.deprecate.successRate
            ? "failing"
            : "healthy";
      return {
        id: manifest.id,
        name: manifest.name,
        status: manifest.status,
        confidence: manifest.confidence,
        uses: manifest.metrics.uses,
        successRate: manifest.metrics.successRate,
        idleDays,
        verdict
      };
    });
  }
}
