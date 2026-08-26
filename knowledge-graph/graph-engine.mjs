import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jaccard, shortHash, slugify, uniqueTokens } from "../lib/text.mjs";

export const nodeTypes = [
  "Person",
  "Company",
  "Project",
  "Case",
  "Document",
  "Account",
  "Transaction",
  "Website",
  "GovernmentPortal",
  "Task",
  "Decision",
  "Event",
  "Skill",
  "Workflow",
  "Tool",
  "CredentialReference",
  "Agent",
  "Team"
];

export const edgeTypes = [
  "works_with",
  "works_for",
  "owns",
  "contains",
  "involves",
  "belongs_to",
  "operates",
  "performed",
  "produced",
  "related_to",
  "supersedes",
  "depends_on",
  "authorized_by",
  "located_in",
  "represents"
];

/**
 * Temporal knowledge graph.
 *
 * Facts are never destroyed when they change: a new version supersedes the old
 * one, the old one keeps its validity window, and every query can be asked
 * "as of" a point in time. The storage behind it is a pair of append only
 * JSONL files today; the adapter shape is deliberately narrow so a SQLite or
 * external graph backend can replace it without touching callers.
 */
export class GraphEngine {
  constructor(root, { clock, eventBus } = {}) {
    this.root = root;
    this.directory = join(root, ".astack", "graph");
    this.nodesPath = join(this.directory, "nodes.jsonl");
    this.edgesPath = join(this.directory, "edges.jsonl");
    this.clock = clock ?? (() => new Date());
    this.eventBus = eventBus ?? null;
    this.cache = { nodes: null, edges: null, nodesRaw: null, edgesRaw: null };
  }

  now() {
    return this.clock().toISOString();
  }

