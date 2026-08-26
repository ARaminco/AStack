import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "../lib/text.mjs";
import { Indexer } from "./indexer.mjs";
import { buildGraph, rankFiles } from "./ranking.mjs";
import { renderExpansion, renderMap } from "./budget.mjs";

const DEFAULT_BUDGET = 4000;

/**
 * The context engine is the token budget of the whole platform.
 *
 * It keeps an incremental index of the workspace, ranks it with a personalized
 * PageRank over imports, document links and shared domain records, and renders
 * a map that fits a token budget. Detail is never destroyed: the map is an
 * index with line anchors, and `expand` returns the full structure of any file
 * on demand. That is what lets a legal or accounting workspace be navigated as
 * precisely as a code repository without reading everything first.
 */
export class ContextEngine {
  constructor(root, { domains = null, memory = null, clock, lenses = null } = {}) {
    this.root = root;
    this.domains = domains;
    this.memory = memory;
    this.clock = clock ?? (() => new Date());
    this.directory = join(root, ".astack", "context");
    this.lenses = lenses ?? JSON.parse(readFileSync(join(root, "context-engine", "lenses.json"), "utf8"));
    this.indexer = new Indexer(root, { lenses: this.lenses, clock: this.clock });
  }

  now() {
    return this.clock().toISOString();
  }

  lensFor(domainId) {
    return this.indexer.lensFor(domainId);
  }

  build({ force = false, domain = null } = {}) {
    const index = this.indexer.build({ force, domain });
    this.writeState({ lastBuild: index.builtAt, files: index.stats.files, corpusTokens: index.stats.corpusTokens });
    return index;
  }

  index({ refresh = "auto", domain = null } = {}) {
    const existing = this.indexer.loadIndex();
    if (!existing || refresh === "always") {
      return this.build({ force: refresh === "always", domain });
    }
    if (refresh === "never") {
      return existing;
    }
    const freshness = this.indexer.verify();
    if (!freshness.fresh) {
      return this.build({ domain });
    }
    return existing;
  }

