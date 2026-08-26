import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens, jaccard, shortHash, tokenize, uniqueTokens } from "../lib/text.mjs";

export const memoryFacets = [
  "identity",
  "semantic",
  "episodic",
  "project",
  "entity",
  "relationship",
  "procedural",
  "decision",
  "preference",
  "working",
  "calibration",
  "lesson"
];

const FACET_DEFAULTS = {
  identity: { halfLifeDays: 3650, weight: 1.6 },
  semantic: { halfLifeDays: 240, weight: 1 },
  episodic: { halfLifeDays: 45, weight: 0.9 },
  project: { halfLifeDays: 180, weight: 1.2 },
  entity: { halfLifeDays: 365, weight: 1.1 },
  relationship: { halfLifeDays: 365, weight: 1.1 },
  procedural: { halfLifeDays: 365, weight: 1.2 },
  decision: { halfLifeDays: 540, weight: 1.3 },
  preference: { halfLifeDays: 720, weight: 1.4 },
  working: { halfLifeDays: 2, weight: 0.6 },
  calibration: { halfLifeDays: 120, weight: 0.8 },
  lesson: { halfLifeDays: 300, weight: 1.3 }
};

const DAY = 24 * 60 * 60 * 1000;

/**
 * Structured, multi-faceted long term memory.
 *
 * The markdown scopes handled by MemoryEngine stay the owner facing surface.
 * This store keeps the machine facing side: append only JSONL per facet with
 * latest-version-wins compaction, BM25 style recall, usage reinforcement and
 * time decay. Every record carries provenance so a recalled fact can always be
 * traced back to the episode, file or run that produced it.
 */
export class FacetMemory {
  constructor(root, { clock } = {}) {
    this.root = root;
    this.directory = join(root, ".astack", "memory");
    this.clock = clock ?? (() => new Date());
    this.cache = new Map();
  }

  now() {
    return this.clock().toISOString();
  }

  facets() {
    return [...memoryFacets];
  }

  requireFacet(facet) {
    if (!memoryFacets.includes(facet)) {
      throw new Error("Unknown memory facet: " + facet + ". Use: " + memoryFacets.join(", "));
    }
    return facet;
  }

  path(facet) {
    return join(this.directory, this.requireFacet(facet) + ".jsonl");
  }