  readLines(path, cacheKey) {
    if (!existsSync(path)) {
      return [];
    }
    const raw = readFileSync(path, "utf8");
    if (this.cache[cacheKey + "Raw"] === raw) {
      return this.cache[cacheKey];
    }
    const merged = new Map();
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const record = JSON.parse(line);
        if (record.id) {
          merged.set(record.id, { ...(merged.get(record.id) ?? {}), ...record });
        }
      } catch {
        continue;
      }
    }
    const records = [...merged.values()].filter((record) => !record.deleted);
    this.cache[cacheKey] = records;
    this.cache[cacheKey + "Raw"] = raw;
    return records;
  }

  nodes() {
    return this.readLines(this.nodesPath, "nodes");
  }

  edges() {
    return this.readLines(this.edgesPath, "edges");
  }

  writeNode(node) {
    mkdirSync(this.directory, { recursive: true });
    appendFileSync(this.nodesPath, JSON.stringify(node) + "\n", "utf8");
    this.cache.nodesRaw = null;
    return node;
  }

  writeEdge(edge) {
    mkdirSync(this.directory, { recursive: true });
    appendFileSync(this.edgesPath, JSON.stringify(edge) + "\n", "utf8");
    this.cache.edgesRaw = null;
    return edge;
  }

  nodeId(type, name) {
    return type.toLowerCase() + ":" + slugify(name, { fallback: shortHash(name).slice(0, 8) });
  }

  get(id) {
    return this.nodes().find((node) => node.id === id) ?? null;
  }

  /**
   * Create or enrich an entity. Names are matched case and script insensitively
   * so "شرکت آکمه" and "Acme" stay separate nodes but "Acme  Ltd" and
   * "acme ltd" do not.
   */
  upsertNode({ type, name, aliases = [], attributes = {}, tags = [], confidence = 0.8, source = "manual", project = null, validFrom = null }) {
    if (!nodeTypes.includes(type)) {
      throw new Error("Unknown node type: " + type + ". Use: " + nodeTypes.join(", "));
    }
    if (!name) {
      throw new Error("A graph node needs a name");
    }
    const id = this.nodeId(type, name);
    const existing = this.get(id);
    const node = {
      id,
      type,
      name,
      aliases: [...new Set([...(existing?.aliases ?? []), ...aliases])],
      attributes: { ...(existing?.attributes ?? {}), ...attributes },
      tags: [...new Set([...(existing?.tags ?? []), ...tags])],
      project: project ?? existing?.project ?? null,
      confidence: Math.max(existing?.confidence ?? 0, confidence),
      source,
      createdAt: existing?.createdAt ?? this.now(),
      updatedAt: this.now(),
      validFrom: validFrom ?? existing?.validFrom ?? this.now(),
      validTo: existing?.validTo ?? null,
      mentions: (existing?.mentions ?? 0) + 1
    };
    this.writeNode(node);
    this.eventBus?.emit("graph.node.upserted", { id, type, name });
    return node;
  }

  /**
   * Relate two entities. A relationship with the same subject, predicate and
   * a different object supersedes the previous one when `exclusive` is set —
   * that is how "the accountant of Company A" can change without losing the
   * record of who it used to be.
   */
  relate({ from, type, to, attributes = {}, confidence = 0.8, source = "manual", exclusive = false, validFrom = null, project = null }) {
    if (!edgeTypes.includes(type)) {
      throw new Error("Unknown edge type: " + type + ". Use: " + edgeTypes.join(", "));
    }
    if (!this.get(from) || !this.get(to)) {
      throw new Error("Both ends of an edge must exist: " + from + " -> " + to);
    }
    const at = validFrom ?? this.now();
    let superseded = null;
    if (exclusive) {
      const current = this.edges().find((edge) => edge.from === from && edge.type === type && !edge.validTo);
      if (current && current.to !== to) {
        this.writeEdge({ ...current, validTo: at, supersededBy: null, updatedAt: this.now() });
        superseded = current.id;
      } else if (current && current.to === to) {
        return current;
      }
    }
    const id = "e:" + shortHash(from, type, to, at);
    const edge = {
      id,
      from,
      type,
      to,
      attributes,
      confidence,
      source,
      project,
      createdAt: this.now(),
      updatedAt: this.now(),
      validFrom: at,
      validTo: null,
      supersedes: superseded
    };
    this.writeEdge(edge);
    if (superseded) {
      this.writeEdge({ id: superseded, supersededBy: id, updatedAt: this.now() });
    }
    this.eventBus?.emit("graph.edge.created", { id, from, type, to });
    return edge;
  }

  activeEdges({ asOf = null } = {}) {
    const moment = new Date(asOf ?? this.now()).getTime();
    return this.edges().filter((edge) => {
      const from = new Date(edge.validFrom ?? edge.createdAt).getTime();
      const to = edge.validTo ? new Date(edge.validTo).getTime() : Infinity;
      return from <= moment && moment < to;
    });
  }

  /**
   * Direct neighbourhood of a node, optionally as of a moment in the past.
   */
  neighbours(id, { asOf = null, types = null, direction = "both", limit = 40 } = {}) {
    const edges = this.activeEdges({ asOf });
    const results = [];
    for (const edge of edges) {
      if (types && !types.includes(edge.type)) {
        continue;
      }
      if ((direction === "both" || direction === "out") && edge.from === id) {
        results.push({ edge, node: this.get(edge.to), direction: "out" });
      }
      if ((direction === "both" || direction === "in") && edge.to === id) {
        results.push({ edge, node: this.get(edge.from), direction: "in" });
      }
    }
    return results.filter((entry) => entry.node).slice(0, limit);
  }

  /**
   * Breadth first expansion used by the context router to pull in the entities
   * that surround a match without dragging in the whole graph.
   */
  expand(ids, { depth = 1, asOf = null, limit = 40 } = {}) {
    const seen = new Set(ids);
    let frontier = [...ids];
    const collected = [];
    for (let level = 0; level < depth; level += 1) {
      const next = [];
      for (const id of frontier) {
        for (const entry of this.neighbours(id, { asOf })) {
          if (seen.has(entry.node.id)) {
            continue;
          }
          seen.add(entry.node.id);
          collected.push({ ...entry, from: id, depth: level + 1 });
          next.push(entry.node.id);
          if (collected.length >= limit) {
            return collected;
          }
        }
      }
      frontier = next;
    }
    return collected;
  }

  /**
   * Resolve a mention like "the accountant of Company A" to real nodes by name,
   * alias and token overlap.
   */
  resolve(text, { type = null, limit = 5, minScore = 0.3, asOf = null } = {}) {
    const tokens = uniqueTokens(text);
    if (!tokens.length) {
      return [];
    }
    const moment = new Date(asOf ?? this.now()).getTime();
    return this.nodes()
      .filter((node) => !type || node.type === type)
      .filter((node) => !node.validTo || new Date(node.validTo).getTime() > moment)
      .map((node) => {
        const haystack = [node.name, ...(node.aliases ?? []), ...(node.tags ?? [])].join(" ");
        const nodeTokens = uniqueTokens(haystack);
        const overlap = jaccard(tokens, nodeTokens);
        const contains = tokens.some((token) => nodeTokens.includes(token)) ? 0.25 : 0;
        const exact = uniqueTokens(node.name).every((token) => tokens.includes(token)) ? 0.4 : 0;
        return { node, score: Number((overlap + contains + exact + node.confidence * 0.1).toFixed(3)) };
      })
      .filter((entry) => entry.score >= minScore)
      .sort((a, b) => b.score - a.score || b.node.mentions - a.node.mentions)
      .slice(0, limit);
  }

  /**
   * "Who is the accountant of Company A" style lookup: follow one predicate
   * from a resolved subject and return the currently valid object.
   */
  lookup({ subject, predicate, asOf = null, type = null }) {
    const matches = this.resolve(subject, { asOf, type });
    if (!matches.length) {
      return null;
    }
    const node = matches[0].node;
    const edges = this.activeEdges({ asOf }).filter((edge) => edge.from === node.id && edge.type === predicate);
    return {
      subject: node,
      matches: edges.map((edge) => ({ edge, node: this.get(edge.to) })).filter((entry) => entry.node)
    };
  }

  history(id) {
    const nodeHistory = existsSync(this.nodesPath)
      ? readFileSync(this.nodesPath, "utf8").split(/\r?\n/).filter(Boolean).map(parseSafe).filter((record) => record?.id === id)
      : [];
    const edgeHistory = existsSync(this.edgesPath)
      ? readFileSync(this.edgesPath, "utf8").split(/\r?\n/).filter(Boolean).map(parseSafe).filter((record) => record && (record.id === id || record.from === id || record.to === id))
      : [];
    return { node: nodeHistory, edges: edgeHistory };
  }

  stats() {
    const nodes = this.nodes();
    const edges = this.edges();
    const byType = {};
    for (const node of nodes) {
      byType[node.type] = (byType[node.type] ?? 0) + 1;
    }
    const byPredicate = {};
    for (const edge of edges) {
      byPredicate[edge.type] = (byPredicate[edge.type] ?? 0) + 1;
    }
    return {
      nodes: nodes.length,
      edges: edges.length,
      active: this.activeEdges().length,
      superseded: edges.filter((edge) => edge.validTo).length,
      byType,
      byPredicate
    };
  }

  compact() {
    const nodes = this.nodes();
    const edges = this.edges();
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(this.nodesPath, nodes.map((node) => JSON.stringify(node)).join("\n") + (nodes.length ? "\n" : ""), "utf8");
    writeFileSync(this.edgesPath, edges.map((edge) => JSON.stringify(edge)).join("\n") + (edges.length ? "\n" : ""), "utf8");
    this.cache = { nodes: null, edges: null, nodesRaw: null, edgesRaw: null };
    return { nodes: nodes.length, edges: edges.length };
  }
}

function parseSafe(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
