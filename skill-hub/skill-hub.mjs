import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens, uniqueTokens } from "../lib/text.mjs";
import { DEFAULT_TIERS, copySkill, describeSkill, discoverSkills, findLicense } from "./importer.mjs";
import { RISK_LEVELS, countBySeverity, scanSkill, significant } from "./scanner.mjs";
import { remoteHead, resolveSource } from "./sources.mjs";
import { Curator } from "./curator.mjs";

export const PACK_NAME = /^[a-z0-9][a-z0-9._-]{0,47}$/;
export const DEFAULT_PACK_SETTINGS = {
  enabled: true,
  weight: 0.6,
  runtimePenalty: 0.5,
  reviewPenalty: 0.8,
  updateCheck: false,
  updateCheckHours: 24
};

const STATUS_BY_RISK = { low: "auxiliary", medium: "auxiliary", high: "review", blocked: "blocked" };

function safeId(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64) || "skill";
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeAtomic(path, content) {
  mkdirSync(join(path, ".."), { recursive: true });
  const temporary = path + ".tmp-" + process.pid;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}

/**
 * Normalise the optional `skills.packs` section of astack.config.yaml.
 */
export function packSettings(section = {}) {
  const value = section ?? {};
  return {
    enabled: value.enabled === undefined ? DEFAULT_PACK_SETTINGS.enabled : value.enabled !== false && value.enabled !== "false",
    weight: Number.isFinite(Number(value.weight)) && value.weight !== null && value.weight !== "" ? Number(value.weight) : DEFAULT_PACK_SETTINGS.weight,
    runtimePenalty: Number(value.runtime_penalty ?? DEFAULT_PACK_SETTINGS.runtimePenalty),
    reviewPenalty: Number(value.review_penalty ?? DEFAULT_PACK_SETTINGS.reviewPenalty),
    updateCheck: value.update_check === true || value.update_check === "true",
    updateCheckHours: Number(value.update_check_hours ?? DEFAULT_PACK_SETTINGS.updateCheckHours)
  };
}

/**
 * The skill hub: imports third-party skills in the open SKILL.md format into
 * auxiliary packs, scans them, and serves them to the skill catalog below the
 * built-in and learned skills.
 *
 * Imported files are data. Nothing in a pack is executed, imported or required
 * by the hub, the catalog or the selection; a skill with scripts is marked
 * `requiresReview` and stays a document until a human decides otherwise.
 */
export class SkillHub {
  constructor(root, { workspaceRoot = null, clock = null, eventBus = null, audit = null, policy = null, learning = null, settings = {}, packsDirectory = null } = {}) {
    this.root = root;
    this.workspaceRoot = workspaceRoot ?? root;
    this.clock = clock ?? (() => new Date());
    this.eventBus = eventBus;
    this.audit = audit;
    this.policy = policy;
    this.learning = learning;
    this.catalog = null;
    this.settings = { ...DEFAULT_PACK_SETTINGS, ...settings };
    this.packsDirectory = packsDirectory ?? join(this.workspaceRoot, "skill-packs");
    this.shippedDirectory = join(root, "skill-packs");
    this.stateDirectory = join(this.workspaceRoot, ".astack", "skill-hub");
    this.cacheDirectory = join(this.stateDirectory, "cache");
    this.curationPath = join(this.stateDirectory, "curation.json");
    this.curator = new Curator(this);
    this.memo = null;
  }

  now() {
    return this.clock().toISOString();
  }

  get enabled() {
    return this.settings.enabled !== false;
  }

  get weight() {
    return this.settings.weight;
  }

  // ------------------------------------------------------------------ packs
  directories() {
    const list = [this.packsDirectory];
    if (this.shippedDirectory !== this.packsDirectory) {
      list.push(this.shippedDirectory);
    }
    return list.filter((directory) => existsSync(directory));
  }