  /**
   * Infer the practice a workspace belongs to from the density of the domain
   * records found in it, so a folder of court filings is treated as a legal
   * engagement even when nobody declared a domain.
   */
  inferDomain(index) {
    const entries = Object.values(index.files);
    if (!entries.length) {
      return null;
    }
    const signalWeights = new Map();
    for (const entry of entries) {
      for (const signal of entry.signals ?? []) {
        for (const lens of this.lenses.lenses) {
          if (lens.signals.some((definition) => definition.id === signal.type)) {
            signalWeights.set(lens.id, (signalWeights.get(lens.id) ?? 0) + (signal.weight ?? 1));
          }
        }
      }
    }
    const totalSignals = [...signalWeights.values()].reduce((sum, value) => sum + value, 0) || 1;
    const categoryShare = new Map();
    for (const entry of entries) {
      categoryShare.set(entry.category, (categoryShare.get(entry.category) ?? 0) + 1);
    }
    const shapes = this.lenses.lenses.map((lens) => {
      let fromShape = 0;
      for (const [category, count] of categoryShare) {
        fromShape += (count / entries.length) * (lens.kindWeights?.[category] ?? 1);
      }
      return { lens, fromShape };
    });
    const meanShape = shapes.reduce((sum, entry) => sum + entry.fromShape, 0) / shapes.length;
    const scored = shapes
      .map(({ lens, fromShape }) => ({
        lens: lens.id,
        domain: lens.domains[0],
        score: Number(((signalWeights.get(lens.id) ?? 0) / totalSignals * 4 + (fromShape - meanShape)).toFixed(4))
      }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best) {
      return null;
    }
    const margin = best.score - (scored[1]?.score ?? 0);
    const density = [...signalWeights.values()].reduce((sum, value) => sum + value, 0) / entries.length;
    const confidence = Math.min(0.75, Math.max(0, margin)) * Math.min(1, density / 0.6);
    return { ...best, ranking: scored, density: Number(density.toFixed(3)), confidence: Number(confidence.toFixed(3)) };
  }

  resolveDomain({ domain = null, query = "" } = {}) {
    if (domain) {
      return domain;
    }
    const detected = query && this.domains ? this.domains.detect(query) : null;
    return detected?.id ?? null;
  }

  pinsPath() {
    return join(this.directory, "pins.json");
  }

  pins() {
    const path = this.pinsPath();
    if (!existsSync(path)) {
      return [];
    }
    try {
      return JSON.parse(readFileSync(path, "utf8")).pins ?? [];
    } catch {
      return [];
    }
  }

  pin(rel) {
    const pins = [...new Set([...this.pins(), rel])];
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(this.pinsPath(), JSON.stringify({ pins }, null, 2) + "\n", "utf8");
    return pins;
  }

  unpin(rel) {
    const pins = this.pins().filter((entry) => entry !== rel);
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(this.pinsPath(), JSON.stringify({ pins }, null, 2) + "\n", "utf8");
    return pins;
  }

  rank({ query = "", domain = null, refresh = "auto", index = null } = {}) {
    const resolved = this.resolveDomain({ domain, query });
    const workingIndex = index ?? this.index({ refresh, domain: resolved });
    const declared = this.lensFor(resolved);
    const inferred = declared ? null : this.inferDomain(workingIndex);
    const lens = declared ?? (inferred ? this.lenses.lenses.find((entry) => entry.id === inferred.lens) : null);
    const lensConfidence = declared ? 1 : inferred?.confidence ?? 0;
    const { ranked, graph } = rankFiles(workingIndex, {
      query,
      lens,
      lensConfidence,
      alwaysInclude: this.lenses.defaults.alwaysInclude ?? [],
      pins: this.pins(),
      now: this.clock()
    });
    return { index: workingIndex, ranked, graph, lens, lensConfidence, inferred, domain: resolved };
  }

  /**
   * The primary entry point: a ranked, budget-bound map of the workspace for a
   * question, plus the memory brief that belongs with it.
   */
  map({ query = "", domain = null, budget = DEFAULT_BUDGET, refresh = "auto", withMemory = true, save = true } = {}) {
    const { index, ranked, graph, lens, domain: resolved } = this.rank({ query, domain, refresh });
    const freshness = this.indexer.verify();
    const extraSections = [];
    if (withMemory && this.memory) {
      const brief = this.memory.brief({ query, domain: resolved, budget: Math.round(budget * 0.15) });
      if (brief.lines.length) {
        extraSections.push({ title: "memory", lines: brief.lines });
      }
    }
    const rendered = renderMap({
      index,
      ranked,
      graph,
      query,
      domain: resolved ?? this.inferDomain(index)?.domain ?? null,
      budget,
      freshness,
      extraSections
    });
    const result = {
      ...rendered,
      domain: resolved,
      lens: lens?.id ?? null,
      freshness,
      files: index.stats.files
    };
    this.recordUsage(result);
    if (save) {
      mkdirSync(this.directory, { recursive: true });
      writeFileSync(join(this.directory, "map.md"), rendered.text, "utf8");
      result.path = ".astack/context/map.md";
    }
    return result;
  }

  /**
   * Targeted retrieval: the cheapest way to answer "where does X live".
   */
  query(text, { limit = 12, domain = null, refresh = "auto", withMembers = true } = {}) {
    const { ranked, graph, index } = this.rank({ query: text, domain, refresh });
    const hits = ranked.slice(0, limit).map((item) => ({
      rel: item.rel,
      score: item.score,
      focus: item.focus,
      authority: item.authority,
      category: item.entry.category,
      language: item.entry.language,
      title: item.entry.title,
      opaque: item.entry.opaque,
      signals: (item.entry.signals ?? []).slice(0, 4).map((signal) => signal.type + "=" + signal.value),
      members: withMembers
        ? [...(item.entry.symbols ?? []).slice(0, 5).map((symbol) => symbol.kind + " " + symbol.name + ":" + symbol.line),
           ...(item.entry.headings ?? []).slice(0, 3).map((heading) => "# " + heading.text + ":" + heading.line)]
        : []
    }));
    return { query: text, hits, scanned: index.stats.files, clusters: graph.clusters.length };
  }

  neighbours(rel, graph) {
    const collected = new Map();
    for (const edge of graph.edges) {
      if (edge.from === rel) {
        collected.set(edge.to, { rel: edge.to, weight: edge.weight, kinds: edge.kinds });
      } else if (edge.to === rel) {
        const current = collected.get(edge.from);
        collected.set(edge.from, { rel: edge.from, weight: (current?.weight ?? 0) + edge.weight, kinds: edge.kinds });
      }
    }
    return [...collected.values()].sort((a, b) => b.weight - a.weight).slice(0, 12);
  }

  expand(rel, { refresh = "auto" } = {}) {
    const index = this.index({ refresh });
    const entry = index.files[rel];
    if (!entry) {
      const candidates = Object.keys(index.files).filter((path) => path.endsWith("/" + rel) || path.includes(rel));
      if (candidates.length === 1) {
        return this.expand(candidates[0], { refresh: "never" });
      }
      throw new Error("Path is not indexed: " + rel + (candidates.length ? ". Did you mean: " + candidates.slice(0, 5).join(", ") : ""));
    }
    const graph = buildGraph(index);
    const clusters = graph.clusters.filter((cluster) => cluster.members.includes(rel)).map((cluster) => ({ key: cluster.key, members: cluster.members }));
    const rendered = renderExpansion({ rel, entry, neighbours: this.neighbours(rel, graph), clusters });
    this.recordUsage({ tokens: rendered.tokens, corpusTokens: entry.tokens, savings: entry.tokens ? 1 - rendered.tokens / entry.tokens : 0, kind: "expand" });
    return { rel, ...rendered, entry };
  }

  verify() {
    return this.indexer.verify();
  }

  statePath() {
    return join(this.directory, "usage.json");
  }

  readState() {
    const path = this.statePath();
    if (!existsSync(path)) {
      return { maps: 0, expands: 0, tokensRendered: 0, tokensAvoided: 0, lastBuild: null, history: [] };
    }
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return { maps: 0, expands: 0, tokensRendered: 0, tokensAvoided: 0, lastBuild: null, history: [] };
    }
  }

