import { estimateTokens, uniqueTokens } from "../lib/text.mjs";

export const DEFAULT_BUDGETS = {
  ownerCapsule: 800,
  memory: 2500,
  project: 3500,
  repoMap: 2000,
  skills: 3000,
  tools: 500,
  graph: 700,
  total: 12000
};

/**
 * Cross conversation context router.
 *
 * A new session never replays history. It starts from a small owner capsule and
 * then, for each request, walks: intent, entity resolution, project matching,
 * memory search, relationship expansion, temporal validation, ranking and token
 * budgeting — and hands the runtime the smallest package that can answer the
 * question, with every line traceable to where it came from.
 */
export class ContextRouter {
  constructor({ context = null, memory = null, graph = null, projects = null, learning = null, tools = null, owner = null, domains = null, clock } = {}) {
    this.context = context;
    this.memory = memory;
    this.graph = graph;
    this.projects = projects;
    this.learning = learning;
    this.tools = tools;
    this.owner = owner;
    this.domains = domains;
    this.clock = clock ?? (() => new Date());
  }

  now() {
    return this.clock().toISOString();
  }

  resolveEntities(request, { limit = 6, asOf = null } = {}) {
    if (!this.graph) {
      return [];
    }
    const direct = this.graph.resolve(request, { limit, asOf });
    const tokens = uniqueTokens(request).filter((token) => token.length > 2);
    const perToken = tokens
      .flatMap((token) => this.graph.resolve(token, { limit: 2, minScore: 0.45, asOf }))
      .filter((entry) => !direct.some((hit) => hit.node.id === entry.node.id));
    const merged = [...direct, ...perToken]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return merged.map((entry) => ({ id: entry.node.id, type: entry.node.type, name: entry.node.name, score: entry.score }));
  }

  matchProject(request, { entities = [] } = {}) {
    if (!this.projects) {
      return null;
    }
    let projects = [];
    try {
      projects = this.projects.list();
    } catch {
      return null;
    }
    if (!projects.length) {
      return null;
    }
    const tokens = uniqueTokens(request);
    const scored = projects
      .map((project) => {
        const nameTokens = uniqueTokens(project.name + " " + (project.description ?? ""));
        const overlap = nameTokens.filter((token) => tokens.includes(token)).length / Math.max(1, nameTokens.length);
        const entityMatch = entities.some((entity) => uniqueTokens(entity.name).some((token) => nameTokens.includes(token))) ? 0.4 : 0;
        const open = project.phase !== "closed" ? 0.15 : 0;
        return { project, score: Number((overlap + entityMatch + open).toFixed(3)) };
      })
      .filter((entry) => entry.score > 0.2)
      .sort((a, b) => b.score - a.score);
    return scored[0]?.project ?? null;
  }

