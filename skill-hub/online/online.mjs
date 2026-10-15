import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateTokens, shortHash, slugify, uniqueTokens } from "../../lib/text.mjs";
import { copySkill, discoverSkills, findLicense } from "../importer.mjs";
import { scanSkill, significant } from "../scanner.mjs";
import { PACK_NAME } from "../skill-hub.mjs";
import { fetchGitFolder } from "../sources.mjs";
import { OnlineError, httpGet, httpGetJson } from "./http.mjs";
import { extractZip } from "./zip.mjs";
import { cleanText } from "./registries/common.mjs";
import { skillssh } from "./registries/skillssh.mjs";
import { skillsmp } from "./registries/skillsmp.mjs";
import { clawhub } from "./registries/clawhub.mjs";
import { github } from "./registries/github.mjs";

/**
 * Online skill search: when no local skill fits a task, search public skill
 * registries, preview a candidate, and import it into an auxiliary pack —
 * on demand only, never by default.
 *
 * - search: the registries are queried in parallel; each answer is normalised,
 *   de-duplicated across registries (same GitHub repository and folder),
 *   ranked by text relevance plus log-popularity, and cached for
 *   `cache_minutes` in `.astack/skill-hub/online-cache/`. A failing registry is
 *   reported next to the others, never fatal.
 * - show: fetch into a temporary folder, scan, print, delete. Nothing stays.
 * - get: fetch, scan (blocked → refused, nothing written), then import through
 *   the existing importer into `skill-packs/<pack>/` (default `online`) so the
 *   scanner, catalog.json, PACK.md and SCAN.md work exactly as for any pack.
 *   The origin (registry, URL, commit or version, fetch date, content hash)
 *   is recorded in the pack's `ORIGINS.json` and on each catalog entry.
 *
 * Every URL passes `automationPolicy.allowHost`; git and gh pass
 * `allowInvocation`. Fetched files are data: nothing from a registry or a
 * fetched skill is executed.
 */

const moduleRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(moduleRoot, "package.json"), "utf8")).version ?? "0";
  } catch {
    return "0";
  }
})();

export const REGISTRIES = { skillssh, skillsmp, clawhub, github };
export const SOURCE_ORDER = ["skillssh", "skillsmp", "clawhub", "github"];
export const ORIGINS_FILE = "ORIGINS.json";
const HIT_INDEX_LIMIT = 1000;

export const DEFAULT_ONLINE_SETTINGS = {
  enabled: true,
  sources: SOURCE_ORDER,
  limit: 10,
  cacheMinutes: 60,
  pack: "online",
  timeoutMs: 15000,
  endpoints: {},
  skillsmpKey: null
};

function asList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  return null;
}

/**
 * Normalise the optional `skills.online` section of astack.config.yaml.
 */
export function onlineSettings(section = {}) {
  const value = section ?? {};
  const sources = (asList(value.sources) ?? DEFAULT_ONLINE_SETTINGS.sources).filter((source) => REGISTRIES[source]);
  const number = (raw, fallback) => (Number.isFinite(Number(raw)) && raw !== null && raw !== "" ? Number(raw) : fallback);
  return {
    enabled: value.enabled === undefined ? true : value.enabled !== false && value.enabled !== "false",
    sources: sources.length ? sources : DEFAULT_ONLINE_SETTINGS.sources,
    limit: Math.min(50, Math.max(1, number(value.limit, DEFAULT_ONLINE_SETTINGS.limit))),
    cacheMinutes: Math.max(0, number(value.cache_minutes ?? value.cacheMinutes, DEFAULT_ONLINE_SETTINGS.cacheMinutes)),
    pack: String(value.pack ?? DEFAULT_ONLINE_SETTINGS.pack),
    timeoutMs: Math.max(1000, number(value.timeout_ms ?? value.timeoutMs, DEFAULT_ONLINE_SETTINGS.timeoutMs)),
    endpoints: value.endpoints && typeof value.endpoints === "object" ? { ...value.endpoints } : {},
    skillsmpKey: /^credential:\/\//.test(String(value.skillsmp_key ?? value.skillsmpKey ?? "")) ? String(value.skillsmp_key ?? value.skillsmpKey) : null
  };
}

