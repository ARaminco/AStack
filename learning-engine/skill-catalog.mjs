import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens, jaccard, uniqueTokens } from "../lib/text.mjs";

const DOMAIN_HINTS = {
  legal: ["legal", "case", "court", "contract", "حقوق", "پرونده", "قرارداد"],
  finance: ["finance", "cost", "budget", "مالی", "بودجه"],
  accounting: ["accounting", "ledger", "invoice", "حساب", "فاکتور"],
  tax: ["tax", "vat", "مالیات", "ارزش افزوده"],
  software: ["code", "api", "laravel", "node", "react", "docker", "ci", "database", "performance", "security", "architecture", "refactor", "bug", "test", "deployment"],
  marketing: ["marketing", "seo", "campaign", "بازاریابی"],
  research: ["research", "prompt", "rag", "ai", "پژوهش"],
  operations: ["ops", "runbook", "incident", "عملیات"]
};

/**
 * One catalog over every skill the workspace has: the hand written packs that
 * ship with AStack and the ones the learning engine forged from real work.
 *
 * Progressive disclosure is the rule. Agents get a one line entry per skill and
 * load the full SKILL.md only for the one they picked, which is what keeps a
 * large skill library from eating the context window.
 */
export class SkillCatalog {
  constructor(root, { learning = null, workspaceRoot = null } = {}) {
    this.root = root;
    this.workspaceRoot = workspaceRoot ?? root;
    this.learning = learning;
    this.builtinDirectory = join(root, "skills");
    this.learnedDirectory = join(this.workspaceRoot, "skills", "learned");
  }

  builtin() {
    if (!existsSync(this.builtinDirectory)) {
      return [];
    }
    return readdirSync(this.builtinDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "learned")
      .map((entry) => {
        const path = join(this.builtinDirectory, entry.name, "SKILL.md");
        const manifestPath = join(this.builtinDirectory, entry.name, "skill.json");
        if (existsSync(manifestPath)) {
          try {
            const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
            return { ...manifest, source: manifest.source ?? "builtin", path: "skills/" + entry.name + "/SKILL.md" };
          } catch {
            return null;
          }
        }
        if (!existsSync(path)) {
          return null;
        }
        const text = readFileSync(path, "utf8");
        const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? entry.name;
        const mission = /##\s*ماموریت\s*\n+([^\n]+)/.exec(text)?.[1]?.trim() ?? "";
        const axes = [...text.matchAll(/^-\s+(.{2,60})$/gm)].slice(0, 12).map((match) => match[1].trim());
        return {
          id: entry.name,
          name: title,
          nameFa: title,
          source: "builtin",
          status: "trusted",
          confidence: 0.8,
          domains: [detectDomain(entry.name + " " + axes.join(" "))],
          keywords: uniqueTokens(entry.name.replace(/-/g, " ") + " " + axes.join(" ")).slice(0, 14),
          description: mission.slice(0, 200),
          path: "skills/" + entry.name + "/SKILL.md",
          requiredTools: [],
          riskLevel: "L1"
        };
      })
      .filter(Boolean);
  }

  learned() {
    const skills = this.learning?.forge?.list() ?? [];
    return skills.map((skill) => ({ ...skill, path: "skills/learned/" + skill.id + "/SKILL.md" }));
  }