  packDirectory(pack) {
    for (const directory of this.directories()) {
      const candidate = join(directory, pack);
      if (existsSync(join(candidate, "catalog.json"))) {
        return candidate;
      }
    }
    return null;
  }

  readCatalog(pack) {
    const directory = this.packDirectory(pack);
    if (!directory) {
      throw new Error("Unknown skill pack: " + pack);
    }
    return { directory, ...readJson(join(directory, "catalog.json"), { skills: [] }) };
  }

  listPacks() {
    const seen = new Set();
    const packs = [];
    for (const directory of this.directories()) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || seen.has(entry.name) || !existsSync(join(directory, entry.name, "catalog.json"))) {
          continue;
        }
        seen.add(entry.name);
        const catalog = readJson(join(directory, entry.name, "catalog.json"), { skills: [] });
        const byRisk = {};
        for (const level of RISK_LEVELS) {
          byRisk[level] = 0;
        }
        for (const skill of catalog.skills ?? []) {
          byRisk[skill.risk] = (byRisk[skill.risk] ?? 0) + 1;
        }
        packs.push({
          name: entry.name,
          directory: join(directory, entry.name),
          skills: (catalog.skills ?? []).length,
          source: catalog.source ?? null,
          license: catalog.license ?? null,
          importedAt: catalog.importedAt ?? null,
          byRisk,
          excluded: (catalog.excluded ?? []).length
        });
      }
    }
    return packs.sort((a, b) => a.name.localeCompare(b.name));
  }

  curation() {
    return readJson(this.curationPath, { retired: {}, notes: {} });
  }

  saveCuration(curation) {
    mkdirSync(this.stateDirectory, { recursive: true });
    writeAtomic(this.curationPath, JSON.stringify(curation, null, 2) + "\n");
    this.memo = null;
  }

  /**
   * Every pack skill as a catalog entry. Blocked and retired skills are only
   * returned on explicit request: they are never offered for selection.
   */
  entries({ pack = null, includeBlocked = false, includeRetired = false } = {}) {
    const key = [pack, includeBlocked, includeRetired].join("|");
    const stamp = this.directories().map((directory) => {
      try {
        return readdirSync(directory).map((name) => {
          const path = join(directory, name, "catalog.json");
          return existsSync(path) ? name + ":" + statSync(path).mtimeMs : "";
        }).join(",");
      } catch {
        return "";
      }
    }).join(";") + ";" + (existsSync(this.curationPath) ? statSync(this.curationPath).mtimeMs : 0);
    if (this.memo?.stamp === stamp && this.memo.entries.has(key)) {
      return this.memo.entries.get(key);
    }
    if (this.memo?.stamp !== stamp) {
      this.memo = { stamp, entries: new Map() };
    }
    const retired = this.curation().retired ?? {};
    const result = [];
    for (const summary of this.listPacks()) {
      if (pack && summary.name !== pack) {
        continue;
      }
      const catalog = readJson(join(summary.directory, "catalog.json"), { skills: [] });
      const relativeBase = summary.directory.startsWith(this.workspaceRoot) ? summary.directory.slice(this.workspaceRoot.length + 1) : join("skill-packs", summary.name);
      for (const skill of catalog.skills ?? []) {
        const id = summary.name + "/" + skill.id;
        const status = retired[id] ? "retired" : STATUS_BY_RISK[skill.risk] ?? "review";
        if (!includeBlocked && skill.risk === "blocked") {
          continue;
        }
        if (!includeRetired && status === "retired") {
          continue;
        }
        result.push({
          id,
          name: skill.name,
          nameFa: skill.name,
          source: "pack:" + summary.name,
          pack: summary.name,
          status,
          confidence: 0.5,
          domains: [skill.domain ?? "business"],
          keywords: skill.keywords ?? [],
          tags: skill.tags ?? [],
          description: skill.description ?? "",
          category: skill.category ?? null,
          tier: skill.tier ?? null,
          compat: skill.compat ?? "portable",
          risk: skill.risk,
          findings: skill.findings ?? 0,
          hasScripts: Boolean(skill.hasScripts),
          requiresReview: Boolean(skill.requiresReview),
          auxiliary: true,
          path: (relativeBase.split("\\").join("/")) + "/" + skill.id + "/SKILL.md",
          absolutePath: join(summary.directory, skill.id, "SKILL.md"),
          requiredTools: [],
          riskLevel: "L1"
        });
      }
    }
    this.memo.entries.set(key, result);
    return result;
  }

  /**
   * Rank pack skills for a query. Scores already carry the auxiliary weight,
   * the review penalty and the Hermes-runtime penalty.
   */
  search(query, { pack = null, limit = 10, minScore = 0.2, weighted = true } = {}) {
    const tokens = uniqueTokens(query);
    if (!tokens.length) {
      return [];
    }
    const fields = (skill) => [
      { weight: 1, tokens: uniqueTokens([skill.id.split("/").pop().replace(/[-_]/g, " "), skill.name].join(" ")) },
      { weight: 0.85, tokens: uniqueTokens((skill.tags ?? []).join(" ") + " " + (skill.keywords ?? []).join(" ")) },
      { weight: 0.5, tokens: uniqueTokens((skill.category ?? "").replace(/[-_]/g, " ")) },
      { weight: 0.6, tokens: uniqueTokens(skill.description ?? "") }
    ];
    const hit = (token, entry) => entry === token || (token.length >= 4 && entry.length >= 4 && (entry.startsWith(token) || token.startsWith(entry)));
    return this.entries({ pack })
      .map((skill) => {
        const scored = fields(skill);
        let total = 0;
        for (const token of tokens) {
          total += Math.max(0, ...scored.filter((field) => field.tokens.some((entry) => hit(token, entry))).map((field) => field.weight));
        }
        const coverage = total / tokens.length;
        // Specificity: a focused skill whose own tags carry the query beats a
        // broad one that merely mentions it. Only breaks near-ties.
        const tagTokens = scored[1].tokens;
        const specific = tagTokens.length ? tokens.filter((token) => tagTokens.some((entry) => hit(token, entry))).length / tagTokens.length : 0;
        const named = tokens.some((token) => token.length >= 3 && skill.id.split("/").pop().includes(token)) ? 0.3 : 0;
        const raw = coverage + named + 0.15 * specific;
        const status = skill.status === "review" ? this.settings.reviewPenalty : 1;
        const runtime = skill.compat === "hermes-runtime" ? this.settings.runtimePenalty : 1;
        const factor = weighted ? this.weight * status * runtime : 1;
        return { skill, raw, score: Number((raw * factor).toFixed(3)) };
      })
      .filter((entry) => entry.raw >= 0.4 && entry.score >= minScore * (weighted ? this.weight : 1))
      .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
      .slice(0, limit)
      .map((entry) => ({
        id: entry.skill.id,
        name: entry.skill.name,
        source: entry.skill.source,
        status: entry.skill.status,
        confidence: entry.skill.confidence,
        path: entry.skill.path,
        score: entry.score,
        risk: entry.skill.risk,
        compat: entry.skill.compat,
        tier: entry.skill.tier,
        category: entry.skill.category,
        requiresReview: entry.skill.requiresReview,
        auxiliary: true,
        description: entry.skill.description
      }));
  }

  get(id) {
    const [pack, skillId] = String(id ?? "").split("/");
    const entry = this.entries({ pack, includeBlocked: true, includeRetired: true }).find((skill) => skill.id === pack + "/" + skillId);
    if (!entry) {
      throw new Error("Unknown pack skill: " + id + " (use <pack>/<skill-id>)");
    }
    return entry;
  }

  /**
   * Full SKILL.md plus a fresh scan. Reading a skill is all this does.
   */
  show(id) {
    const entry = this.get(id);
    const content = existsSync(entry.absolutePath) ? readFileSync(entry.absolutePath, "utf8") : "";
    const scan = scanSkill(join(entry.absolutePath, ".."));
    return { ...entry, content, tokens: estimateTokens(content), scan };
  }

  // ----------------------------------------------------------------- import
  /**
   * Import every skill a source contains into `skill-packs/<pack>/`.
   *
   * Steps: resolve the source (clone if remote), discover skill folders, copy
   * them byte for byte into a staging folder (binaries, symlinks and files over
   * 2 MB are excluded and listed), scan the staged copies, write catalog.json,
   * PACK.md, SCAN.md and LICENSE, then swap the staged pack into place. The
   * previous version of the pack is moved to `.astack/skill-hub/trash/`.
   */
  import(source, { pack, dryRun = false, paths = null, tiers = DEFAULT_TIERS, sourceUrl = null, commit = null, cwd = process.cwd(), runGit = undefined } = {}) {
    if (!pack || !PACK_NAME.test(pack)) {
      throw new Error("A pack name is required: lowercase letters, digits, dot, dash or underscore (--pack <name>).");
    }
    const resolved = resolveSource(source, { cacheDirectory: this.cacheDirectory, policy: this.policy, cwd, ...(runGit ? { runGit } : {}) });
    const discovered = discoverSkills(resolved.directory, { paths });
    if (!discovered.length) {
      throw new Error("No SKILL.md found in " + resolved.input);
    }
    const license = findLicense(resolved.root ?? resolved.directory) ?? findLicense(resolved.directory);
    const staging = join(this.stateDirectory, "staging", pack);
    rmSync(staging, { recursive: true, force: true });
    const used = new Set();
    const skills = [];
    const excluded = [];
    for (const found of discovered) {
      const described = describeSkill(found, { tiers, packLicense: license?.spdx ?? null });
      let id = safeId(described.folder);
      if (used.has(id)) {
        id = safeId(described.category + "-" + described.folder);
      }
      let suffix = 2;
      while (used.has(id)) {
        id = safeId(described.folder) + "-" + suffix;
        suffix += 1;
      }
      used.add(id);
      const target = join(staging, id);
      const copy = copySkill(found.path, target, { dryRun });
      for (const entry of copy.excluded) {
        excluded.push({ skill: id, file: entry.file, upstream: found.rel + "/" + entry.file, reason: entry.reason });
      }
      const scan = scanSkill(dryRun ? found.path : target);
      skills.push({
        id,
        name: described.name,
        description: described.description,
        category: described.category,
        subcategory: described.subcategory,
        tier: described.tier,
        tags: described.tags,
        keywords: described.keywords,
        domain: described.domain,
        compat: described.compat,
        compatMarkers: described.compatMarkers,
        risk: scan.risk,
        findings: significant(scan.findings).length,
        findingsBySeverity: countBySeverity(scan.findings),
        hasScripts: scan.hasScripts,
        scripts: scan.scripts.length,
        requiresReview: scan.requiresReview,
        files: copy.copied.length,
        bytes: copy.copied.reduce((sum, file) => sum + file.size, 0),
        upstream: described.upstream,
        license: described.license,
        version: described.version,
        author: described.author,
        platforms: described.platforms,
        related: described.related,
        frontMatter: described.frontMatter,
        scan: dryRun ? scan : undefined
      });
    }
    const catalog = {
      pack,
      format: "agentskills.io SKILL.md",
      importedAt: this.now(),
      source: {
        input: /^[A-Za-z]:[\\/]|^\//.test(resolved.input) ? "local folder" : resolved.input,
        type: resolved.type,
        url: sourceUrl ?? resolved.url ?? null,
        commit: commit ?? resolved.commit ?? null,
        ref: resolved.ref ?? null,
        subpath: resolved.subpath ?? null,
        paths: paths ?? null
      },
      license: license?.spdx ?? null,
      tiers: Object.keys(tiers).length ? tiers : null,
      counts: summarize(skills),
      excluded,
      skills: skills.map(({ scan, ...rest }) => rest)
    };
    const report = { pack, dryRun, discovered: discovered.length, skills, excluded, catalog, directory: join(this.packsDirectory, pack) };
    if (dryRun) {
      return report;
    }
    writeAtomic(join(staging, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
    writeAtomic(join(staging, "PACK.md"), renderPackDocument(catalog));
    writeAtomic(join(staging, "SCAN.md"), renderScanReport(pack, staging, catalog));
    if (license) {
      writeAtomic(join(staging, "LICENSE"), renderLicense(catalog, license));
    }
    const destination = join(this.packsDirectory, pack);
    if (existsSync(destination)) {
      this.trash(destination, pack);
    }
    mkdirSync(this.packsDirectory, { recursive: true });
    renameSync(staging, destination);
    this.memo = null;
    this.audit?.record({
      actor: "skill-hub",
      tool: "skill-hub",
      action: "skill-pack.import",
      target: pack + " <- " + (catalog.source.url ?? catalog.source.input),
      riskLevel: "L2",
      result: skills.length + " skills, " + excluded.length + " files excluded",
      metadata: { commit: catalog.source.commit, counts: catalog.counts }
    });
    this.eventBus?.emit("skill-hub.imported", { pack, skills: skills.length });
    return report;
  }

  trash(directory, pack) {
    const target = join(this.stateDirectory, "trash", pack + "-" + this.now().replace(/[:.]/g, "-"));
    mkdirSync(join(target, ".."), { recursive: true });
    renameSync(directory, target);
    return target;
  }

  /**
   * Re-scan an installed pack, refresh the risk labels in catalog.json and
   * rewrite SCAN.md. Upstream files are not touched.
   */
  scan(pack) {
    const { directory, ...catalog } = this.readCatalog(pack);
    const results = [];
    for (const skill of catalog.skills ?? []) {
      const scan = scanSkill(join(directory, skill.id));
      skill.risk = scan.risk;
      skill.findings = significant(scan.findings).length;
      skill.findingsBySeverity = countBySeverity(scan.findings);
      skill.hasScripts = scan.hasScripts;
      skill.scripts = scan.scripts.length;
      skill.requiresReview = scan.requiresReview;
      results.push({ id: skill.id, ...scan });
    }
    catalog.counts = summarize(catalog.skills ?? []);
    catalog.scannedAt = this.now();
    writeAtomic(join(directory, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
    writeAtomic(join(directory, "SCAN.md"), renderScanReport(pack, directory, catalog, results));
    this.memo = null;
    return { pack, directory, counts: catalog.counts, results };
  }

  /**
   * Remove a pack. The folder is moved to `.astack/skill-hub/trash/`, so the
   * removal can be undone by moving it back.
   */
  remove(pack) {
    const directory = join(this.packsDirectory, pack);
    if (!PACK_NAME.test(pack) || !existsSync(join(directory, "catalog.json"))) {
      throw new Error("Unknown skill pack: " + pack);
    }
    const target = this.trash(directory, pack);
    this.memo = null;
    this.audit?.record({ actor: "skill-hub", tool: "skill-hub", action: "skill-pack.remove", target: pack, riskLevel: "L2", result: "moved to " + target.slice(this.workspaceRoot.length + 1) });
    return { pack, trash: target };
  }

  curate(options = {}) {
    return this.curator.run(options);
  }

  /**
   * Compare each git-sourced pack with its remote head. Check only: this never
   * imports or changes a pack.
   */
  checkUpdates({ runGit = undefined } = {}) {
    const results = [];
    for (const summary of this.listPacks()) {
      const source = summary.source ?? {};
      if (!source.url || !/^https?:\/\//.test(source.url) || !source.commit) {
        results.push({ pack: summary.name, status: "unknown", reason: "no remote source recorded" });
        continue;
      }
      try {
        const head = remoteHead(source.url, { ref: source.ref, policy: this.policy, ...(runGit ? { runGit } : {}) });
        results.push({ pack: summary.name, status: head && head !== source.commit ? "update-available" : "current", current: source.commit, remote: head });
      } catch (error) {
        results.push({ pack: summary.name, status: "error", reason: String(error.message ?? error).slice(0, 200) });
      }
    }
    return { at: this.now(), results };
  }

  status() {
    const packs = this.listPacks();
    return {
      enabled: this.enabled,
      weight: this.weight,
      packs: packs.length,
      skills: packs.reduce((sum, pack) => sum + pack.skills, 0),
      selectable: this.enabled ? this.entries().length : 0
    };
  }
}

export function summarize(skills) {
  const byRisk = {};
  for (const level of RISK_LEVELS) {
    byRisk[level] = 0;
  }
  const byTier = {};
  const byCategory = {};
  const byCompat = {};
  let withScripts = 0;
  for (const skill of skills) {
    byRisk[skill.risk] = (byRisk[skill.risk] ?? 0) + 1;
    byTier[skill.tier ?? "none"] = (byTier[skill.tier ?? "none"] ?? 0) + 1;
    byCategory[skill.category] = (byCategory[skill.category] ?? 0) + 1;
    byCompat[skill.compat] = (byCompat[skill.compat] ?? 0) + 1;
    withScripts += skill.hasScripts ? 1 : 0;
  }
  return { skills: skills.length, byRisk, byTier, byCategory, byCompat, withScripts, requiresReview: skills.filter((skill) => skill.requiresReview).length };
}

function table(rows) {
  return rows.map((row) => "| " + row.join(" | ") + " |").join("\n");
}

function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/`/g, "'");
}

export function renderPackDocument(catalog) {
  const counts = catalog.counts;
  const source = catalog.source;
  const lines = [
    "# Skill pack: " + catalog.pack,
    "",
    "Auxiliary third-party skills in the open SKILL.md format, imported by the AStack skill hub.",
    "They rank below AStack's built-in and learned skills, are treated as data, and nothing in this",
    "folder is ever executed by import or selection. Skills that ship scripts carry `requiresReview`.",
    "",
    "| Field | Value |",
    "| --- | --- |",
    "| Source | " + escapeCell(source.url ?? source.input) + " |",
    "| Commit | " + escapeCell(source.commit ?? "unknown") + " |",
    "| Paths | " + escapeCell((source.paths ?? [source.subpath ?? "/"]).join(", ")) + " |",
    "| Licence | " + escapeCell(catalog.license ?? "see upstream") + (catalog.license ? " (see LICENSE)" : "") + " |",
    "| Imported | " + catalog.importedAt.slice(0, 10) + " |",
    "| Skills | " + counts.skills + " |",
    "| Risk | " + Object.entries(counts.byRisk).map(([level, count]) => level + " " + count).join(", ") + " |",
    "| Tiers | " + Object.entries(counts.byTier).map(([tier, count]) => tier + " " + count).join(", ") + " |",
    "| Compatibility | " + Object.entries(counts.byCompat).map(([compat, count]) => compat + " " + count).join(", ") + " |",
    "| With scripts | " + counts.withScripts + " (requires review: " + counts.requiresReview + ") |",
    "",
    "## Attribution",
    "",
    "The skills in this folder are the work of their upstream authors" + (source.url ? " at " + source.url : "") + ".",
    "Files are copied unchanged; only `catalog.json`, `PACK.md`, `SCAN.md` and the attribution header of",
    "`LICENSE` are generated by AStack.",
    "",
    "## Categories",
    "",
    table([["Category", "Skills"], ["---", "---"], ...Object.entries(counts.byCategory).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([category, count]) => [escapeCell(category), String(count)])]),
    "",
    "## Excluded files",
    "",
    catalog.excluded.length
      ? "Binaries, symbolic links and files over 2 MB are not imported.\n\n" + table([["Upstream path", "Reason"], ["---", "---"], ...catalog.excluded.map((entry) => [escapeCell(entry.upstream), escapeCell(entry.reason)])])
      : "None.",
    "",
    "## Use",
    "",
    "```",
    "astack skill pack search \"<query>\" --pack " + catalog.pack,
    "astack skill pack show " + catalog.pack + "/<skill-id>",
    "astack skill pack scan " + catalog.pack,
    "```",
    ""
  ];
  return lines.join("\n");
}

export function renderScanReport(pack, directory, catalog, results = null) {
  const scans = results ?? (catalog.skills ?? []).map((skill) => ({ id: skill.id, ...scanSkill(join(directory, skill.id)) }));
  const counts = catalog.counts;
  const lines = [
    "# Security scan: " + pack,
    "",
    "Static scan by `skill-hub/scanner.mjs` (patterns only; nothing was executed).",
    "Risk is the worst finding of a skill: low, medium, high (needs review) or blocked (never selectable).",
    "",
    "| Risk | Skills |",
    "| --- | --- |",
    ...Object.entries(counts.byRisk).map(([level, count]) => "| " + level + " | " + count + " |"),
    "",
    "Skills with scripts: " + counts.withScripts + ". Every one of them is marked `requiresReview`; scripts are never run by import or selection.",
    ""
  ];
  const serious = [];
  for (const scan of scans) {
    for (const finding of scan.findings) {
      if (finding.severity === "high" || finding.severity === "critical") {
        serious.push({ skill: scan.id, risk: scan.risk, ...finding });
      }
    }
  }
  const grouped = new Map();
  for (const finding of serious) {
    const key = finding.skill + "|" + finding.file + "|" + finding.rule + "|" + finding.severity;
    const entry = grouped.get(key) ?? { ...finding, lines: [] };
    entry.lines.push(finding.line);
    grouped.set(key, entry);
  }
  lines.push("## High and blocked findings (" + serious.length + ")", "");
  if (!grouped.size) {
    lines.push("None.", "");
  } else {
    lines.push(table([["Skill", "Severity", "Rule", "File:line", "Excerpt"], ["---", "---", "---", "---", "---"],
      ...[...grouped.values()]
        .sort((a, b) => (b.severity === "critical") - (a.severity === "critical") || a.skill.localeCompare(b.skill) || a.file.localeCompare(b.file))
        .map((entry) => [
          escapeCell(entry.skill),
          entry.severity === "critical" ? "critical (blocked)" : "high",
          escapeCell(entry.rule),
          escapeCell(entry.file + ":" + entry.lines.slice(0, 12).join(",") + (entry.lines.length > 12 ? ",… (" + entry.lines.length + " lines)" : "")),
          escapeCell(entry.excerpt.slice(0, 90))
        ])]), "");
  }
  const review = scans.filter((scan) => scan.risk === "high" || scan.risk === "blocked").map((scan) => scan.id + " (" + scan.risk + ")");
  lines.push("## Skills that need review before use", "", review.length ? review.map((entry) => "- " + entry).join("\n") : "None.", "");
  return lines.join("\n");
}

export function renderLicense(catalog, license) {
  return [
    "This folder contains third-party skills imported by AStack's skill hub.",
    "Source: " + (catalog.source.url ?? catalog.source.input),
    "Commit: " + (catalog.source.commit ?? "unknown"),
    "Imported: " + catalog.importedAt.slice(0, 10),
    "The upstream licence (" + (license.spdx ?? "see below") + ") is reproduced verbatim below and applies to every file in this folder",
    "except catalog.json, PACK.md and SCAN.md, which AStack generated.",
    "",
    "----------------------------------------------------------------------",
    "",
    license.text.replace(/\s+$/, ""),
    ""
  ].join("\n");
}
