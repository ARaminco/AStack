import { jaccard, uniqueTokens } from "../lib/text.mjs";

export const CURATOR_THRESHOLDS = {
  duplicate: 0.5,
  nearDuplicate: 0.3,
  retireUses: 4,
  retireSuccessRate: 0.5,
  refineUses: 3,
  refineSuccessRate: 0.75,
  staleDays: 120
};

/**
 * The skill curator: a report over every skill source (built-in, learned and
 * packs) with usage, last use, success rate, duplicates across sources and a
 * keep / refine / retire recommendation per skill.
 *
 * It recommends; it changes nothing unless `apply` is set, and even then it
 * never touches a built-in skill: a learned skill is deprecated through the
 * learning engine (reversible with `astack skill promote`), a pack skill is
 * retired in `.astack/skill-hub/curation.json` (reversible by deleting the
 * entry). No file is ever deleted.
 */
export class Curator {
  constructor(hub, { thresholds = CURATOR_THRESHOLDS } = {}) {
    this.hub = hub;
    this.thresholds = thresholds;
  }

  usage() {
    const episodes = this.hub.learning?.experience?.all?.() ?? [];
    const byId = new Map();
    for (const episode of episodes) {
      if (!episode.skill) {
        continue;
      }
      const key = String(episode.skill);
      const entry = byId.get(key) ?? { uses: 0, successes: 0, failures: 0, lastUsed: null };
      entry.uses += 1;
      if (episode.outcome === "done") {
        entry.successes += 1;
      } else if (episode.outcome === "failed") {
        entry.failures += 1;
      }
      if (!entry.lastUsed || String(episode.at) > entry.lastUsed) {
        entry.lastUsed = episode.at;
      }
      byId.set(key, entry);
    }
    return byId;
  }

  skills() {
    const catalog = this.hub.catalog;
    const base = catalog ? catalog.list() : [];
    const packs = this.hub.entries({ includeBlocked: true, includeRetired: true });
    return [...base, ...packs];
  }

  run({ apply = false, source = null, limit = null, now = null } = {}) {
    const at = now ?? this.hub.now();
    const usage = this.usage();
    const all = this.skills();
    const signatures = all.map((skill) => ({
      skill,
      tokens: uniqueTokens([...(skill.keywords ?? []), ...(skill.tags ?? []), skill.description ?? "", (skill.id ?? "").split("/").pop().replace(/[-_]/g, " ")].join(" "))
    }));
    const duplicates = new Map();
    for (let left = 0; left < signatures.length; left += 1) {
      for (let right = left + 1; right < signatures.length; right += 1) {
        const a = signatures[left];
        const b = signatures[right];
        if (!a.tokens.length || !b.tokens.length) {
          continue;
        }
        const similarity = jaccard(a.tokens, b.tokens);
        if (similarity < this.thresholds.nearDuplicate) {
          continue;
        }
        const kind = similarity >= this.thresholds.duplicate ? "duplicate" : "near-duplicate";
        for (const [self, other] of [[a.skill, b.skill], [b.skill, a.skill]]) {
          const list = duplicates.get(self.id) ?? [];
          list.push({ id: other.id, source: other.source, similarity: Number(similarity.toFixed(3)), kind });
          duplicates.set(self.id, list);
        }
      }
    }

    const rank = (skill) => (skill.source === "builtin" ? 0 : skill.source === "learned" ? 1 : 2);
    const report = [];
    for (const skill of all) {
      if (source && skill.source !== source && !(source === "pack" && String(skill.source).startsWith("pack:"))) {
        continue;
      }
      const shortId = String(skill.id).split("/").pop();
      const recorded = usage.get(skill.id) ?? usage.get(shortId) ?? { uses: 0, successes: 0, failures: 0, lastUsed: null };
      const metrics = skill.metrics ?? null;
      const uses = Math.max(recorded.uses, metrics?.uses ?? 0);
      const successes = Math.max(recorded.successes, metrics?.successes ?? 0);
      const successRate = uses ? Number((successes / uses).toFixed(3)) : null;
      const lastUsed = [recorded.lastUsed, skill.lastUsedAt].filter(Boolean).sort().pop() ?? null;
      const twins = (duplicates.get(skill.id) ?? []).sort((a, b) => b.similarity - a.similarity).slice(0, 3);
      const { recommendation, reasons } = this.recommend(skill, { uses, successRate, lastUsed, twins, rank, all, at });
      report.push({
        id: skill.id,
        source: skill.source,
        status: skill.status ?? null,
        uses,
        successRate,
        lastUsed,
        duplicates: twins,
        recommendation,
        reasons
      });
    }
    report.sort((a, b) => order(a.recommendation) - order(b.recommendation) || a.id.localeCompare(b.id));

    const applied = [];
    if (apply) {
      const curation = this.hub.curation();
      curation.retired = curation.retired ?? {};
      for (const entry of report.filter((item) => item.recommendation === "retire")) {
        if (entry.source === "builtin") {
          continue;
        }
        if (entry.source === "learned" && entry.status !== "deprecated" && this.hub.learning?.setStatus) {
          this.hub.learning.setStatus(entry.id, "deprecated");
          applied.push({ id: entry.id, action: "deprecated" });
        } else if (String(entry.source).startsWith("pack:") && !curation.retired[entry.id]) {
          curation.retired[entry.id] = { at, reasons: entry.reasons };
          applied.push({ id: entry.id, action: "retired" });
        }
      }
      if (applied.some((entry) => entry.action === "retired")) {
        this.hub.saveCuration(curation);
      }
      if (applied.length) {
        this.hub.audit?.record({ actor: "skill-hub", tool: "skill-hub", action: "skill.curate", target: applied.length + " skills", riskLevel: "L2", result: applied.map((entry) => entry.id + ":" + entry.action).join(", ").slice(0, 900) });
      }
    }
    const summary = { keep: 0, refine: 0, retire: 0 };
    for (const entry of report) {
      summary[entry.recommendation] += 1;
    }
    return { at, apply, summary, skills: limit ? report.slice(0, limit) : report, applied };
  }