  all(facet) {
    const path = this.path(facet);
    if (!existsSync(path)) {
      return [];
    }
    const key = facet;
    const stamp = readFileSync(path, "utf8");
    const cached = this.cache.get(key);
    if (cached && cached.raw === stamp) {
      return cached.records;
    }
    const merged = new Map();
    for (const line of stamp.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      let record = null;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!record?.id) {
        continue;
      }
      if (record.deleted) {
        merged.delete(record.id);
        continue;
      }
      merged.set(record.id, record);
    }
    const records = [...merged.values()];
    this.cache.set(key, { raw: stamp, records });
    return records;
  }

  everything() {
    return memoryFacets.flatMap((facet) => this.all(facet));
  }

  get(id) {
    for (const facet of memoryFacets) {
      const found = this.all(facet).find((record) => record.id === id);
      if (found) {
        return found;
      }
    }
    return null;
  }

  write(facet, record) {
    mkdirSync(this.directory, { recursive: true });
    appendFileSync(this.path(facet), JSON.stringify(record) + "\n", "utf8");
    this.cache.delete(facet);
    return record;
  }

  append(facet, entry = {}) {
    this.requireFacet(facet);
    const at = entry.at ?? this.now();
    const title = String(entry.title ?? "").trim();
    const body = String(entry.body ?? "").trim();
    if (!title && !body) {
      throw new Error("A memory record needs a title or a body");
    }
    const digest = shortHash(
      facet,
      title,
      body,
      entry.scope ?? "",
      entry.project ?? "",
      // A correction carries the record it replaces, so it can never be folded
      // into that record as a duplicate observation.
      entry.supersedes ?? "",
      entry.supersedes ? at : ""
    );
    const existing = this.all(facet).find((record) => record.digest === digest);
    if (existing) {
      return this.reinforce(existing.id, { delta: 0.15, note: "duplicate observation" });
    }
    const defaults = FACET_DEFAULTS[facet];
    const record = {
      id: facet.slice(0, 3) + "-" + digest,
      facet,
      type: facet,
      at,
      updatedAt: at,
      decayedAt: at,
      scope: entry.scope ?? null,
      domain: entry.domain ?? null,
      project: entry.project ?? entry.projectId ?? null,
      subject: entry.subject ?? null,
      predicate: entry.predicate ?? null,
      object: entry.object ?? null,
      entities: [...new Set((entry.entities ?? []).map((value) => String(value)))],
      validFrom: entry.validFrom ?? at,
      validTo: entry.validTo ?? null,
      supersedes: entry.supersedes ?? null,
      supersededBy: null,
      importance: clamp(entry.importance ?? 0.5, 0, 1),
      title,
      body,
      tags: [...new Set((entry.tags ?? []).map((tag) => String(tag)))],
      refs: [...new Set((entry.refs ?? []).map((ref) => String(ref)))],
      weight: entry.weight ?? defaults.weight,
      confidence: clamp(entry.confidence ?? 0.6, 0, 1),
      hits: 0,
      lastHit: null,
      source: entry.source ?? "manual",
      expiresAt: entry.expiresAt ?? null,
      digest,
      meta: entry.meta ?? {}
    };
    return this.write(facet, record);
  }

  update(id, patch = {}) {
    const record = this.get(id);
    if (!record) {
      throw new Error("Unknown memory record: " + id);
    }
    const next = { ...record, ...patch, id: record.id, facet: record.facet, updatedAt: this.now() };
    return this.write(record.facet, next);
  }

  reinforce(id, { delta = 0.1, outcome = null, note = null } = {}) {
    const record = this.get(id);
    if (!record) {
      throw new Error("Unknown memory record: " + id);
    }
    const signed = outcome === "failed" ? -Math.abs(delta) : delta;
    const next = {
      ...record,
      hits: record.hits + 1,
      lastHit: this.now(),
      updatedAt: this.now(),
      confidence: clamp(record.confidence + signed, 0.05, 1),
      weight: Math.max(0.05, record.weight + signed / 2),
      meta: note ? { ...record.meta, lastNote: note } : record.meta
    };
    return this.write(record.facet, next);
  }

  forget(id) {
    const record = this.get(id);
    if (!record) {
      throw new Error("Unknown memory record: " + id);
    }
    this.write(record.facet, { id: record.id, facet: record.facet, deleted: true, at: this.now() });
    return record;
  }

  /**
   * Replace a fact without erasing it. The old record keeps its validity
   * window and points at the record that replaced it, so history survives and
   * "what did we believe last quarter" is still answerable.
   */
  supersede(id, entry = {}) {
    const previous = this.get(id);
    if (!previous) {
      throw new Error("Unknown memory record: " + id);
    }
    const at = entry.at ?? this.now();
    const replacement = this.append(entry.facet ?? previous.facet, {
      ...entry,
      at,
      validFrom: entry.validFrom ?? at,
      supersedes: previous.id,
      domain: entry.domain ?? previous.domain,
      project: entry.project ?? previous.project,
      scope: entry.scope ?? previous.scope
    });
    if (replacement.id === previous.id) {
      // Nothing distinguishes the correction from the record it was meant to
      // replace. Hiding the only copy would lose the fact entirely, so refuse.
      throw new Error(
        "The replacement is identical to " + previous.id + ". Give the corrected fact a different title, body or object."
      );
    }
    this.write(previous.facet, { ...previous, validTo: at, supersededBy: replacement.id, updatedAt: at });
    return { previous: { ...previous, validTo: at, supersededBy: replacement.id }, replacement };
  }

  link(id, refs = []) {
    const record = this.get(id);
    if (!record) {
      throw new Error("Unknown memory record: " + id);
    }
    return this.update(id, { refs: [...new Set([...record.refs, ...refs.map((ref) => String(ref))])] });
  }

  /**
   * Ranked recall across facets. Lexical relevance (BM25) is combined with
   * recency decay, stored confidence and how often the record proved useful.
   */
  recall({
    query = "",
    facets = memoryFacets,
    domain = null,
    project = null,
    tags = [],
    entities = [],
    limit = 12,
    minScore = 0,
    asOf = null,
    includeSuperseded = false
  } = {}) {
    const moment = new Date(asOf ?? this.now()).getTime();
    const pool = facets
      .filter((facet) => memoryFacets.includes(facet))
      .flatMap((facet) => this.all(facet))
      .filter((record) => !domain || !record.domain || record.domain === domain)
      .filter((record) => !project || !record.project || record.project === project)
      .filter((record) => !tags.length || tags.every((tag) => record.tags.includes(tag)))
      .filter((record) => !entities.length || (record.entities ?? []).some((entity) => entities.includes(entity)))
      .filter((record) => includeSuperseded || !record.supersededBy || !this.exists(record.facet, record.supersededBy))
      .filter((record) => !record.validFrom || new Date(record.validFrom).getTime() <= moment)
      .filter((record) => {
        if (includeSuperseded || !record.validTo) {
          return true;
        }
        if (record.supersededBy && !this.exists(record.facet, record.supersededBy)) {
          return true;
        }
        return new Date(record.validTo).getTime() > moment;
      })
      .filter((record) => !record.expiresAt || new Date(record.expiresAt).getTime() > moment);
    if (!pool.length) {
      return [];
    }
    const queryTokens = uniqueTokens(query);
    const documents = pool.map((record) => ({
      record,
      tokens: tokenize([record.title, record.body, record.tags.join(" ")].join(" "))
    }));
    const averageLength = documents.reduce((sum, entry) => sum + entry.tokens.length, 0) / documents.length || 1;
    const frequency = new Map();
    for (const entry of documents) {
      for (const token of new Set(entry.tokens)) {
        frequency.set(token, (frequency.get(token) ?? 0) + 1);
      }
    }
    const nowMs = this.clock().getTime();
    const scored = documents.map(({ record, tokens }) => {
      const lexical = queryTokens.length ? bm25(queryTokens, tokens, frequency, documents.length, averageLength) : 0;
      const ageDays = Math.max(0, (nowMs - new Date(record.at).getTime()) / DAY);
      const halfLife = FACET_DEFAULTS[record.facet].halfLifeDays;
      const recency = Math.pow(0.5, ageDays / halfLife);
      const usage = Math.log2(1 + record.hits) / 4;
      const base = queryTokens.length ? lexical : 1;
      const importance = 0.75 + 0.5 * (record.importance ?? 0.5);
      const score = base * (0.55 + 0.45 * record.confidence) * record.weight * importance * (0.6 + 0.4 * recency) + usage;
      return { ...record, score: Number(score.toFixed(4)), recency: Number(recency.toFixed(3)) };
    });
    const ranked = scored
      .filter((entry) => entry.score > minScore)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, limit);
    if (ranked.length || !(domain || project || entities.length)) {
      return ranked;
    }
    // Nothing matched the words, but the engagement is known: fall back to what
    // belongs to this domain, project or entity, ranked by importance and age.
    return scored
      .filter((entry) => (domain && entry.domain === domain) || (project && entry.project === project) || entities.some((entity) => (entry.entities ?? []).includes(entity)))
      .map((entry) => ({ ...entry, score: Number(((entry.importance ?? 0.5) * entry.confidence * (0.5 + 0.5 * entry.recency)).toFixed(4)), matchedBy: "engagement" }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, limit);
  }

  /**
   * Render a recall result as a compact context block that fits a token budget.
   */
  brief({ query = "", facets = memoryFacets, domain = null, project = null, budget = 900, limit = 12 } = {}) {
    const hits = this.recall({ query, facets, domain, project, limit });
    const lines = [];
    let used = 0;
    for (const hit of hits) {
      const line = "- [" + hit.facet + "] " + hit.title + (hit.body ? " — " + firstLine(hit.body) : "");
      const cost = estimateTokens(line);
      if (used + cost > budget) {
        break;
      }
      used += cost;
      lines.push(line);
    }
    return { lines, tokens: used, considered: hits.length, rendered: lines.length };
  }

  /**
   * Merge near duplicates, decay stale weights and compact the JSONL files.
   */
  consolidate({ similarity = 0.82, minWeight = 0.12, minAgeDays = 30 } = {}) {
    const report = { merged: 0, decayed: 0, dropped: 0, kept: 0, protected: 0 };
    const nowMs = this.clock().getTime();
    for (const facet of memoryFacets) {
      const records = this.all(facet);
      if (!records.length) {
        continue;
      }
      const halfLife = FACET_DEFAULTS[facet].halfLifeDays;
      const survivors = [];
      for (const record of [...records].sort((a, b) => new Date(a.at) - new Date(b.at))) {
        // A record that takes part in a supersede chain is history, not noise:
        // merging it would destroy both the correction and what it corrected.
        if (record.supersededBy || record.supersedes) {
          survivors.push({ record: { ...record }, tokens: uniqueTokens(record.title + " " + record.body), chained: true });
          continue;
        }
        const tokens = uniqueTokens(record.title + " " + record.body);
        const twin = survivors.find((entry) => !entry.chained && jaccard(entry.tokens, tokens) >= similarity);
        if (twin) {
          // The newer observation wins on content; the older one contributes
          // its evidence.
          twin.record.hits += record.hits + 1;
          twin.record.confidence = clamp(Math.max(twin.record.confidence, record.confidence) + 0.05, 0, 1);
          twin.record.refs = [...new Set([...twin.record.refs, ...record.refs])];
          twin.record.tags = [...new Set([...twin.record.tags, ...record.tags])];
          twin.record.entities = [...new Set([...(twin.record.entities ?? []), ...(record.entities ?? [])])];
          twin.record.importance = Math.max(twin.record.importance ?? 0.5, record.importance ?? 0.5);
          twin.record.weight = Math.max(twin.record.weight, record.weight);
          twin.record.title = record.title || twin.record.title;
          twin.record.body = record.body || twin.record.body;
          twin.record.at = record.at;
          twin.record.updatedAt = this.now();
          report.merged += 1;
          continue;
        }
        survivors.push({ record: { ...record }, tokens, chained: false });
      }

      // Anything a survivor still points at has to stay reachable, or the chain
      // it belongs to becomes a dangling pointer.
      const referenced = new Set();
      for (const { record } of survivors) {
        for (const id of [record.supersededBy, record.supersedes, ...(record.refs ?? [])]) {
          if (id) {
            referenced.add(id);
          }
        }
      }

      const kept = [];
      let droppedHere = 0;
      for (const { record } of survivors) {
        // Decay measures the time since the last pass, not the age of the
        // record, so running nightly and running once a month agree.
        const since = new Date(record.decayedAt ?? record.updatedAt ?? record.at).getTime();
        const elapsedDays = Math.max(0, (nowMs - since) / DAY);
        if (elapsedDays > 0) {
          const decayed = record.weight * Math.pow(0.5, elapsedDays / (halfLife * 3));
          if (decayed !== record.weight) {
            record.weight = Number(decayed.toFixed(4));
            report.decayed += 1;
          }
          record.decayedAt = new Date(nowMs).toISOString();
        }
        const ageDays = Math.max(0, (nowMs - new Date(record.at).getTime()) / DAY);
        const expired = record.expiresAt && new Date(record.expiresAt).getTime() <= nowMs;
        const faded = record.weight < minWeight && record.hits === 0 && ageDays >= minAgeDays;
        if (expired || faded) {
          if (referenced.has(record.id)) {
            report.protected += 1;
          } else {
            report.dropped += 1;
            droppedHere += 1;
            continue;
          }
        }
        kept.push(record);
      }

      if (droppedHere > 0) {
        this.backup(facet, records);
      }
      mkdirSync(this.directory, { recursive: true });
      writeFileSync(this.path(facet), kept.map((record) => JSON.stringify(record)).join("\n") + (kept.length ? "\n" : ""), "utf8");
      this.cache.delete(facet);
      report.kept += kept.length;
    }
    return report;
  }

  /**
   * Nothing is deleted from a facet without a copy of what it looked like
   * first.
   */
  backup(facet, records) {
    const directory = join(this.root, ".astack", "backups", "memory");
    mkdirSync(directory, { recursive: true });
    const stamp = this.now().replace(/[:.]/g, "-");
    const path = join(directory, facet + "-" + stamp + ".jsonl");
    writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""), "utf8");
    return path;
  }

  exists(facet, id) {
    return this.all(facet).some((record) => record.id === id);
  }

  stats() {
    const byFacet = {};
    let total = 0;
    let tokens = 0;
    for (const facet of memoryFacets) {
      const records = this.all(facet);
      byFacet[facet] = {
        records: records.length,
        avgConfidence: records.length
          ? Number((records.reduce((sum, record) => sum + record.confidence, 0) / records.length).toFixed(3))
          : 0,
        hits: records.reduce((sum, record) => sum + record.hits, 0)
      };
      total += records.length;
      tokens += records.reduce((sum, record) => sum + estimateTokens(record.title + " " + record.body), 0);
    }
    return { total, tokens, byFacet };
  }
}

function bm25(queryTokens, documentTokens, frequency, documentCount, averageLength, k1 = 1.4, b = 0.7) {
  const counts = new Map();
  for (const token of documentTokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  let score = 0;
  for (const token of queryTokens) {
    const termFrequency = counts.get(token) ?? 0;
    if (!termFrequency) {
      continue;
    }
    const documentFrequency = frequency.get(token) ?? 0;
    const idf = Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
    const norm = termFrequency * (k1 + 1) / (termFrequency + k1 * (1 - b + b * documentTokens.length / averageLength));
    score += idf * norm;
  }
  return score;
}

function firstLine(text) {
  const line = String(text).split(/\r?\n/).find((entry) => entry.trim());
  return line ? line.trim().slice(0, 180) : "";
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}
