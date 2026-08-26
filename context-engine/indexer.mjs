import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { estimateTokens, tokenize } from "../lib/text.mjs";
import { categoryOf, detectLanguage, extractFile } from "./extractors.mjs";

export const INDEX_VERSION = 2;

function toPosix(value) {
  return String(value).replace(/\\/g, "/");
}

export function readIgnoreFile(root) {
  const patterns = [];
  for (const name of [".astackignore", ".gitignore"]) {
    const path = join(root, name);
    if (!existsSync(path)) {
      continue;
    }
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) {
        continue;
      }
      patterns.push(trimmed.replace(/\/$/, ""));
    }
  }
  return patterns;
}

function matchesIgnore(rel, patterns) {
  for (const pattern of patterns) {
    if (!pattern) {
      continue;
    }
    if (pattern.includes("*")) {
      const expression = new RegExp("^" + pattern.split("*").map(escapeRegExp).join("[^/]*") + "$");
      const base = rel.split("/").pop();
      if (expression.test(rel) || expression.test(base)) {
        return true;
      }
      continue;
    }
    if (rel === pattern || rel.startsWith(pattern + "/") || rel.split("/").includes(pattern)) {
      return true;
    }
  }
  return false;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Incremental workspace indexer. Files are re-parsed only when their content
 * hash changes, so a rebuild over a large practice folder stays cheap and the
 * map is always consistent with what is on disk.
 */
export class Indexer {
  constructor(root, { lenses, clock, maxFiles = 20000 } = {}) {
    this.root = root;
    this.lenses = lenses;
    this.clock = clock ?? (() => new Date());
    this.maxFiles = maxFiles;
    this.directory = join(root, ".astack", "context");
    this.indexPath = join(this.directory, "index.json");
  }

  defaults() {
    return this.lenses.defaults;
  }

  signalDefinitionsFor(domainId) {
    const generic = this.lenses.genericSignals ?? [];
    const lens = this.lensFor(domainId);
    return [...generic, ...(lens?.signals ?? []), ...this.otherLensSignals(lens)];
  }

  lensFor(domainId) {
    if (!domainId) {
      return null;
    }
    return this.lenses.lenses.find((entry) => entry.domains.includes(domainId)) ?? null;
  }

  /**
   * Signals from other lenses are still collected, at a lower weight: a legal
   * folder can hold invoices, and a software project can hold a contract.
   */
  otherLensSignals(activeLens) {
    return this.lenses.lenses
      .filter((lens) => !activeLens || lens.id !== activeLens.id)
      .flatMap((lens) => lens.signals.map((signal) => ({ ...signal, weight: (signal.weight ?? 1) * 0.6 })));
  }

  walk({ ignore = [] } = {}) {
    const defaults = this.defaults();
    const patterns = [...new Set([...(defaults.ignore ?? []), ...ignore, ...readIgnoreFile(this.root)])];
    const files = [];
    const stack = [this.root];
    while (stack.length && files.length < this.maxFiles) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const absolute = join(current, entry.name);
        const rel = toPosix(relative(this.root, absolute));
        if (!rel || matchesIgnore(rel, patterns)) {
          continue;
        }
        if (entry.isDirectory()) {
          stack.push(absolute);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        let stats = null;
        try {
          stats = statSync(absolute);
        } catch {
          continue;
        }
        files.push({ rel, absolute, size: stats.size, mtime: stats.mtime.toISOString() });
      }
    }
    return files.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  loadIndex() {
    if (!existsSync(this.indexPath)) {
      return null;
    }
    try {
      const index = JSON.parse(readFileSync(this.indexPath, "utf8"));
      return index.version === INDEX_VERSION ? index : null;
    } catch {
      return null;
    }
  }

  saveIndex(index) {
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(this.indexPath, JSON.stringify(index) + "\n", "utf8");
    return this.indexPath;
  }

  indexFile(file, signalDefinitions) {
    const defaults = this.defaults();
    const category = categoryOf(file.rel, { opaqueExtensions: defaults.opaqueExtensions });
    const language = detectLanguage(file.rel);
    const base = {
      rel: file.rel,
      size: file.size,
      mtime: file.mtime,
      category,
      language,
      opaque: category === "opaque",
      nameTokens: tokenize(file.rel.split("/").pop()),
      folder: file.rel.includes("/") ? file.rel.slice(0, file.rel.lastIndexOf("/")) : ".",
      symbols: [],
      headings: [],
      imports: [],
      links: [],
      signals: [],
      lines: 0,
      tokens: 0,
      title: null
    };
    if (category === "opaque") {
      base.hash = "opaque:" + file.size + ":" + file.mtime;
      base.tokens = Math.ceil(file.size / 1400);
      return base;
    }
    if (file.size > defaults.maxFileBytes) {
      base.hash = "large:" + file.size + ":" + file.mtime;
      base.oversized = true;
      base.tokens = Math.ceil(file.size / 4);
      return base;
    }
    let text = "";
    try {
      text = readFileSync(file.absolute, "utf8");
    } catch {
      base.hash = "unreadable:" + file.size;
      base.unreadable = true;
      return base;
    }
    if (text.includes(String.fromCharCode(0))) {
      base.opaque = true;
      base.category = "opaque";
      base.hash = "binary:" + file.size;
      return base;
    }
    base.hash = createHash("sha1").update(text).digest("hex").slice(0, 16);
    const extracted = extractFile({
      relPath: file.rel,
      text,
      language,
      category,
      signalDefinitions,
      maxScanLines: defaults.maxScanLines
    });
    base.symbols = extracted.symbols;
    base.headings = extracted.headings;
    base.imports = extracted.imports;
    base.links = extracted.links;
    base.signals = extracted.signals;
    base.lines = extracted.lines;
    base.tokens = estimateTokens(text);
    base.title = extracted.headings[0]?.text ?? null;
    base.summary = summarize(text, category);
    base.terms = topTerms(text);
    return base;
  }

  build({ force = false, domain = null, ignore = [] } = {}) {
    const started = Date.now();
    const previous = force ? null : this.loadIndex();
    const signalDefinitions = this.signalDefinitionsFor(domain);
    const files = this.walk({ ignore });
    const entries = {};
    let reused = 0;
    let parsed = 0;
    for (const file of files) {
      const cached = previous?.files?.[file.rel];
      if (
        cached &&
        cached.size === file.size &&
        cached.mtime === file.mtime &&
        cached.signalVersion === this.lenses.version &&
        (cached.signalDomain ?? null) === domain
      ) {
        entries[file.rel] = cached;
        reused += 1;
        continue;
      }
      const record = this.indexFile(file, signalDefinitions);
      record.signalVersion = this.lenses.version;
      record.signalDomain = domain;
      entries[file.rel] = record;
      parsed += 1;
    }
    const index = {
      version: INDEX_VERSION,
      builtAt: this.clock().toISOString(),
      root: toPosix(this.root),
      domain,
      lensVersion: this.lenses.version,
      files: entries,
      stats: {
        files: files.length,
        parsed,
        reused,
        symbols: Object.values(entries).reduce((sum, entry) => sum + entry.symbols.length, 0),
        headings: Object.values(entries).reduce((sum, entry) => sum + entry.headings.length, 0),
        signals: Object.values(entries).reduce((sum, entry) => sum + entry.signals.length, 0),
        opaque: Object.values(entries).filter((entry) => entry.opaque).length,
        corpusTokens: Object.values(entries).reduce((sum, entry) => sum + (entry.tokens ?? 0), 0),
        durationMs: Date.now() - started
      }
    };
    this.saveIndex(index);
    return index;
  }

  /**
   * Report files whose content changed since the index was built. A stale map
   * is never silently served: the caller decides to rebuild or to warn.
   */
  verify() {
    const index = this.loadIndex();
    if (!index) {
      return { built: false, stale: [], missing: [], added: [] };
    }
    const files = this.walk();
    const seen = new Set();
    const stale = [];
    const added = [];
    for (const file of files) {
      seen.add(file.rel);
      const entry = index.files[file.rel];
      if (!entry) {
        added.push(file.rel);
        continue;
      }
      if (entry.size !== file.size || entry.mtime !== file.mtime) {
        stale.push(file.rel);
      }
    }
    const missing = Object.keys(index.files).filter((rel) => !seen.has(rel));
    return { built: true, builtAt: index.builtAt, stale, missing, added, fresh: !stale.length && !missing.length && !added.length };
  }
}

const CODE_NOISE = new Set([
  "const", "let", "var", "return", "function", "func", "class", "this", "self", "new", "null", "true", "false",
  "import", "export", "require", "module", "default", "public", "private", "protected", "static", "void", "async",
  "await", "throw", "catch", "try", "finally", "else", "elif", "endif", "end", "def", "print", "echo", "push",
  "length", "string", "number", "boolean", "object", "array", "value", "values", "item", "items", "entry",
  "entries", "index", "key", "keys", "name", "type", "data", "result", "results", "options", "option", "config",
  "path", "join", "map", "filter", "foreach", "each", "next", "prev", "true", "false", "int", "str", "bool",
  "float", "list", "dict", "set", "get", "add", "call", "args", "kwargs", "param", "params", "props", "state",
  "div", "span", "html", "body", "head", "href", "src", "img", "css", "font", "color", "size", "width", "height"
]);

/**
 * A tiny per file term index. It keeps the map cheap while letting a query hit
 * a file by what it says, not only by how it is named.
 */
function topTerms(text, limit = 32) {
  const counts = new Map();
  const split = text.slice(0, 200000).replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  for (const token of tokenize(split)) {
    if (token.length < 3 || /^[0-9]+$/.test(token) || CODE_NOISE.has(token)) {
      continue;
    }
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term, count]) => ({ t: term, n: count }));
}

function summarize(text, category) {
  const lines = text.split(/\r?\n/);
  if (category === "doc") {
    const paragraph = lines.find((line) => line.trim() && !line.trim().startsWith("#"));
    return paragraph ? paragraph.trim().slice(0, 200) : "";
  }
  const comment = lines.find((line) => /^\s*(?:\/\/|#|\*|--)\s*\w/.test(line));
  return comment ? comment.replace(/^\s*(?:\/\/|#|\*|--)\s*/, "").trim().slice(0, 200) : "";
}