  list({ status = null, domain = null, source = null } = {}) {
    return [...this.builtin(), ...this.learned()]
      .filter((skill) => !status || skill.status === status)
      .filter((skill) => !domain || (skill.domains ?? []).includes(domain))
      .filter((skill) => !source || skill.source === source)
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || a.id.localeCompare(b.id));
  }

  get(id) {
    const skill = this.list().find((entry) => entry.id === id);
    if (!skill) {
      throw new Error("Unknown skill: " + id);
    }
    return skill;
  }

  /**
   * The lightweight catalog handed to an agent at startup.
   */
  catalog({ budget = 600, domain = null } = {}) {
    const lines = [];
    let used = 0;
    for (const skill of this.list({ domain })) {
      const line = "- " + skill.id + " [" + (skill.status ?? "trusted") + " " + (skill.confidence ?? 0.8) + "] " + (skill.domains ?? []).join("/") + ": " + (skill.description ?? skill.name ?? "").slice(0, 80);
      const cost = estimateTokens(line);
      if (used + cost > budget) {
        break;
      }
      used += cost;
      lines.push(line);
    }
    return { lines, tokens: used, listed: lines.length, total: this.list().length };
  }

  search(query, { limit = 5, domain = null } = {}) {
    const tokens = uniqueTokens(query);
    return this.list({ domain })
      .map((skill) => {
        const haystack = uniqueTokens([skill.id, skill.name, skill.description, ...(skill.keywords ?? [])].join(" "));
        const overlap = jaccard(tokens, haystack);
        const learnedBoost = skill.source === "learned" ? 0.15 : 0;
        const trust = { candidate: 0.6, draft: 0.8, active: 1, trusted: 1.1, deprecated: 0.2 }[skill.status] ?? 1;
        return { skill, score: Number(((overlap + learnedBoost) * trust).toFixed(3)) };
      })
      .filter((entry) => entry.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => ({
        id: entry.skill.id,
        name: entry.skill.nameFa ?? entry.skill.name,
        source: entry.skill.source,
        status: entry.skill.status,
        confidence: entry.skill.confidence,
        path: entry.skill.path,
        score: entry.score
      }));
  }

  /**
   * Full content, loaded only when a skill has actually been selected.
   */
  show(id) {
    const skill = this.get(id);
    const absolute = join(skill.source === "learned" ? this.workspaceRoot : this.root, skill.path);
    const content = existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
    return { ...skill, content, tokens: estimateTokens(content) };
  }

  history(id) {
    const skill = this.get(id);
    if (skill.source !== "learned") {
      return { id, versions: [], history: [] };
    }
    const directory = join(this.learnedDirectory, id, "versions");
    const versions = existsSync(directory)
      ? readdirSync(directory)
          .filter((name) => name.endsWith(".json"))
          .map((name) => {
            const manifest = JSON.parse(readFileSync(join(directory, name), "utf8"));
            return {
              version: manifest.version,
              at: manifest.updatedAt,
              status: manifest.status,
              confidence: manifest.confidence,
              uses: manifest.metrics?.uses ?? 0,
              successRate: manifest.metrics?.successRate ?? 0
            };
          })
          .sort((a, b) => a.version - b.version)
      : [];
    return { id, current: skill.version, versions, history: skill.history ?? [] };
  }

  rollback(id, version) {
    const skill = this.get(id);
    if (skill.source !== "learned") {
      throw new Error("Only learned skills carry versions: " + id);
    }
    const path = join(this.learnedDirectory, id, "versions", "v" + version + ".json");
    if (!existsSync(path)) {
      throw new Error("Unknown version " + version + " for skill " + id);
    }
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    const restored = {
      ...manifest,
      version: (skill.version ?? manifest.version) + 1,
      status: manifest.status === "deprecated" ? "draft" : manifest.status,
      history: [...(skill.history ?? []), { at: new Date().toISOString(), event: "rolled-back", to: version }]
    };
    this.learning.forge.save(restored);
    this.learning.forge.writeDocuments(restored, null);
    return restored;
  }

  promote(id, status) {
    const skill = this.get(id);
    if (skill.source !== "learned") {
      throw new Error("Only learned skills change status: " + id);
    }
    return this.learning.forge.setStatus(id, status);
  }

  /**
   * Static validation of a skill package: does it still have everything it
   * needs to be executed safely. This is a check, not a simulated run.
   */
  test(id) {
    const skill = this.show(id);
    const problems = [];
    if (!skill.content.trim()) {
      problems.push("SKILL.md is missing or empty");
    }
    if (skill.source === "learned") {
      if (!(skill.procedure ?? []).length) {
        problems.push("no procedure steps recorded");
      }
      if (!(skill.procedure ?? []).some((step) => step.required)) {
        problems.push("no required step: the procedure is not reproducible");
      }
      if ((skill.evidence?.occurrences ?? 0) < 2) {
        problems.push("thin evidence: fewer than two recorded runs");
      }
      if ((skill.metrics?.uses ?? 0) >= 4 && (skill.metrics?.successRate ?? 1) < 0.5) {
        problems.push("failing in production: success rate below 50 percent");
      }
    }
    return {
      id,
      source: skill.source,
      status: skill.status,
      confidence: skill.confidence,
      ready: problems.length === 0,
      problems,
      tokens: skill.tokens
    };
  }

  stats() {
    const all = this.list();
    const byStatus = {};
    const bySource = {};
    for (const skill of all) {
      byStatus[skill.status ?? "unknown"] = (byStatus[skill.status ?? "unknown"] ?? 0) + 1;
      bySource[skill.source] = (bySource[skill.source] ?? 0) + 1;
    }
    return { skills: all.length, byStatus, bySource, catalogTokens: this.catalog().tokens };
  }
}

function detectDomain(text) {
  const lower = " " + String(text).toLowerCase() + " ";
  const scored = Object.entries(DOMAIN_HINTS)
    .map(([domain, hints]) => [domain, hints.filter((hint) => lower.includes(hint.length > 4 ? hint : " " + hint + " ")).length])
    .filter((entry) => entry[1] > 0)
    .sort((a, b) => b[1] - a[1]);
  return scored[0]?.[0] ?? "business";
}