// ---------------------------------------------------------------- ranking

/** Popularity on a 0..1 log scale. Repository stars count a little less than installs. */
export function popularityScore(hit) {
  if (hit.popularityKind === "official") {
    return 1;
  }
  const value = Number(hit.popularity);
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(1, Math.log10(1 + value) / 6) * (hit.popularityKind === "stars" ? 0.8 : 1);
}

/** Same GitHub repository and skill folder → same skill, whatever the registry. */
export function dedupeKey(hit) {
  if (hit.repo) {
    const folder = hit.path ? hit.path.split("/").pop() : hit.path === "" ? hit.repo.split("/")[1] : hit.skillId;
    return "gh:" + hit.repo.toLowerCase() + ":" + slugify(folder ?? "", { maxLength: 80 });
  }
  return String(hit.id).toLowerCase();
}

export function dedupe(hits, order = SOURCE_ORDER) {
  const rank = (hit) => {
    const index = order.indexOf(hit.source);
    return index === -1 ? order.length : index;
  };
  const merged = new Map();
  for (const hit of [...hits].sort((a, b) => rank(a) - rank(b))) {
    const key = dedupeKey(hit);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...hit, key, sources: [hit.source], alternates: [], pop: popularityScore(hit) });
      continue;
    }
    if (!existing.sources.includes(hit.source)) {
      existing.sources.push(hit.source);
    }
    existing.alternates.push(hit.id);
    existing.pop = Math.max(existing.pop, popularityScore(hit));
    if (!existing.description && hit.description) {
      existing.description = hit.description;
    }
    // Prefer a known folder path for the fetch.
    if (existing.fetch?.type === "git" && !existing.fetch.path && hit.fetch?.type === "git" && hit.fetch.path) {
      existing.fetch = { ...existing.fetch, path: hit.fetch.path, ref: hit.fetch.ref ?? existing.fetch.ref };
      existing.path = hit.path;
      existing.ref = hit.ref ?? existing.ref;
    }
    if (!existing.fetch && hit.fetch) {
      existing.fetch = hit.fetch;
    }
  }
  return [...merged.values()];
}

/**
 * Text relevance (query tokens found in the name, the folder and the
 * description) plus log-popularity. Hits that share no token with the query
 * are dropped: registries pad results with loosely related skills.
 */
export function rank(hits, query) {
  const tokens = uniqueTokens(query);
  // An exact word counts fully, a shared prefix ("excel" / "excellence") a little over half.
  const match = (token, word) => (word === token ? 1 : token.length >= 4 && word.length >= 4 && (word.startsWith(token) || token.startsWith(word)) ? 0.6 : 0);
  return hits
    .map((hit) => {
      const fields = [
        { weight: 1, words: uniqueTokens(hit.name ?? "") },
        { weight: 0.9, words: uniqueTokens(String(hit.skillId ?? hit.path?.split("/").pop() ?? "").replace(/[-_]/g, " ")) },
        { weight: 0.6, words: uniqueTokens(hit.description ?? "") }
      ];
      let total = 0;
      for (const token of tokens) {
        total += Math.max(0, ...fields.map((field) => field.weight * Math.max(0, ...field.words.map((word) => match(token, word)))));
      }
      const relevance = tokens.length ? total / tokens.length : 0;
      const pop = hit.pop ?? popularityScore(hit);
      return { ...hit, relevance: Number(relevance.toFixed(3)), score: Number((0.8 * relevance + 0.2 * pop).toFixed(3)) };
    })
    .filter((hit) => hit.relevance > 0)
    .sort((a, b) => b.score - a.score || (Number(b.popularity) || 0) - (Number(a.popularity) || 0) || a.id.localeCompare(b.id));
}

// ------------------------------------------------------------------ cache

class OnlineCache {
  constructor(directory, minutes, clock) {
    this.directory = directory;
    this.minutes = minutes;
    this.clock = clock;
  }

  path(key) {
    return join(this.directory, slugify(key, { maxLength: 60 }) + "-" + shortHash(key).slice(0, 10) + ".json");
  }