  /**
   * Build the minimal context package for one request.
   */
  route(request, { domain = null, budgets = {}, asOf = null, includeRepoMap = true, project = null, intent = null } = {}) {
    const limits = { ...DEFAULT_BUDGETS, ...budgets };
    const started = Date.now();
    const resolvedDomain = domain ?? this.domains?.detect(request)?.id ?? null;
    const entities = this.resolveEntities(request, { asOf });
    const related = this.graph && entities.length
      ? this.graph.expand(entities.map((entity) => entity.id), { depth: 1, asOf, limit: 12 })
      : [];
    const matchedProject = project ? this.safeProject(project) : this.matchProject(request, { entities });
    const sections = [];
    let used = 0;

    const capsule = this.owner?.capsule({ budget: limits.ownerCapsule }) ?? null;
    if (capsule?.lines.length) {
      sections.push({ title: "owner", lines: capsule.lines, tokens: capsule.tokens, source: "owner-model" });
      used += capsule.tokens;
    }

    const memoryBrief = this.memory?.brief({
      query: request,
      domain: resolvedDomain,
      project: matchedProject?.id ?? null,
      budget: limits.memory,
      limit: 14
    }) ?? null;
    if (memoryBrief?.lines.length) {
      sections.push({ title: "memory", lines: memoryBrief.lines, tokens: memoryBrief.tokens, source: "memory-os" });
      used += memoryBrief.tokens;
    }

    if (entities.length || related.length) {
      const lines = [
        ...entities.map((entity) => "- " + entity.type + " " + entity.name + " (" + entity.id + ", match " + entity.score + ")"),
        ...related.slice(0, 8).map((entry) => "- " + entry.node.type + " " + entry.node.name + " <- " + entry.edge.type + " -> " + entry.from)
      ];
      const tokens = estimateTokens(lines.join("\n"));
      if (used + tokens <= limits.total) {
        sections.push({ title: "entities", lines: lines.slice(0, 14), tokens, source: "knowledge-graph" });
        used += tokens;
      }
    }

    if (matchedProject) {
      const lines = this.projectLines(matchedProject, limits.project);
      if (lines.lines.length) {
        sections.push({ title: "project", lines: lines.lines, tokens: lines.tokens, source: "delivery-engine" });
        used += lines.tokens;
      }
    }

    let map = null;
    if (includeRepoMap && this.context) {
      map = this.context.map({ query: request, domain: resolvedDomain, budget: limits.repoMap, withMemory: false, save: false });
      const lines = map.text.split("\n").filter(Boolean);
      sections.push({ title: "workspace map", lines, tokens: map.tokens, source: "context-engine" });
      used += map.tokens;
    }

    const skills = this.learning?.match(request, { domain: resolvedDomain, limit: 3 }) ?? [];
    if (skills.length) {
      const lines = skills.map((skill) => "- " + skill.id + " (" + skill.status + ", conf " + skill.confidence + "): " + skill.path);
      const tokens = estimateTokens(lines.join("\n"));
      sections.push({ title: "skills", lines, tokens, source: "learning-engine" });
      used += tokens;
    }

    const catalog = this.tools?.catalog({ budget: limits.tools }) ?? null;
    if (catalog?.lines.length) {
      sections.push({ title: "tools", lines: catalog.lines, tokens: catalog.tokens, source: "tool-registry" });
      used += catalog.tokens;
    }

    const corpusTokens = map?.corpusTokens ?? 0;
    return {
      request,
      intent,
      domain: resolvedDomain,
      project: matchedProject?.id ?? null,
      entities,
      related: related.map((entry) => ({ id: entry.node.id, name: entry.node.name, via: entry.edge.type })),
      asOf: asOf ?? this.now(),
      sections,
      tokens: used,
      budget: limits.total,
      withinBudget: used <= limits.total,
      corpusTokens,
      tokensAvoided: Math.max(0, corpusTokens - used),
      durationMs: Date.now() - started,
      lines: sections.flatMap((section) => ["## " + section.title, ...section.lines])
    };
  }

  safeProject(id) {
    try {
      return this.projects?.get(id) ?? null;
    } catch {
      return null;
    }
  }

  projectLines(project, budget) {
    const lines = [];
    try {
      const status = this.projects.status(project.id);
      lines.push("- project " + project.id + " (" + project.name + ") phase " + project.phase + ", health " + status.health.score + "/100 " + status.health.rag);
      for (const action of (status.nextActions ?? []).slice(0, 3)) {
        lines.push("- next: " + action.code + (action.params?.title ? " " + action.params.title : ""));
      }
      const openItems = (project.workItems ?? []).filter((item) => !["done", "cancelled"].includes(item.status)).slice(0, 6);
      for (const item of openItems) {
        lines.push("- item " + item.id + " [" + item.status + "] " + item.title);
      }
    } catch {
      lines.push("- project " + project.id + " (" + project.name + ")");
    }
    const trimmed = [];
    let tokens = 0;
    for (const line of lines) {
      const cost = estimateTokens(line);
      if (tokens + cost > budget) {
        break;
      }
      tokens += cost;
      trimmed.push(line);
    }
    return { lines: trimmed, tokens };
  }

  /**
   * Render the package as the text block a runtime receives.
   */
  render(package_) {
    const header = [
      "# AStack context package",
      "request=" + JSON.stringify(package_.request).slice(0, 200),
      "domain=" + (package_.domain ?? "-") + " | project=" + (package_.project ?? "-") + " | asOf=" + package_.asOf,
      "tokens=" + package_.tokens + "/" + package_.budget + " | avoided=" + package_.tokensAvoided,
      "rule=every line below is an index into a source; open the source before relying on details",
      ""
    ];
    const body = package_.sections.flatMap((section) => ["## " + section.title + " (" + section.source + ", " + section.tokens + " tok)", ...section.lines, ""]);
    return header.concat(body).join("\n");
  }
}
