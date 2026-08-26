import { jaccard, tokenize, uniqueTokens } from "../lib/text.mjs";

const DAY = 24 * 60 * 60 * 1000;

function resolveImport(specifier, fromRel, files) {
  if (!specifier || /^https?:/.test(specifier)) {
    return null;
  }
  const folder = fromRel.includes("/") ? fromRel.slice(0, fromRel.lastIndexOf("/")) : "";
  const candidates = [];
  if (specifier.startsWith(".")) {
    const joined = normalizeRelative(folder ? folder + "/" + specifier : specifier);
    candidates.push(joined);
    for (const extension of [".mjs", ".js", ".ts", ".tsx", ".jsx", ".php", ".py", ".md", ".json"]) {
      candidates.push(joined + extension);
      candidates.push(joined + "/index" + extension);
    }
  } else {
    const base = specifier.replace(/\\/g, "/").split("/").pop();
    candidates.push(specifier, base);
  }
  for (const candidate of candidates) {
    if (files.has(candidate)) {
      return candidate;
    }
  }
  const tail = candidates[candidates.length - 1];
  if (!tail) {
    return null;
  }
  const needle = tail.toLowerCase();
  for (const rel of files.keys()) {
    const base = rel.split("/").pop().toLowerCase();
    if (base === needle || base.replace(/\.[^.]+$/, "") === needle.replace(/\.[^.]+$/, "")) {
      return rel;
    }
  }
  return null;
}