  read(key) {
    if (this.minutes <= 0) {
      return null;
    }
    try {
      const entry = JSON.parse(readFileSync(this.path(key), "utf8"));
      const age = this.clock().getTime() - new Date(entry.at).getTime();
      return age >= 0 && age < this.minutes * 60000 ? entry : null;
    } catch {
      return null;
    }
  }

  write(key, value) {
    if (this.minutes <= 0) {
      return;
    }
    mkdirSync(this.directory, { recursive: true });
    const path = this.path(key);
    const temporary = path + ".tmp-" + process.pid;
    writeFileSync(temporary, JSON.stringify({ at: this.clock().toISOString(), key, value }) + "\n", "utf8");
    renameSync(temporary, path);
  }

  async remember(key, load) {
    const cached = this.read(key);
    if (cached) {
      return cached.value;
    }
    const value = await load();
    this.write(key, value);
    return value;
  }
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + ".tmp-" + process.pid;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}

function safeId(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64) || "skill";
}

function hasLicense(directory) {
  return ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING"].some((name) => existsSync(join(directory, name)));
}

// ----------------------------------------------------------------- engine

export class OnlineSkills {
  constructor({ hub, policy = null, audit = null, eventBus = null, secrets = null, settings = {}, clock = null, runGit = undefined, runGh = undefined, fetchImpl = undefined } = {}) {
    if (!hub) {
      throw new Error("OnlineSkills needs the skill hub");
    }
    this.hub = hub;
    this.policy = policy;
    this.audit = audit;
    this.eventBus = eventBus;
    this.secrets = secrets;
    this.settings = { ...DEFAULT_ONLINE_SETTINGS, ...settings };
    this.clock = clock ?? hub.clock ?? (() => new Date());
    this.runGit = runGit;
    this.runGh = runGh;
    this.fetchImpl = fetchImpl;
    this.userAgent = "astack-skill-hub/" + VERSION;
  }

  get enabled() {
    return this.settings.enabled !== false;
  }

  get cacheDirectory() {
    return join(this.hub.stateDirectory, "online-cache");
  }

  get temporaryRoot() {
    return join(this.hub.stateDirectory, "online-tmp");
  }

  get indexPath() {
    return join(this.cacheDirectory, "hits.json");
  }

  now() {
    return this.clock().toISOString();
  }

  cache(minutes = this.settings.cacheMinutes) {
    return new OnlineCache(this.cacheDirectory, minutes, this.clock);
  }