  writeState(patch) {
    const state = { ...this.readState(), ...patch };
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(this.statePath(), JSON.stringify(state, null, 2) + "\n", "utf8");
    return state;
  }

  recordUsage(result) {
    const state = this.readState();
    const avoided = Math.max(0, (result.corpusTokens ?? 0) - (result.tokens ?? 0));
    const history = [...(state.history ?? []), { at: this.now(), kind: result.kind ?? "map", tokens: result.tokens ?? 0, avoided }].slice(-200);
    return this.writeState({
      maps: state.maps + (result.kind === "expand" ? 0 : 1),
      expands: state.expands + (result.kind === "expand" ? 1 : 0),
      tokensRendered: state.tokensRendered + (result.tokens ?? 0),
      tokensAvoided: state.tokensAvoided + avoided,
      history
    });
  }

  stats() {
    const state = this.readState();
    const index = this.indexer.loadIndex();
    const ratio = state.tokensRendered + state.tokensAvoided > 0
      ? state.tokensAvoided / (state.tokensRendered + state.tokensAvoided)
      : 0;
    return {
      built: Boolean(index),
      builtAt: index?.builtAt ?? null,
      files: index?.stats.files ?? 0,
      symbols: index?.stats.symbols ?? 0,
      signals: index?.stats.signals ?? 0,
      corpusTokens: index?.stats.corpusTokens ?? 0,
      maps: state.maps,
      expands: state.expands,
      tokensRendered: state.tokensRendered,
      tokensAvoided: state.tokensAvoided,
      savingsRatio: Number(ratio.toFixed(4))
    };
  }
}

export { DEFAULT_BUDGET };
