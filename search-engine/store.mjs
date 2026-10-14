import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ftsQuery, indexText, queryTerms, searchTokens } from "./normalize.mjs";

/**
 * Two interchangeable stores behind one interface:
 *
 * - SqliteStore: `node:sqlite` (Node >= 22.5) with an FTS5 table ranked by
 *   BM25 and vectors stored as Float32 BLOBs.
 * - JsonStore: the fallback for older Node — the same records in one JSON
 *   file, ranked in memory with the BM25 scoring AStack already uses for
 *   memory recall.
 *
 * Both store normalized text in the searchable columns and the original
 * (redacted) text for display, so snippets keep their case and spelling.
 */

export const SCHEMA_VERSION = 1;
// Bump when the normalizer changes so existing indexes are rebuilt.
export const NORMALIZER_VERSION = 1;

const require = createRequire(import.meta.url);
let sqliteModule;

/**
 * Load node:sqlite synchronously, without the ExperimentalWarning older Node
 * versions print. Returns null when the module is unavailable.
 */
export function loadSqlite() {
  if (sqliteModule !== undefined) {
    return sqliteModule;
  }
  const original = process.emitWarning;
  try {
    process.emitWarning = (warning, ...rest) => {
      const text = String(warning?.message ?? warning);
      if (/sqlite/i.test(text)) {
        return;
      }
      return original.call(process, warning, ...rest);
    };
    const module = require("node:sqlite");
    // FTS5 must be compiled in; probe it once.
    const probe = new module.DatabaseSync(":memory:");
    probe.exec("CREATE VIRTUAL TABLE probe USING fts5(a)");
    probe.close();
    sqliteModule = module;
  } catch {
    sqliteModule = null;
  } finally {
    process.emitWarning = original;
  }
  return sqliteModule;
}

export function sqliteAvailable() {
  return loadSqlite() !== null;
}

/** Visibility rules shared by both stores. */
function visibilityClause(filter) {
  if (filter.includeSuperseded) {
    return { sql: "1 = 1", params: [] };
  }
  if (filter.asOf) {
    return {
      sql: "(d.valid_from IS NULL OR d.valid_from <= ?) AND (d.valid_to IS NULL OR d.valid_to > ?)",
      params: [filter.asOf, filter.asOf]
    };
  }
  return { sql: "d.status = 'active' AND (d.valid_to IS NULL OR d.valid_to > ?)", params: [filter.now] };
}

function visible(doc, filter) {
  if (filter.includeSuperseded) {
    return true;
  }
  if (filter.asOf) {
    return (!doc.valid_from || doc.valid_from <= filter.asOf) && (!doc.valid_to || doc.valid_to > filter.asOf);
  }
  return doc.status === "active" && (!doc.valid_to || doc.valid_to > filter.now);
}