  http() {
    const base = { policy: this.policy ?? this.hub.policy, userAgent: this.userAgent, timeoutMs: this.settings.timeoutMs, ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) };
    return {
      get: (url, options = {}) => httpGet(url, { ...base, ...options, headers: { ...(options.headers ?? {}) } }),
      json: (url, options = {}) => httpGetJson(url, { ...base, maxBytes: 4 * 1024 * 1024, ...options, headers: { ...(options.headers ?? {}) } })
    };
  }

  context(limit, { refresh = false } = {}) {
    return {
      http: this.http(),
      limit,
      endpoints: this.settings.endpoints ?? {},
      policy: this.policy ?? this.hub.policy,
      cache: refresh ? null : this.cache(Math.max(this.settings.cacheMinutes, 0)),
      ...(this.runGh ? { runGh: this.runGh } : {}),
      credential: (name) => {
        if (name !== "skillsmp" || !this.settings.skillsmpKey || !this.secrets) {
          return null;
        }
        try {
          return this.secrets.resolve(this.settings.skillsmpKey, { requester: "skill-online", purpose: "skill registry search", scope: "skillsmp.com" });
        } catch {
          return null;
        }
      }
    };
  }

  assertEnabled() {
    if (!this.enabled) {
      throw new OnlineError("Online skill search is turned off (skills.online.enabled: false).", { code: "disabled" });
    }
  }

  // ---------------------------------------------------------------- search
  async search(query, { sources = null, limit = null, refresh = false } = {}) {
    this.assertEnabled();
    const text = String(query ?? "").trim();
    if (!text) {
      throw new OnlineError("A search query is required.", { code: "usage" });
    }
    const size = Math.min(50, Math.max(1, Number(limit ?? this.settings.limit) || this.settings.limit));
    const wanted = (sources === null || sources === "all" || (Array.isArray(sources) && sources.includes("all")))
      ? this.settings.sources
      : (Array.isArray(sources) ? sources : String(sources).split(",")).map((entry) => entry.trim()).filter(Boolean);
    const unknown = wanted.filter((source) => !REGISTRIES[source]);
    if (unknown.length) {
      throw new OnlineError("Unknown online source: " + unknown.join(", ") + ". Use: all, " + SOURCE_ORDER.join(", "), { code: "usage" });
    }
    const cache = this.cache();
    const context = this.context(size, { refresh });
    const outcomes = await Promise.all(wanted.map(async (source) => {
      const key = source + "|" + text.toLowerCase() + "|" + size;
      const cached = refresh ? null : cache.read(key);
      if (cached) {
        return { source, ok: true, cached: true, hits: cached.value.hits, warnings: cached.value.warnings ?? [] };
      }
      try {
        const result = await REGISTRIES[source].search(text, context);
        const value = { hits: result.hits ?? [], warnings: result.warnings ?? [] };
        cache.write(key, value);
        return { source, ok: true, cached: false, ...value };
      } catch (error) {
        return { source, ok: false, cached: false, hits: [], warnings: [], error: String(error?.message ?? error).slice(0, 300), hint: error?.hint ?? null, code: error?.code ?? "error" };
      }
    }));
    const all = outcomes.flatMap((outcome) => outcome.hits);
    const ranked = rank(dedupe(all), text).slice(0, size);
    this.remember(ranked);
    this.audit?.record({
      actor: "skill-hub",
      tool: "skill-online",
      action: "skill-online.search",
      target: text.slice(0, 120),
      riskLevel: "L1",
      result: ranked.length + " results; " + outcomes.map((outcome) => outcome.source + ":" + (outcome.ok ? outcome.hits.length + (outcome.cached ? " cached" : "") : "error")).join(" ")
    });
    return {
      query: text,
      results: ranked.map(publicHit),
      sources: outcomes.map(({ hits, ...rest }) => ({ ...rest, count: hits.length }))
    };
  }

  /** Remember hits (and their alternate ids) so get/show can resolve them later. */
  remember(hits) {
    const index = readJson(this.indexPath, { hits: {} });
    const at = this.now();
    for (const hit of hits) {
      const record = { ...stripInternal(hit), seenAt: at };
      index.hits[hit.id] = record;
      for (const alternate of hit.alternates ?? []) {
        index.hits[alternate] = { ...record, aliasOf: hit.id };
      }
    }
    const entries = Object.entries(index.hits).sort((a, b) => String(b[1].seenAt).localeCompare(String(a[1].seenAt))).slice(0, HIT_INDEX_LIMIT);
    try {
      writeAtomic(this.indexPath, JSON.stringify({ updatedAt: at, hits: Object.fromEntries(entries) }) + "\n");
    } catch {
      // The index is a convenience; a read-only workspace still searches.
    }
  }

  /**
   * `<source>:<id>` → a hit. Ids from a search are looked up in the hit
   * index; skills.sh, ClawHub and GitHub ids are also understood without one.
   * `requireSearched` (MCP) accepts only ids a search returned.
   */
  resolve(input, { requireSearched = false } = {}) {
    const value = String(input ?? "").trim();
    const separator = value.indexOf(":");
    const source = separator > 0 ? value.slice(0, separator) : "";
    const native = separator > 0 ? value.slice(separator + 1) : "";
    if (!REGISTRIES[source] || !native) {
      throw new OnlineError("Use <source>:<id> from `astack skill online search`, e.g. skillssh:owner/repo/skill or github:owner/repo/path (sources: " + SOURCE_ORDER.join(", ") + ").", { code: "usage" });
    }
    const indexed = readJson(this.indexPath, { hits: {} }).hits?.[value];
    if (indexed) {
      return indexed;
    }
    if (requireSearched) {
      throw new OnlineError("Unknown id " + value + ": run an online search first and pass one of its ids.", { code: "not-searched" });
    }
    const parsed = REGISTRIES[source].parseId?.(native) ?? null;
    if (!parsed) {
      throw new OnlineError("Cannot resolve " + value + " without a prior search. Run: astack skill online search \"<query>\" --source " + source, { code: "not-searched" });
    }
    return parsed;
  }

  // ----------------------------------------------------------------- fetch
  gitUrl(repo) {
    return String(this.settings.endpoints?.github_git ?? "https://github.com").replace(/\/+$/, "") + "/" + repo + ".git";
  }

  fetchGit({ repo, path, skillId, ref }, work) {
    const result = fetchGitFolder({
      url: this.gitUrl(repo),
      path,
      skillId,
      ref,
      target: join(work, "repo"),
      policy: this.policy ?? this.hub.policy,
      ...(this.runGit ? { runGit: this.runGit } : {})
    });
    const license = findLicense(result.directory) ?? findLicense(result.root);
    return {
      directory: result.directory,
      repo,
      path: result.path,
      commit: result.commit,
      license,
      originUrl: "https://github.com/" + repo + (result.path ? "/tree/" + (result.commit ?? ref ?? "HEAD") + "/" + result.path : "")
    };
  }

  async fetchHit(hit, work) {
    const spec = hit.fetch;
    if (!spec) {
      throw new OnlineError("This result cannot be fetched (no GitHub source or download is known for " + hit.id + ").", { code: "not-fetchable" });
    }
    if (spec.type === "git") {
      return { ...this.fetchGit(spec, work), version: null, registryVerdict: null };
    }
    if (spec.type === "clawhub") {
      const download = await clawhub.download(spec, this.context(1));
      if (download.type === "git") {
        const fetched = this.fetchGit({ repo: download.repo, path: download.path, skillId: spec.slug, ref: null }, work);
        return { ...fetched, version: download.version, registryVerdict: download.verdict, registryCommit: download.commit, contentHash: download.contentHash };
      }
      const target = join(work, "zip", safeId(spec.slug));
      extractZip(download.buffer, target);
      let directory = target;
      if (!existsSync(join(directory, "SKILL.md"))) {
        const found = discoverSkills(target);
        if (!found.length) {
          throw new OnlineError("The ClawHub archive for " + spec.owner + "/" + spec.slug + " holds no SKILL.md.", { code: "format" });
        }
        directory = found[0].path;
      }
      const meta = readJson(join(directory, "_meta.json"), null);
      const version = download.version ?? (meta?.version ? cleanText(meta.version, 40) : null);
      return {
        directory,
        repo: null,
        path: null,
        commit: null,
        license: findLicense(directory),
        version,
        registryVerdict: download.verdict,
        originUrl: String(this.settings.endpoints?.clawhub ?? "https://clawhub.ai").replace(/\/+$/, "") + "/" + spec.owner + "/skills/" + spec.slug
      };
    }
    throw new OnlineError("Unknown fetch type for " + hit.id, { code: "not-fetchable" });
  }

  workDirectory(prefix) {
    mkdirSync(this.temporaryRoot, { recursive: true });
    return mkdtempSync(join(this.temporaryRoot, prefix + "-"));
  }

  cleanup(work) {
    rmSync(work, { recursive: true, force: true });
    try {
      if (!readdirSync(this.temporaryRoot).length) {
        rmSync(this.temporaryRoot, { recursive: true, force: true });
      }
    } catch {
      // already gone
    }
  }

  originOf(hit, fetched, content) {
    return {
      registry: hit.source,
      id: hit.id,
      key: fetched.repo ? "gh:" + fetched.repo.toLowerCase() + ":" + (fetched.path ?? "") : "clawhub:" + String(hit.fetch?.owner ?? "") + "/" + String(hit.fetch?.slug ?? ""),
      name: hit.name,
      registryUrl: hit.url ?? null,
      url: fetched.originUrl,
      repo: fetched.repo ?? null,
      path: fetched.path ?? null,
      commit: fetched.commit ?? null,
      registryCommit: fetched.registryCommit ?? null,
      version: fetched.version ?? null,
      registryVerdict: fetched.registryVerdict ?? null,
      license: fetched.license?.spdx ?? null,
      contentHash: "sha256:" + createHash("sha256").update(content).digest("hex"),
      fetchedAt: this.now()
    };
  }

  // ------------------------------------------------------------------ show
  /** Preview a candidate: fetch to a temporary folder, scan, read, delete. */
  async show(input, { requireSearched = false } = {}) {
    this.assertEnabled();
    const hit = this.resolve(input, { requireSearched });
    const work = this.workDirectory("show");
    try {
      const fetched = await this.fetchHit(hit, work);
      const content = readFileSync(join(fetched.directory, "SKILL.md"), "utf8");
      const scan = scanSkill(fetched.directory);
      return { hit: publicHit(hit), origin: this.originOf(hit, fetched, content), content, tokens: estimateTokens(content), scan, files: scan.files };
    } finally {
      this.cleanup(work);
    }
  }

  // ------------------------------------------------------------------- get
  /**
   * Fetch a candidate and import it into `skill-packs/<pack>/` through the
   * existing importer. Blocked skills are refused before anything is written.
   */
  async get(input, { pack = null, dryRun = false, requireSearched = false } = {}) {
    this.assertEnabled();
    const packName = String(pack ?? this.settings.pack);
    if (!PACK_NAME.test(packName)) {
      throw new OnlineError("Invalid pack name: " + packName + " (lowercase letters, digits, dot, dash or underscore).", { code: "usage" });
    }
    const destination = join(this.hub.packsDirectory, packName);
    const existingCatalog = readJson(join(destination, "catalog.json"), null);
    const shipped = this.hub.packDirectory(packName);
    if ((existingCatalog && existingCatalog.source?.type !== "online") || (!existingCatalog && shipped)) {
      throw new OnlineError("Pack " + packName + " was not created by online search; choose another pack with --pack.", { code: "usage" });
    }
    const hit = this.resolve(input, { requireSearched });
    const work = this.workDirectory("get");
    try {
      const fetched = await this.fetchHit(hit, work);
      const content = readFileSync(join(fetched.directory, "SKILL.md"), "utf8");
      const origin = this.originOf(hit, fetched, content);
      const scan = scanSkill(fetched.directory);
      const findings = significant(scan.findings);
      if (scan.risk === "blocked") {
        this.audit?.record({
          actor: "skill-hub",
          tool: "skill-online",
          action: "skill-online.refused",
          target: hit.id + " <- " + origin.url,
          riskLevel: "L2",
          result: "blocked by the scanner; nothing imported",
          metadata: { findings: findings.filter((finding) => finding.severity === "critical").slice(0, 5).map((finding) => finding.rule + " " + finding.file + ":" + finding.line) }
        });
        this.eventBus?.emit?.("skill-online.refused", { id: hit.id, risk: scan.risk });
        return { status: "refused", pack: packName, hit: publicHit(hit), origin, scan, reason: "blocked by the security scan (critical finding)" };
      }
      const origins = readJson(join(destination, ORIGINS_FILE), { skills: {} });
      origins.skills ??= {};
      const same = Object.entries(origins.skills).find(([, entry]) => entry?.key === origin.key)?.[0] ?? null;
      const base = safeId(fetched.path ? fetched.path.split("/").pop() : hit.skillId ?? hit.name);
      let id = same ?? base;
      let suffix = 2;
      const taken = new Set((existingCatalog?.skills ?? []).map((skill) => skill.id).filter((skillId) => skillId !== same));
      while (taken.has(id)) {
        id = base + "-" + suffix;
        suffix += 1;
      }
      if (dryRun) {
        return { status: "preview", pack: packName, id: packName + "/" + id, update: Boolean(same), hit: publicHit(hit), origin, scan };
      }
      // Rebuild the pack's source tree: every skill already in the pack plus this one.
      const tree = join(work, "tree");
      mkdirSync(tree, { recursive: true });
      for (const skill of existingCatalog?.skills ?? []) {
        if (skill.id !== id && existsSync(join(destination, skill.id))) {
          cpSync(join(destination, skill.id), join(tree, skill.id), { recursive: true });
        }
      }
      copySkill(fetched.directory, join(tree, id));
      if (!hasLicense(join(tree, id)) && fetched.license?.text) {
        // The repository's licence travels with the skill, verbatim.
        writeFileSync(join(tree, id, "LICENSE"), fetched.license.text, "utf8");
      }
      origins.skills[id] = origin;
      const report = this.hub.import(tree, { pack: packName, tiers: {}, cwd: work });
      const catalogPath = join(destination, "catalog.json");
      const catalog = readJson(catalogPath, { skills: [] });
      catalog.source = { input: "online", type: "online", url: null, commit: null, ref: null, subpath: null, paths: null };
      catalog.online = true;
      const present = new Set((catalog.skills ?? []).map((skill) => skill.id));
      for (const key of Object.keys(origins.skills)) {
        if (!present.has(key)) {
          delete origins.skills[key];
        }
      }
      for (const skill of catalog.skills ?? []) {
        const entry = origins.skills[skill.id];
        if (entry) {
          skill.origin = entry;
          skill.license = skill.license ?? entry.license ?? null;
        }
      }
      writeAtomic(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
      writeAtomic(join(destination, ORIGINS_FILE), JSON.stringify({ pack: packName, updatedAt: this.now(), skills: origins.skills }, null, 2) + "\n");
      const packDocument = join(destination, "PACK.md");
      if (existsSync(packDocument)) {
        writeAtomic(packDocument, readFileSync(packDocument, "utf8").replace(/\s*$/, "\n\n") + renderOrigins(origins.skills));
      }
      this.hub.memo = null;
      const imported = (catalog.skills ?? []).find((skill) => skill.id === id);
      const entry = this.hub.entries({ pack: packName, includeBlocked: true, includeRetired: true }).find((skill) => skill.id === packName + "/" + id);
      const status = entry?.risk === "blocked" ? "blocked-by-override" : entry?.status === "review" ? "flagged" : "imported";
      this.audit?.record({
        actor: "skill-hub",
        tool: "skill-online",
        action: "skill-online.get",
        target: packName + "/" + id + " <- " + origin.url,
        riskLevel: "L2",
        result: status + ", risk " + (imported?.risk ?? scan.risk),
        metadata: { registry: origin.registry, commit: origin.commit, version: origin.version, contentHash: origin.contentHash }
      });
      this.eventBus?.emit?.("skill-online.imported", { pack: packName, id: packName + "/" + id, risk: imported?.risk ?? scan.risk, registry: origin.registry });
      return {
        status,
        pack: packName,
        id: packName + "/" + id,
        update: Boolean(same),
        risk: imported?.risk ?? scan.risk,
        hit: publicHit(hit),
        origin,
        scan,
        path: join(destination, id, "SKILL.md"),
        packSkills: report.catalog.counts.skills
      };
    } finally {
      this.cleanup(work);
    }
  }

  status() {
    return { enabled: this.enabled, sources: this.settings.sources, limit: this.settings.limit, cacheMinutes: this.settings.cacheMinutes, pack: this.settings.pack };
  }
}

