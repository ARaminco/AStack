import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const taskClasses = ["classification", "extraction", "analysis", "reasoning", "coding", "browsing", "writing", "review"];

const DEFAULT_ROUTES = {
  classification: { tier: "fast", minReasoning: 1 },
  extraction: { tier: "fast", minReasoning: 1 },
  writing: { tier: "standard", minReasoning: 2 },
  analysis: { tier: "standard", minReasoning: 2 },
  browsing: { tier: "standard", minReasoning: 2 },
  review: { tier: "strong", minReasoning: 3 },
  reasoning: { tier: "strong", minReasoning: 3 },
  coding: { tier: "coding", minReasoning: 3 }
};

const DEFAULT_TIERS = {
  fast: { costClass: "low", contextWindow: 32000 },
  standard: { costClass: "medium", contextWindow: 128000 },
  strong: { costClass: "high", contextWindow: 200000 },
  coding: { costClass: "high", contextWindow: 200000 }
};

/**
 * Model and runtime routing.
 *
 * The router never hard codes a commercial model name. It maps a task class,
 * its risk and its expected context size onto a tier, then picks the installed
 * runtime whose declared strengths and history fit best. Owners override any
 * part of that mapping in configuration.
 */
export class ModelRouter {
  constructor(root, { registry, clock, config = {} } = {}) {
    this.root = root;
    this.registry = registry;
    this.clock = clock ?? (() => new Date());
    this.path = join(root, ".astack", "runtimes", "routing.json");
    this.config = config;
    this.routes = { ...DEFAULT_ROUTES, ...(config.routes ?? {}) };
    this.tiers = { ...DEFAULT_TIERS, ...(config.tiers ?? {}) };
  }

  performancePath() {
    return join(this.root, ".astack", "runtimes", "performance.json");
  }

  performance() {
    const path = this.performancePath();
    if (!existsSync(path)) {
      return {};
    }
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return {};
    }
  }

  /**
   * Record how a runtime actually performed so later routing prefers what
   * works for this owner's real workload.
   */
  recordOutcome(runtimeId, { taskClass = "reasoning", outcome = "done", durationMs = 0, tokens = 0 }) {
    const stats = this.performance();
    const key = runtimeId + ":" + taskClass;
    const entry = stats[key] ?? { runs: 0, successes: 0, failures: 0, tokens: 0, durationMs: 0 };
    entry.runs += 1;
    entry[outcome === "done" ? "successes" : "failures"] += 1;
    entry.tokens += Number(tokens || 0);
    entry.durationMs += Number(durationMs || 0);
    entry.successRate = Number((entry.successes / entry.runs).toFixed(3));
    entry.avgTokens = Math.round(entry.tokens / entry.runs);
    entry.avgDurationMs = Math.round(entry.durationMs / entry.runs);
    stats[key] = entry;
    mkdirSync(join(this.root, ".astack", "runtimes"), { recursive: true });
    writeFileSync(this.performancePath(), JSON.stringify(stats, null, 2) + "\n", "utf8");
    return entry;
  }

  classify(task = "") {
    const text = String(task).toLowerCase();
    if (/(code|refactor|implement|bug|deploy|test suite|کد|برنامه|باگ)/.test(text)) {
      return "coding";
    }
    if (/(browse|portal|website|login|form|سایت|پورتال|فرم)/.test(text)) {
      return "browsing";
    }
    if (/(review|audit|verify|بازبینی|حسابرسی|راستی)/.test(text)) {
      return "review";
    }
    if (/(extract|parse|ocr|استخراج|خواندن)/.test(text)) {
      return "extraction";
    }
    if (/(classify|route|دسته|طبقه)/.test(text)) {
      return "classification";
    }
    if (/(write|draft|report|نگارش|گزارش|لایحه)/.test(text)) {
      return "writing";
    }
    if (/(analyz|analyse|assess|تحلیل|بررسی)/.test(text)) {
      return "analysis";
    }
    return "reasoning";
  }

  /**
   * Choose the runtime and tier for one unit of work.
   */
  route({ task = "", taskClass = null, risk = "L1", contextTokens = 0, privacy = "normal", requiresTools = [], preferred = null } = {}) {
    const resolvedClass = taskClass ?? this.classify(task);
    const base = this.routes[resolvedClass] ?? this.routes.reasoning;
    let tier = base.tier;
    if (["L4", "L5"].includes(risk) && tier === "fast") {
      tier = "standard";
    }
    if (risk === "L4" && tier === "standard") {
      tier = "strong";
    }
    if (contextTokens > (this.tiers[tier]?.contextWindow ?? 128000)) {
      tier = "strong";
    }
    const installed = this.registry ? this.registry.list() : [];
    const candidates = installed
      .filter((runtime) => runtime.available)
      .filter((runtime) => privacy !== "local-only" || (runtime.capabilities ?? []).includes("local"))
      .map((runtime) => {
        const performance = this.performance()[runtime.id + ":" + resolvedClass];
        const strengthMatch = (runtime.strengths ?? []).some((strength) => resolvedClass.includes(strength) || strength.includes(resolvedClass)) ? 0.4 : 0;
        const toolMatch = requiresTools.length
          ? requiresTools.every((tool) => (runtime.capabilities ?? []).includes("tool-use")) ? 0.2 : -0.3
          : 0;
        const history = performance ? (performance.successRate - 0.5) * 0.6 : 0;
        const preference = preferred && runtime.id === preferred ? 0.5 : 0;
        const contextFit = runtime.contextWindow && contextTokens > runtime.contextWindow ? -0.6 : 0.1;
        return { runtime, score: Number((strengthMatch + toolMatch + history + preference + contextFit).toFixed(3)) };
      })
      .sort((a, b) => b.score - a.score);
    const chosen = candidates[0]?.runtime ?? installed[0] ?? null;
    return {
      taskClass: resolvedClass,
      tier,
      runtime: chosen?.id ?? null,
      runtimeName: chosen?.name ?? null,
      costClass: this.tiers[tier]?.costClass ?? "medium",
      contextWindow: this.tiers[tier]?.contextWindow ?? null,
      alternatives: candidates.slice(1, 3).map((entry) => entry.runtime.id),
      reason:
        "task class " + resolvedClass + " maps to tier " + tier +
        (chosen ? " and runtime " + chosen.id : " but no runtime is installed") +
        (risk === "L4" ? " (raised for a high authority action)" : "")
    };
  }

  describe() {
    return { routes: this.routes, tiers: this.tiers, performance: this.performance() };
  }
}

export { DEFAULT_ROUTES, DEFAULT_TIERS };