export function vectorToBlob(vector) {
  const array = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

export function blobToVector(blob) {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const copy = bytes.slice();
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

function inList(values) {
  return values.map(() => "?").join(",");
}

export class SqliteStore {
  constructor(path) {
    this.path = path;
    this.kind = "sqlite";
    const { DatabaseSync } = loadSqlite();
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  migrate() {
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    const version = this.db.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value;
    const wanted = SCHEMA_VERSION + "." + NORMALIZER_VERSION;
    if (version && version !== wanted) {
      this.db.exec("DROP TABLE IF EXISTS docs_fts; DROP TABLE IF EXISTS vectors; DROP TABLE IF EXISTS docs; DROP TABLE IF EXISTS units;");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS units (
        source TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT, hash TEXT, indexed_at TEXT, docs INTEGER DEFAULT 0,
        PRIMARY KEY (source, key)
      );
      CREATE TABLE IF NOT EXISTS docs (
        rowid INTEGER PRIMARY KEY, id TEXT UNIQUE, source TEXT NOT NULL, unit TEXT NOT NULL, kind TEXT,
        title TEXT, path TEXT, date TEXT, text TEXT, status TEXT DEFAULT 'active', valid_from TEXT, valid_to TEXT, meta TEXT
      );
      CREATE INDEX IF NOT EXISTS docs_unit ON docs (source, unit);
      CREATE INDEX IF NOT EXISTS docs_source_date ON docs (source, date);
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5 (title, body, tokenize = 'unicode61 remove_diacritics 2');
      CREATE TABLE IF NOT EXISTS vectors (doc_rowid INTEGER PRIMARY KEY, model TEXT, dim INTEGER, vector BLOB);
    `);
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('version', ?)").run(wanted);
  }

  transaction(fn) {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  unit(source, key) {
    return this.db.prepare("SELECT key, fingerprint, hash, docs FROM units WHERE source = ? AND key = ?").get(source, key) ?? null;
  }

  units(source) {
    return this.db.prepare("SELECT key, fingerprint, hash, docs FROM units WHERE source = ?").all(source);
  }

  deleteDocs(source, key) {
    this.db.prepare("DELETE FROM docs_fts WHERE rowid IN (SELECT rowid FROM docs WHERE source = ? AND unit = ?)").run(source, key);
    this.db.prepare("DELETE FROM vectors WHERE doc_rowid IN (SELECT rowid FROM docs WHERE source = ? AND unit = ?)").run(source, key);
    this.db.prepare("DELETE FROM docs WHERE source = ? AND unit = ?").run(source, key);
  }

  replaceUnit(source, key, { fingerprint, hash, at }, docs) {
    return this.transaction(() => {
      this.deleteDocs(source, key);
      const insertDoc = this.db.prepare(
        "INSERT OR REPLACE INTO docs (id, source, unit, kind, title, path, date, text, status, valid_from, valid_to, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      const insertFts = this.db.prepare("INSERT INTO docs_fts (rowid, title, body) VALUES (?, ?, ?)");
      for (const doc of docs) {
        // A doc id that moved from another unit is replaced, not duplicated.
        const prior = this.db.prepare("SELECT rowid FROM docs WHERE id = ?").get(doc.id);
        if (prior) {
          this.db.prepare("DELETE FROM docs_fts WHERE rowid = ?").run(prior.rowid);
          this.db.prepare("DELETE FROM vectors WHERE doc_rowid = ?").run(prior.rowid);
          this.db.prepare("DELETE FROM docs WHERE rowid = ?").run(prior.rowid);
        }
        const info = insertDoc.run(
          doc.id, source, key, doc.kind ?? null, doc.title ?? "", doc.path ?? null, doc.date ?? null, doc.text ?? "",
          doc.status ?? "active", doc.validFrom ?? null, doc.validTo ?? null, JSON.stringify(doc.meta ?? {})
        );
        insertFts.run(Number(info.lastInsertRowid), indexText(doc.title ?? ""), indexText(doc.text ?? ""));
      }
      this.db.prepare("INSERT OR REPLACE INTO units (source, key, fingerprint, hash, indexed_at, docs) VALUES (?, ?, ?, ?, ?, ?)").run(
        source, key, fingerprint ?? null, hash ?? null, at ?? null, docs.length
      );
      return docs.length;
    });
  }

  touchUnit(source, key, fingerprint) {
    this.db.prepare("UPDATE units SET fingerprint = ? WHERE source = ? AND key = ?").run(fingerprint, source, key);
  }

  removeUnit(source, key) {
    this.transaction(() => {
      this.deleteDocs(source, key);
      this.db.prepare("DELETE FROM units WHERE source = ? AND key = ?").run(source, key);
    });
  }

  search(text, { sources, limit = 50, filter }) {
    const match = ftsQuery(text);
    if (!match || !sources.length) {
      return [];
    }
    const visibility = visibilityClause(filter);
    const rows = this.db.prepare(
      "SELECT d.*, bm25(docs_fts, 3.0, 1.0) AS rank FROM docs_fts JOIN docs d ON d.rowid = docs_fts.rowid " +
        "WHERE docs_fts MATCH ? AND d.source IN (" + inList(sources) + ") AND " + visibility.sql + " ORDER BY rank LIMIT ?"
    ).all(match, ...sources, ...visibility.params, limit);
    return rows.map((row) => ({ doc: hydrate(row), lexical: -row.rank }));
  }

  vectorCandidates(model, { sources, filter }) {
    const visibility = visibilityClause(filter);
    return this.db.prepare(
      "SELECT d.rowid AS rowid, v.vector AS vector FROM vectors v JOIN docs d ON d.rowid = v.doc_rowid " +
        "WHERE v.model = ? AND d.source IN (" + inList(sources) + ") AND " + visibility.sql
    ).all(model, ...sources, ...visibility.params).map((row) => ({ rowid: row.rowid, vector: blobToVector(row.vector) }));
  }

  docsByRowid(rowids) {
    if (!rowids.length) {
      return [];
    }
    return this.db.prepare("SELECT * FROM docs WHERE rowid IN (" + inList(rowids) + ")").all(...rowids).map(hydrate);
  }

  missingVectors(model, { sources, limit = 64 }) {
    return this.db.prepare(
      "SELECT d.rowid AS rowid, d.title AS title, d.text AS text FROM docs d LEFT JOIN vectors v ON v.doc_rowid = d.rowid AND v.model = ? " +
        "WHERE v.doc_rowid IS NULL AND d.source IN (" + inList(sources) + ") LIMIT ?"
    ).all(model, ...sources, limit);
  }

  setVectors(model, entries) {
    this.transaction(() => {
      const statement = this.db.prepare("INSERT OR REPLACE INTO vectors (doc_rowid, model, dim, vector) VALUES (?, ?, ?, ?)");
      for (const { rowid, vector } of entries) {
        statement.run(rowid, model, vector.length, vectorToBlob(vector));
      }
    });
  }

  list({ source, kinds = null, limit = 50, filter, order = "date" }) {
    const visibility = visibilityClause(filter);
    const kindSql = kinds?.length ? " AND d.kind IN (" + inList(kinds) + ")" : "";
    return this.db.prepare(
      "SELECT d.* FROM docs d WHERE d.source = ?" + kindSql + " AND " + visibility.sql + " ORDER BY " + (order === "date" ? "d.date DESC" : "d.rowid") + " LIMIT ?"
    ).all(source, ...(kinds ?? []), ...visibility.params, limit).map(hydrate);
  }

  stats() {
    const bySource = {};
    for (const row of this.db.prepare("SELECT source, COUNT(*) AS count FROM docs GROUP BY source").all()) {
      bySource[row.source] = { docs: row.count, units: 0, vectors: 0 };
    }
    for (const row of this.db.prepare("SELECT source, COUNT(*) AS count FROM units GROUP BY source").all()) {
      bySource[row.source] = { docs: 0, vectors: 0, ...bySource[row.source], units: row.count };
    }
    for (const row of this.db.prepare("SELECT d.source AS source, v.model AS model, COUNT(*) AS count FROM vectors v JOIN docs d ON d.rowid = v.doc_rowid GROUP BY d.source, v.model").all()) {
      bySource[row.source] = { docs: 0, units: 0, ...bySource[row.source], vectors: (bySource[row.source]?.vectors ?? 0) + row.count };
    }
    const models = this.db.prepare("SELECT model, COUNT(*) AS count, MAX(dim) AS dim FROM vectors GROUP BY model").all().map((row) => ({ ...row }));
    let bytes = 0;
    for (const suffix of ["", "-wal"]) {
      try {
        bytes += statSync(this.path + suffix).size;
      } catch {
        // Missing WAL file is fine.
      }
    }
    return { backend: "sqlite", bySource, models, bytes };
  }

  close() {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // A concurrent reader may hold the WAL; the checkpoint happens later.
    }
    this.db.close();
  }
}

function hydrate(row) {
  const doc = { ...row };
  try {
    doc.meta = row.meta ? JSON.parse(row.meta) : {};
  } catch {
    doc.meta = {};
  }
  delete doc.rank;
  return doc;
}

/**
 * The fallback store: everything in one JSON file, ranked in memory.
 */
export class JsonStore {
  constructor(path) {
    this.path = path;
    this.kind = "json";
    this.data = { version: SCHEMA_VERSION + "." + NORMALIZER_VERSION, units: {}, docs: {}, vectors: {}, nextRowid: 1 };
    if (existsSync(path)) {
      try {
        const loaded = JSON.parse(readFileSync(path, "utf8"));
        if (loaded.version === this.data.version) {
          this.data = loaded;
        }
      } catch {
        // A corrupt fallback index is rebuilt from the sources.
      }
    }
    this.dirty = false;
  }

  unitKey(source, key) {
    return source + "\u0000" + key;
  }

  unit(source, key) {
    const entry = this.data.units[this.unitKey(source, key)];
    return entry ? { key, ...entry } : null;
  }

  units(source) {
    return Object.entries(this.data.units)
      .filter(([compound]) => compound.startsWith(source + "\u0000"))
      .map(([compound, entry]) => ({ key: compound.slice(source.length + 1), ...entry }));
  }

  deleteDocs(source, key) {
    for (const [rowid, doc] of Object.entries(this.data.docs)) {
      if (doc.source === source && doc.unit === key) {
        delete this.data.docs[rowid];
        delete this.data.vectors[rowid];
      }
    }
  }

  replaceUnit(source, key, { fingerprint, hash, at }, docs) {
    this.deleteDocs(source, key);
    for (const doc of docs) {
      for (const [rowid, existing] of Object.entries(this.data.docs)) {
        if (existing.id === doc.id) {
          delete this.data.docs[rowid];
          delete this.data.vectors[rowid];
        }
      }
      const rowid = this.data.nextRowid++;
      this.data.docs[rowid] = {
        rowid, id: doc.id, source, unit: key, kind: doc.kind ?? null, title: doc.title ?? "", path: doc.path ?? null,
        date: doc.date ?? null, text: doc.text ?? "", status: doc.status ?? "active", valid_from: doc.validFrom ?? null,
        valid_to: doc.validTo ?? null, meta: doc.meta ?? {}
      };
    }
    this.data.units[this.unitKey(source, key)] = { fingerprint: fingerprint ?? null, hash: hash ?? null, indexed_at: at ?? null, docs: docs.length };
    this.dirty = true;
    return docs.length;
  }

  touchUnit(source, key, fingerprint) {
    const entry = this.data.units[this.unitKey(source, key)];
    if (entry) {
      entry.fingerprint = fingerprint;
      this.dirty = true;
    }
  }

  removeUnit(source, key) {
    this.deleteDocs(source, key);
    delete this.data.units[this.unitKey(source, key)];
    this.dirty = true;
  }

  search(text, { sources, limit = 50, filter }) {
    const terms = queryTerms(text);
    if (!terms.length || !sources.length) {
      return [];
    }
    const pool = Object.values(this.data.docs).filter((doc) => sources.includes(doc.source) && visible(doc, filter));
    if (!pool.length) {
      return [];
    }
    const documents = pool.map((doc) => {
      const titleTokens = searchTokens(indexText(doc.title), { keepStopwords: true });
      const bodyTokens = searchTokens(indexText(doc.text), { keepStopwords: true });
      return { doc, tokens: [...titleTokens, ...titleTokens, ...titleTokens, ...bodyTokens] };
    });
    const average = documents.reduce((sum, entry) => sum + entry.tokens.length, 0) / documents.length || 1;
    const frequency = new Map();
    for (const entry of documents) {
      for (const token of new Set(entry.tokens)) {
        frequency.set(token, (frequency.get(token) ?? 0) + 1);
      }
    }
    const scored = [];
    for (const { doc, tokens } of documents) {
      const score = bm25Prefix(terms, tokens, frequency, documents.length, average);
      if (score > 0) {
        scored.push({ doc, lexical: score });
      }
    }
    return scored.sort((a, b) => b.lexical - a.lexical || a.doc.rowid - b.doc.rowid).slice(0, limit);
  }

  vectorCandidates(model, { sources, filter }) {
    const result = [];
    for (const [rowid, entry] of Object.entries(this.data.vectors)) {
      const doc = this.data.docs[rowid];
      if (entry.model === model && doc && sources.includes(doc.source) && visible(doc, filter)) {
        result.push({ rowid: Number(rowid), vector: Float32Array.from(entry.vector) });
      }
    }
    return result;
  }

  docsByRowid(rowids) {
    return rowids.map((rowid) => this.data.docs[rowid]).filter(Boolean);
  }

  missingVectors(model, { sources, limit = 64 }) {
    return Object.values(this.data.docs)
      .filter((doc) => sources.includes(doc.source) && this.data.vectors[doc.rowid]?.model !== model)
      .slice(0, limit)
      .map((doc) => ({ rowid: doc.rowid, title: doc.title, text: doc.text }));
  }

  setVectors(model, entries) {
    for (const { rowid, vector } of entries) {
      this.data.vectors[rowid] = { model, vector: Array.from(vector, (value) => Number(value.toFixed(6))) };
    }
    this.dirty = true;
  }

  list({ source, kinds = null, limit = 50, filter, order = "date" }) {
    const docs = Object.values(this.data.docs).filter((doc) => doc.source === source && (!kinds?.length || kinds.includes(doc.kind)) && visible(doc, filter));
    if (order === "date") {
      docs.sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
    }
    return docs.slice(0, limit);
  }

  stats() {
    const bySource = {};
    for (const doc of Object.values(this.data.docs)) {
      bySource[doc.source] = bySource[doc.source] ?? { docs: 0, units: 0, vectors: 0 };
      bySource[doc.source].docs += 1;
      if (this.data.vectors[doc.rowid]) {
        bySource[doc.source].vectors += 1;
      }
    }
    for (const compound of Object.keys(this.data.units)) {
      const source = compound.split("\u0000")[0];
      bySource[source] = bySource[source] ?? { docs: 0, units: 0, vectors: 0 };
      bySource[source].units += 1;
    }
    const models = {};
    for (const entry of Object.values(this.data.vectors)) {
      models[entry.model] = models[entry.model] ?? { model: entry.model, count: 0, dim: entry.vector.length };
      models[entry.model].count += 1;
    }
    let bytes = 0;
    try {
      bytes = statSync(this.path).size;
    } catch {
      bytes = 0;
    }
    return { backend: "json", bySource, models: Object.values(models), bytes };
  }

  close() {
    if (!this.dirty) {
      return;
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = this.path + ".tmp";
    writeFileSync(temporary, JSON.stringify(this.data), "utf8");
    renameSync(temporary, this.path);
    this.dirty = false;
  }
}

function bm25Prefix(terms, tokens, frequency, documentCount, averageLength, k1 = 1.2, b = 0.75) {
  let score = 0;
  for (const term of terms) {
    const prefix = term.length >= 3;
    let termFrequency = 0;
    for (const token of tokens) {
      if (token === term || (prefix && token.startsWith(term))) {
        termFrequency += 1;
      }
    }
    if (!termFrequency) {
      continue;
    }
    let documentFrequency = 0;
    for (const [token, count] of frequency) {
      if (token === term || (prefix && token.startsWith(term))) {
        documentFrequency = Math.max(documentFrequency, count);
      }
    }
    const idf = Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
    score += idf * (termFrequency * (k1 + 1)) / (termFrequency + k1 * (1 - b + b * tokens.length / averageLength));
  }
  return score;
}