function stripInternal(hit) {
  const { pop, key, relevance, ...rest } = hit;
  return rest;
}

function publicHit(hit) {
  return {
    source: hit.source,
    id: hit.id,
    name: hit.name,
    description: hit.description ?? "",
    author: hit.author ?? null,
    repoUrl: hit.repoUrl ?? null,
    path: hit.path ?? null,
    popularity: hit.popularity ?? null,
    popularityKind: hit.popularityKind ?? null,
    url: hit.url ?? null,
    sources: hit.sources ?? [hit.source],
    alternates: hit.alternates ?? [],
    score: hit.score ?? null,
    fetchable: Boolean(hit.fetch)
  };
}

export function renderOrigins(skills) {
  const escape = (value) => String(value ?? "-").replace(/\|/g, "\\|").replace(/`/g, "'");
  const rows = Object.entries(skills ?? {}).sort((a, b) => a[0].localeCompare(b[0]));
  return [
    "## Online origins",
    "",
    "Fetched on demand by `astack skill online get`. Each skill keeps the licence of its own source.",
    "",
    "| Skill | Registry | Source | Commit / version | Licence | Fetched |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map(([id, origin]) => "| " + [id, origin.registry, origin.url, origin.commit ? origin.commit.slice(0, 12) : origin.version ?? "-", origin.license ?? "see upstream", String(origin.fetchedAt ?? "").slice(0, 10)].map(escape).join(" | ") + " |"),
    ""
  ].join("\n");
}

export { OnlineError };