  recommend(skill, { uses, successRate, lastUsed, twins, rank, all, at }) {
    const reasons = [];
    const thresholds = this.thresholds;
    const isPack = String(skill.source).startsWith("pack:");
    const ageDays = lastUsed ? (new Date(at) - new Date(lastUsed)) / 86400000 : null;
    const strongerTwin = twins.find((twin) => {
      const other = all.find((entry) => entry.id === twin.id);
      return other && twin.kind === "duplicate" && rank(other) < rank(skill);
    });

    if (skill.source === "builtin") {
      if (twins.some((twin) => twin.kind === "duplicate" && twin.source === "builtin")) {
        reasons.push("overlaps another built-in skill: " + twins.filter((twin) => twin.source === "builtin")[0].id);
        return { recommendation: "refine", reasons };
      }
      reasons.push("built-in skills are never retired by the curator");
      return { recommendation: "keep", reasons };
    }
    if (isPack && skill.risk === "blocked") {
      reasons.push("blocked by the security scan");
      return { recommendation: "retire", reasons };
    }
    if (uses >= thresholds.retireUses && successRate !== null && successRate < thresholds.retireSuccessRate) {
      reasons.push("failing: success " + Math.round(successRate * 100) + "% over " + uses + " uses");
      return { recommendation: "retire", reasons };
    }
    if (isPack && strongerTwin) {
      reasons.push("duplicate of " + strongerTwin.id + " (" + strongerTwin.source + ", jaccard " + strongerTwin.similarity + ")");
      return { recommendation: "retire", reasons };
    }
    if (skill.source === "learned" && skill.status === "deprecated") {
      reasons.push("already deprecated");
      return { recommendation: "retire", reasons };
    }
    if (uses >= thresholds.refineUses && successRate !== null && successRate < thresholds.refineSuccessRate) {
      reasons.push("unreliable: success " + Math.round(successRate * 100) + "% over " + uses + " uses");
      return { recommendation: "refine", reasons };
    }
    if (isPack && skill.risk === "high") {
      reasons.push("high-risk scan findings need a human review");
      return { recommendation: "refine", reasons };
    }
    if (twins.some((twin) => twin.kind === "duplicate")) {
      reasons.push("overlaps " + twins[0].id + " (jaccard " + twins[0].similarity + "): merge or sharpen");
      return { recommendation: "refine", reasons };
    }
    if (skill.source === "learned" && ageDays !== null && ageDays > thresholds.staleDays) {
      reasons.push("not used for " + Math.round(ageDays) + " days");
      return { recommendation: "refine", reasons };
    }
    reasons.push(uses ? "in use: " + uses + " uses" + (successRate !== null ? ", success " + Math.round(successRate * 100) + "%" : "") : "no recorded use yet");
    return { recommendation: "keep", reasons };
  }
}

function order(recommendation) {
  return { retire: 0, refine: 1, keep: 2 }[recommendation] ?? 3;
}