function normalizeRelative(path) {
  const parts = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

/**
 * Build the workspace graph. Code files link through imports, documents link
 * through markdown links, and every kind of file links through shared domain
 * signals — the mechanism that keeps the map useful for a legal or a finance
 * workspace where there is no import statement anywhere.
 */
export function buildGraph(index) {
  const files = new Map(Object.entries(index.files));
  const edges = new Map();
  const signalIndex = new Map();
  const addEdge = (from, to, weight, kind) => {
    if (!from || !to || from === to || !files.has(to)) {
      return;
    }
    const key = from + " -> " + to;
    const current = edges.get(key) ?? { from, to, weight: 0, kinds: new Set() };
    current.weight += weight;
    current.kinds.add(kind);
    edges.set(key, current);
  };

  for (const [rel, entry] of files) {
    for (const specifier of entry.imports ?? []) {
      addEdge(rel, resolveImport(specifier, rel, files), 1, "import");
    }
    for (const link of entry.links ?? []) {
      addEdge(rel, resolveImport(link, rel, files), 0.8, "link");
    }
    for (const signal of entry.signals ?? []) {
      if (!signal.linking) {
        continue;
      }
      const key = signal.type + "=" + signal.value;
      const bucket = signalIndex.get(key) ?? { weight: signal.weight ?? 1, files: new Set() };
      bucket.files.add(rel);
      signalIndex.set(key, bucket);
    }
  }

  const clusters = [];
  for (const [key, bucket] of signalIndex) {
    const members = [...bucket.files];
    if (members.length < 2 || members.length > 60) {
      continue;
    }
    clusters.push({ key, weight: bucket.weight, members });
    const share = bucket.weight / Math.sqrt(members.length);
    for (const from of members) {
      for (const to of members) {
        addEdge(from, to, share * 0.5, "signal");
      }
    }
  }

  return { files, edges: [...edges.values()].map((edge) => ({ ...edge, kinds: [...edge.kinds] })), clusters };
}

/**
 * Personalized PageRank over the workspace graph. The personalization vector
 * is the query focus, so "map for this question" surfaces the neighbourhood of
 * the question instead of the globally popular files.
 */
export function pageRank(graph, { seeds = new Map(), damping = 0.85, iterations = 24, tolerance = 1e-6 } = {}) {
  const nodes = [...graph.files.keys()];
  if (!nodes.length) {
    return new Map();
  }
  const outgoing = new Map();
  for (const edge of graph.edges) {
    const bucket = outgoing.get(edge.from) ?? [];
    bucket.push(edge);
    outgoing.set(edge.from, bucket);
  }
  const outWeight = new Map();
  for (const [from, bucket] of outgoing) {
    outWeight.set(from, bucket.reduce((sum, edge) => sum + edge.weight, 0));
  }
  const seedTotal = [...seeds.values()].reduce((sum, value) => sum + value, 0);
  const personalization = new Map();
  for (const node of nodes) {
    const seed = seeds.get(node) ?? 0;
    personalization.set(node, seedTotal > 0 ? seed / seedTotal : 1 / nodes.length);
  }
  let rank = new Map(nodes.map((node) => [node, 1 / nodes.length]));
  for (let round = 0; round < iterations; round += 1) {
    const next = new Map(nodes.map((node) => [node, 0]));
    let dangling = 0;
    for (const node of nodes) {
      const score = rank.get(node);
      const bucket = outgoing.get(node);
      if (!bucket || !bucket.length) {
        dangling += score;
        continue;
      }
      const total = outWeight.get(node) || 1;
      for (const edge of bucket) {
        next.set(edge.to, next.get(edge.to) + score * (edge.weight / total));
      }
    }
    let delta = 0;
    for (const node of nodes) {
      const value = (1 - damping) * personalization.get(node) + damping * (next.get(node) + dangling * personalization.get(node));
      delta += Math.abs(value - rank.get(node));
      next.set(node, value);
    }
    rank = next;
    if (delta < tolerance) {
      break;
    }
  }
  return rank;
}

function lexicalScore(queryTokens, entry) {
  if (!queryTokens.length) {
    return 0;
  }
  const terms = new Map((entry.terms ?? []).map((term) => [term.t, term.n]));
  const haystack = new Set([
    ...tokenize(entry.rel.replace(/[\/\-_.]/g, " ")),
    ...(entry.nameTokens ?? []),
    ...(entry.symbols ?? []).flatMap((symbol) => tokenize(String(symbol.name).replace(/([a-z])([A-Z])/g, "$1 $2"))),
    ...(entry.headings ?? []).flatMap((heading) => tokenize(heading.text)),
    ...(entry.signals ?? []).flatMap((signal) => tokenize(signal.value)),
    ...tokenize(entry.title ?? ""),
    ...tokenize(entry.summary ?? "")
  ]);
  let hits = 0;
  for (const token of queryTokens) {
    if (haystack.has(token)) {
      hits += 1;
      continue;
    }
    if (terms.has(token)) {
      hits += 0.7 * Math.min(1, Math.log2(1 + terms.get(token)) / 3);
      continue;
    }
    let matched = false;
    for (const candidate of haystack) {
      if (candidate.length > 3 && (candidate.startsWith(token) || token.startsWith(candidate))) {
        hits += 0.5;
        matched = true;
        break;
      }
    }
    if (matched || token.length < 4) {
      continue;
    }
    for (const candidate of terms.keys()) {
      if (candidate.length > 3 && (candidate.startsWith(token) || token.startsWith(candidate))) {
        hits += 0.35;
        break;
      }
    }
  }
  return hits / queryTokens.length;
}

function criticalBoost(rel, lens, alwaysInclude, focused) {
  if (alwaysInclude.includes(rel)) {
    return focused ? 0.5 : 1.4;
  }
  const lower = rel.toLowerCase();
  for (const marker of lens?.criticalPaths ?? []) {
    if (lower.includes(String(marker).toLowerCase())) {
      return 0.8;
    }
  }
  return 0;
}

/**
 * Final ranking: graph authority, query focus, domain lens, recency, owner
 * pins and critical paths, combined into one explainable score.
 */
export function rankFiles(index, { query = "", lens = null, lensConfidence = 1, alwaysInclude = [], pins = [], now = new Date(), graph = null } = {}) {
  const workingGraph = graph ?? buildGraph(index);
  const queryTokens = uniqueTokens(query);
  const seeds = new Map();
  const lexical = new Map();
  for (const [rel, entry] of workingGraph.files) {
    const score = lexicalScore(queryTokens, entry);
    lexical.set(rel, score);
    if (score > 0) {
      seeds.set(rel, score);
    }
  }
  for (const pin of pins) {
    seeds.set(pin, (seeds.get(pin) ?? 0) + 1.5);
  }
  const rank = pageRank(workingGraph, { seeds });
  const maxRank = Math.max(...rank.values(), 1e-9);
  const nowMs = new Date(now).getTime();
  const kindWeights = lens?.kindWeights ?? {};
  const results = [];
  for (const [rel, entry] of workingGraph.files) {
    const authority = (rank.get(rel) ?? 0) / maxRank;
    const focus = lexical.get(rel) ?? 0;
    const ageDays = Math.max(0, (nowMs - new Date(entry.mtime).getTime()) / DAY);
    const recency = Math.pow(0.5, ageDays / 120);
    const rawKindWeight = kindWeights[entry.category] ?? 1;
    const kindWeight = 1 + (rawKindWeight - 1) * Math.min(1, Math.max(0, lensConfidence));
    const critical = criticalBoost(rel, lens, alwaysInclude, queryTokens.length > 0);
    const pinned = pins.includes(rel) ? 1.2 : 0;
    const signalWeight = Math.min(1.2, (entry.signals ?? []).reduce((sum, signal) => sum + (signal.weight ?? 1), 0) / 10);
    // The domain lens steers browsing, never retrieval: a strong query match is
    // not penalised because the active lens prefers another kind of file.
    const steered = (authority * 2.4 + recency * 0.7 + signalWeight * 0.8 + critical + pinned) * kindWeight;
    const score = focus * 3.2 + steered;
    results.push({
      rel,
      entry,
      score: Number(score.toFixed(5)),
      authority: Number(authority.toFixed(5)),
      focus: Number(focus.toFixed(3)),
      recency: Number(recency.toFixed(3)),
      pinned: pins.includes(rel),
      critical: critical > 0
    });
  }
  return {
    graph: workingGraph,
    ranked: results.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel))
  };
}

/**
 * Rank the members of a file so the map shows the parts that matter first.
 */
export function rankMembers(entry, queryTokens) {
  const kindWeight = { class: 1.6, type: 1.4, table: 1.6, function: 1.2, const: 1, method: 0.8, key: 0.7, section: 0.8, column: 0.6, record: 1, view: 1.2 };
  const members = [
    ...(entry.symbols ?? []).map((symbol) => ({ kind: symbol.kind, name: symbol.name, line: symbol.line, type: "symbol" })),
    ...(entry.headings ?? [])
      .filter((heading) => heading.level <= 3)
      .map((heading) => ({ kind: "heading", name: heading.text, line: heading.line, type: "heading", level: heading.level }))
  ];
  return members
    .map((member) => {
      const tokens = tokenize(String(member.name).replace(/([a-z])([A-Z])/g, "$1 $2"));
      const focus = queryTokens.length ? jaccard(tokens, queryTokens) : 0;
      const base = kindWeight[member.kind] ?? 1;
      const depth = member.level ? 1 / member.level : 1;
      return { ...member, score: base * depth + focus * 3 };
    })
    .sort((a, b) => b.score - a.score || a.line - b.line);
}
