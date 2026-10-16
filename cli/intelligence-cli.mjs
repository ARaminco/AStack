import { parseArgs } from "../delivery-engine/cli.mjs";
import { DEFAULT_ALWAYS_ON_BUDGET, contextBill } from "../context-engine/context-bill.mjs";
import { mcpTools } from "../interop-engine/mcp-server.mjs";
import { appendSessionMatches } from "../search-engine/hooks.mjs";
import { runSkillCurateCommand, runSkillPackCommand } from "./skill-hub-cli.mjs";
import { runSkillOnlineCommand } from "./skill-online-cli.mjs";

const out = (line) => console.log(line);

function table(rows) {
  for (const row of rows) {
    out(String(row).startsWith("-") ? String(row) : "- " + row);
  }
}

export function runContextCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "map", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const engine = runtime.context;
  const query = positionals.join(" ");

  if (action === "bill") {
    const bill = contextBill({
      projectRoot: runtime.interop?.projectRoot ?? runtime.workspaceRoot ?? runtime.root,
      coreRoot: runtime.root,
      interop: runtime.interop,
      mcpTools,
      budget: Number(flags.budget ?? runtime.configuration?.section?.("context", {})?.always_on_budget ?? DEFAULT_ALWAYS_ON_BUDGET)
    });
    out(t("cli.context.billTitle", { total: bill.total, budget: bill.budget, state: bill.overBudget ? "OVER" : "ok" }));
    for (const item of bill.items) {
      out("- [" + item.group + "] " + item.name + ": " + item.tokens + (item.note ? " (" + item.note + ")" : ""));
    }
    out(bill.note);
    if (bill.overBudget) {
      process.exitCode = 1;
    }
    return;
  }
  if (action === "build") {
    const index = engine.build({ force: Boolean(flags.force) });
    out(t("cli.context.built", {
      files: index.stats.files,
      parsed: index.stats.parsed,
      reused: index.stats.reused,
      symbols: index.stats.symbols,
      ms: index.stats.durationMs
    }));
    return;
  }
  if (action === "map") {
    const map = engine.map({
      query,
      budget: Number(flags.budget ?? runtime.budgets.repoMap ?? 4000),
      domain: flags.domain ? String(flags.domain) : null,
      refresh: flags.refresh ? String(flags.refresh) : "auto"
    });
    if (flags.print) {
      out(map.text);
    } else {
      out(map.text.split("\n").slice(0, Number(flags.lines ?? 60)).join("\n"));
    }
    out("");
    out(t("cli.context.mapSummary", {
      tokens: map.tokens,
      budget: map.budget,
      files: map.renderedCount,
      omitted: map.omittedCount,
      savings: Math.round(map.savings * 100),
      path: map.path ?? "-"
    }));
    return;
  }
  if (action === "search" || action === "query") {
    const result = engine.query(query, { limit: Number(flags.limit ?? 10) });
    out(t("cli.context.searchTitle", { query, scanned: result.scanned }));
    for (const hit of result.hits) {
      out("- " + hit.rel + "  [" + hit.language + "] score=" + hit.score + (hit.signals.length ? "  " + hit.signals.join(" ") : ""));
      if (hit.members.length) {
        out("    " + hit.members.join(" · "));
      }
    }
    appendSessionMatches({ runtime, query, out, t, flags });
    return;
  }
  if (action === "expand") {
    const result = engine.expand(positionals[0]);
    out(result.text);
    return;
  }
  if (action === "related") {
    const subject = query;
    const graphHits = runtime.graph.resolve(subject, { limit: 3 });
    if (graphHits.length) {
      out(t("cli.context.relatedEntity", { name: graphHits[0].node.name }));
      for (const entry of runtime.graph.neighbours(graphHits[0].node.id)) {
        out("- " + entry.node.type + " " + entry.node.name + " (" + entry.edge.type + ", " + entry.direction + ")");
      }
    }
    const hits = engine.query(subject, { limit: 6 });
    out(t("cli.context.relatedFiles"));
    table(hits.hits.map((hit) => hit.rel + " (score " + hit.score + ")"));
    return;
  }
  if (action === "stats") {
    const stats = engine.stats();
    out(t("cli.context.statsTitle"));
    table([
      "built: " + (stats.built ? stats.builtAt : "no"),
      "files: " + stats.files + " | symbols: " + stats.symbols + " | records: " + stats.signals,
      "corpus: " + stats.corpusTokens + " tok",
      "maps rendered: " + stats.maps + " | expansions: " + stats.expands,
      "tokens rendered: " + stats.tokensRendered + " | tokens avoided: " + stats.tokensAvoided,
      "savings ratio: " + Math.round(stats.savingsRatio * 100) + "%"
    ]);
    return;
  }
  if (action === "verify" || action === "refresh") {
    const freshness = engine.verify();
    if (action === "refresh" || !freshness.fresh) {
      const index = engine.build({ force: Boolean(flags.force) });
      out(t("cli.context.refreshed", { files: index.stats.files, parsed: index.stats.parsed }));
      return;
    }
    out(t("cli.context.fresh", { builtAt: freshness.builtAt }));
    return;
  }
  if (action === "pin" || action === "unpin") {
    const pins = action === "pin" ? engine.pin(positionals[0]) : engine.unpin(positionals[0]);
    out(t("cli.context.pins", { count: pins.length }));
    table(pins);
    return;
  }
  throw new Error(t("cli.context.unknownAction", { action }));
}

export function runMemoryCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "list", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const memory = runtime.memory;
  const query = positionals.join(" ");

  if (action === "list" || action === "scopes") {
    out(t("cli.memoryList"));
    table(memory.scopes());
    out(t("cli.memory.facetsTitle"));
    table(memory.facetNames());
    return;
  }
  if (action === "search" || action === "recall") {
    const scope = scopeFlags(flags);
    const hits = memory.recall({
      query,
      facets: flags.facet ? [String(flags.facet)] : undefined,
      domain: flags.domain ? String(flags.domain) : null,
      project: flags.project ? String(flags.project) : null,
      scope: scope.length ? scope : null,
      asOf: flags.asOf ? String(flags.asOf) : null,
      limit: Number(flags.limit ?? 10)
    });
    if (scope.length) {
      out(t("cli.memory.scoped", { scope: scope.join(", ") }));
    }
    out(t("cli.memory.searchTitle", { query, count: hits.length }));
    for (const hit of hits) {
      out("- [" + hit.facet + " " + hit.score + "] " + hit.title + (hit.body ? " — " + hit.body.split("\n")[0].slice(0, 120) : ""));
      out("    id=" + hit.id + " confidence=" + hit.confidence + " at=" + hit.at + (hit.validTo ? " validTo=" + hit.validTo : ""));
    }
    appendSessionMatches({ runtime, query, out, t, flags });
    return;
  }
  if (action === "remember") {
    const record = memory.remember(String(flags.facet ?? "semantic"), {
      title: positionals.join(" "),
      body: flags.body ? String(flags.body) : "",
      domain: flags.domain ? String(flags.domain) : null,
      project: flags.project ? String(flags.project) : null,
      scope: flags.scope ? String(flags.scope) : null,
      entities: [
        ...(flags.case ? [caseScope(flags.case)] : []),
        ...(flags.entities ? String(flags.entities).split(",").map((entry) => entry.trim()).filter(Boolean) : [])
      ],
      importance: flags.importance ? Number(flags.importance) : undefined,
      confidence: flags.confidence ? Number(flags.confidence) : undefined,
      source: flags.source ? String(flags.source) : "cli"
    });
    out(t("cli.memory.remembered", { id: record.id, facet: record.facet }));
    return;
  }
  if (action === "supersede") {
    const result = memory.facets.supersede(positionals[0], {
      title: flags.title ? String(flags.title) : positionals.slice(1).join(" "),
      body: flags.body ? String(flags.body) : "",
      object: flags.object ? String(flags.object) : null
    });
    out(t("cli.memory.superseded", { previous: result.previous.id, replacement: result.replacement.id }));
    return;
  }
  if (action === "forget") {
    const record = memory.forget(positionals[0]);
    out(t("cli.memory.forgotten", { id: record.id }));
    return;
  }
  if (action === "entity") {
    const hits = runtime.graph.resolve(query, { limit: 5 });
    if (!hits.length) {
      out(t("cli.memory.noEntity", { query }));
      return;
    }
    for (const hit of hits) {
      out("- " + hit.node.type + " " + hit.node.name + " (" + hit.node.id + ", match " + hit.score + ")");
      for (const neighbour of runtime.graph.neighbours(hit.node.id, { limit: 6 })) {
        out("    " + neighbour.edge.type + " -> " + neighbour.node.type + " " + neighbour.node.name);
      }
    }
    return;
  }
  if (action === "context") {
    const package_ = runtime.chief.contextRouter.route(query, { budgets: runtime.budgets });
    out(runtime.chief.contextRouter.render(package_));
    return;
  }
  if (action === "import-legacy" || action === "import") {
    const report = runtime.interop.importLegacy();
    const claude = runtime.interop.importClaudeMemory();
    out(t("cli.memory.legacyImported", { ...report, claude: claude.directory ? claude.imported + claude.updated : 0 }));
    return;
  }
  if (action === "consolidate") {
    const report = memory.consolidate();
    out(t("cli.memory.consolidated", report));
    return;
  }
  if (action === "active") {
    const active = memory.active({
      project: flags.project ? String(flags.project) : null,
      caseId: flags.case ? String(flags.case) : null,
      agent: flags.agent ? String(flags.agent) : null,
      role: flags.role ? String(flags.role) : null,
      team: flags.team ? String(flags.team) : null,
      budget: Number(flags.budget ?? 1200)
    });
    out(t("cli.memory.activeTitle", { rendered: active.rendered, blocks: active.blocks, tokens: active.tokens }));
    if (!active.lines.length) {
      out(t("cli.memory.activeEmpty"));
    }
    for (const line of active.lines) {
      out(line);
    }
    return;
  }
  if (action === "block" || action === "blocks") {
    runBlockCommand({ memory, t, tokens: rest });
    return;
  }
  if (action === "reflect") {
    const report = memory.reflect({
      scope: flags.scope ? String(flags.scope) : flags.case ? caseScope(flags.case) : flags.project ? "project:" + flags.project : null,
      dryRun: Boolean(flags.dryRun),
      limit: Number(flags.limit ?? 8)
    });
    out(t("cli.memory.reflected", { written: report.written, unchanged: report.unchanged, skipped: report.skipped, mode: flags.dryRun ? "dry-run" : "applied" }));
    for (const entry of report.scopes) {
      out("- " + entry.scope + ": " + entry.status + (entry.block ? " " + entry.block : "") +
        (entry.added !== undefined ? " (+" + entry.added + " / -" + entry.removed + ", " + entry.records + " lines)" : "") +
        (entry.reason ? " — " + entry.reason : ""));
    }
    return;
  }
  if (action === "stats") {
    const stats = memory.stats();
    out(t("cli.memory.statsTitle", { total: stats.total, tokens: stats.tokens }));
    for (const [facet, entry] of Object.entries(stats.byFacet)) {
      out("- " + facet + ": " + entry.records + " records, avg confidence " + entry.avgConfidence + ", hits " + entry.hits);
    }
    return;
  }
  if (action === "backup") {
    out(t("cli.backupCreated", { path: memory.backup() }));
    return;
  }
  throw new Error(t("cli.memory.unknownAction", { action }));
}

function caseScope(value) {
  const text = String(value).trim();
  return text.startsWith("case:") ? text : "case:" + text;
}

/** --scope a,b plus --case and --project shortcuts, as recall scope ids. */
function scopeFlags(flags) {
  return [
    ...(flags.scope ? String(flags.scope).split(",").map((entry) => entry.trim()).filter(Boolean) : []),
    ...(flags.case ? [caseScope(flags.case)] : [])
  ];
}

/**
 * astack memory block list|show|set|append|replace|remove|history|restore.
 * Free text comes after the block id (or after "--"); --old=/--new= carry the
 * replacement pair. Read-only blocks change only with --force.
 */
function runBlockCommand({ memory, t, tokens }) {
  const [action = "list", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const blocks = memory.blocks;
  // A caller can never pose as the reflect pass or the agent engine: those
  // sources are what decide whether an automatic pass may rewrite a block.
  const requested = flags.source ? String(flags.source) : "cli";
  const source = ["memory-reflect", "agent-engine"].includes(requested) ? "cli:" + requested : requested;
  const force = Boolean(flags.force);
  const [id, ...words] = positionals;
  const text = words.join(" ");
  const report = (result) => {
    out(t("cli.memory.blockSaved", { id: result.block.id, version: result.block.version, size: result.block.value.length, limit: result.block.limit }));
    if (result.evicted?.length) {
      out(t("cli.memory.blockEvicted", { count: result.evicted.length, record: result.archived ?? "-" }));
    }
  };
  if (action === "list") {
    const list = blocks.list({ scope: flags.scope ? String(flags.scope) : null });
    out(t("cli.memory.blockListTitle", { count: list.length }));
    for (const block of list) {
      out("- " + block.id + " v" + block.version + " (" + block.value.length + "/" + block.limit + (block.readOnly ? ", read-only" : "") + (block.managed ? ", managed" : "") + ")" + (block.description ? " — " + block.description : ""));
    }
    return;
  }
  if (!id) {
    throw new Error(t("cli.memory.blockIdRequired"));
  }
  if (action === "show") {
    const block = blocks.get(id);
    if (!block) {
      throw new Error(t("cli.memory.blockUnknown", { id }));
    }
    out("### " + block.id + " v" + block.version + " (" + block.value.length + "/" + block.limit + ", " + block.source + ", " + block.at + ")");
    out(block.value);
    return;
  }
  if (action === "set" || action === "create") {
    report(blocks.set(id, flags.value !== undefined ? String(flags.value) : text, {
      limit: flags.limit ? Number(flags.limit) : null,
      description: flags.description ? String(flags.description) : null,
      readOnly: flags.readOnly !== undefined ? flags.readOnly === true || flags.readOnly === "true" : null,
      source,
      force
    }));
    return;
  }
  if (action === "append") {
    report(blocks.append(id, text, { source, force, limit: flags.limit ? Number(flags.limit) : null }));
    return;
  }
  if (action === "replace") {
    if (flags.old === undefined) {
      throw new Error(t("cli.memory.blockOldRequired"));
    }
    report(blocks.replace(id, String(flags.old), flags.new === undefined || flags.new === true ? "" : String(flags.new), { source, force }));
    return;
  }
  if (action === "remove" || action === "delete") {
    const block = blocks.remove(id, { source, force });
    out(t("cli.memory.blockRemoved", { id: block.id }));
    return;
  }
  if (action === "history") {
    for (const entry of blocks.history(id)) {
      out("- v" + entry.version + " " + entry.at + " " + entry.source + (entry.deleted ? " (removed)" : "") + (entry.restoredFrom ? " (restored from v" + entry.restoredFrom + ")" : "") + " — " + String(entry.value ?? "").split("\n")[0].slice(0, 100));
    }
    return;
  }
  if (action === "restore") {
    report(blocks.restore(id, words[0], { source, force }));
    return;
  }
  throw new Error(t("cli.memory.unknownAction", { action: "block " + action }));
}

export function runGraphCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "stats", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const graph = runtime.graph;

  if (action === "stats") {
    const stats = graph.stats();
    out(t("cli.graph.statsTitle", { nodes: stats.nodes, edges: stats.edges, active: stats.active, superseded: stats.superseded }));
    table(Object.entries(stats.byType).map(([type, count]) => type + ": " + count));
    return;
  }
  if (action === "add" || action === "upsert") {
    const node = graph.upsertNode({
      type: String(flags.type ?? "Person"),
      name: positionals.join(" "),
      aliases: flags.alias ? String(flags.alias).split(",").map((entry) => entry.trim()) : [],
      attributes: flags.attr ? JSON.parse(String(flags.attr)) : {},
      project: flags.project ? String(flags.project) : null,
      source: "cli"
    });
    out(t("cli.graph.upserted", { id: node.id, type: node.type, name: node.name }));
    return;
  }
  if (action === "relate") {
    const edge = graph.relate({
      from: String(flags.from),
      type: String(flags.type ?? "related_to"),
      to: String(flags.to),
      exclusive: Boolean(flags.exclusive),
      attributes: flags.attr ? JSON.parse(String(flags.attr)) : {},
      source: "cli"
    });
    out(t("cli.graph.related", { from: edge.from, type: edge.type, to: edge.to }));
    return;
  }
  if (action === "resolve" || action === "find") {
    const hits = graph.resolve(positionals.join(" "), { limit: Number(flags.limit ?? 5), asOf: flags.asOf ? String(flags.asOf) : null });
    table(hits.map((hit) => hit.node.type + " " + hit.node.name + " (" + hit.node.id + ", " + hit.score + ")"));
    return;
  }
  if (action === "neighbours" || action === "related") {
    const entries = graph.neighbours(positionals[0], { asOf: flags.asOf ? String(flags.asOf) : null });
    table(entries.map((entry) => entry.edge.type + " " + entry.direction + " " + entry.node.type + " " + entry.node.name));
    return;
  }
  if (action === "history") {
    const history = graph.history(positionals[0]);
    out(t("cli.graph.historyTitle", { id: positionals[0] }));
    table(history.node.map((record) => record.updatedAt + " confidence=" + record.confidence));
    table(history.edges.map((edge) => (edge.validFrom ?? "-") + " -> " + (edge.validTo ?? "now") + " " + edge.type + " " + edge.to));
    return;
  }
  if (action === "compact") {
    out(t("cli.graph.compacted", graph.compact()));
    return;
  }
  throw new Error(t("cli.graph.unknownAction", { action }));
}

export function runLearningCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "status", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const learning = runtime.learning;

  if (action === "status" || action === "stats") {
    const status = learning.status();
    out(t("cli.learn.statusTitle", {
      episodes: status.episodes.episodes,
      success: Math.round(status.episodes.successRate * 100),
      skills: status.skills,
      candidates: status.readyCandidates
    }));
    table(Object.entries(status.byStatus).map(([state, count]) => state + ": " + count));
    for (const review of status.review.filter((entry) => entry.verdict !== "healthy")) {
      out("- " + review.id + " → " + review.verdict + " (uses " + review.uses + ", success " + Math.round(review.successRate * 100) + "%)");
    }
    return;
  }
  if (action === "record") {
    const result = learning.record({
      task: positionals.join(" "),
      domain: flags.domain ? String(flags.domain) : null,
      project: flags.project ? String(flags.project) : null,
      steps: flags.steps ? String(flags.steps).split(";").map((step) => ({ action: step.trim() })) : [],
      tools: flags.tools ? String(flags.tools).split(",").map((tool) => tool.trim()) : [],
      outcome: flags.failed ? "failed" : "done",
      durationMs: flags.duration ? Number(flags.duration) : 0,
      notes: flags.note ? String(flags.note) : null
    });
    out(t("cli.learn.recorded", { id: result.episode.id }));
    if (result.forged) {
      out(t("cli.learn.forged", { id: result.forged.id, status: result.forged.status, confidence: result.forged.confidence }));
    }
    return;
  }
  if (action === "episodes") {
    const episodes = learning.experience.list({ domain: flags.domain ? String(flags.domain) : null, limit: Number(flags.limit ?? 20) });
    out(t("cli.learn.episodesTitle", { count: episodes.length }));
    table(episodes.map((episode) => episode.id + " | " + episode.at.slice(0, 16) + " | " + episode.domain + " | " + episode.outcome + " | " + episode.task.slice(0, 70)));
    return;
  }
  if (action === "candidates") {
    const candidates = learning.candidates({ onlyQualifying: Boolean(flags.ready) });
    out(t("cli.learn.candidatesTitle", { count: candidates.length }));
    for (const candidate of candidates) {
      out("- " + candidate.id + " | runs " + candidate.occurrences + " over " + candidate.distinctDays + " days | success " + Math.round(candidate.successRate * 100) + "% | confidence " + candidate.confidence + (candidate.installed ? " | installed" : candidate.qualifies ? " | ready" : ""));
    }
    return;
  }
  if (action === "forge") {
    if (positionals[0]) {
      const skill = learning.forgeById(positionals[0], { status: flags.status ? String(flags.status) : "draft" });
      out(t("cli.learn.forged", { id: skill.id, status: skill.status, confidence: skill.confidence }));
      return;
    }
    const forged = learning.autoForge({ domain: flags.domain ? String(flags.domain) : null });
    out(t("cli.learn.autoForged", { count: forged.length }));
    table(forged.map((skill) => skill.id + " (" + skill.status + ", " + skill.confidence + ")"));
    return;
  }
  if (action === "feedback") {
    const skill = learning.feedback(positionals[0], {
      outcome: flags.outcome ? String(flags.outcome) : flags.failed ? "failed" : "done",
      durationMs: flags.duration ? Number(flags.duration) : 0,
      note: flags.note ? String(flags.note) : null
    });
    out(t("cli.learn.feedback", { id: skill.id, status: skill.status, confidence: skill.confidence, uses: skill.metrics.uses }));
    return;
  }
  if (action === "brief") {
    const brief = learning.brief(positionals.join(" "), { domain: flags.domain ? String(flags.domain) : null });
    table(brief.lines);
    return;
  }
  throw new Error(t("cli.learn.unknownAction", { action }));
}

export function runSkillCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "list", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const catalog = runtime.skills;

  if (action === "list") {
    const skills = catalog.list({
      status: flags.status ? String(flags.status) : null,
      domain: flags.domain ? String(flags.domain) : null,
      source: flags.source ? String(flags.source) : null
    });
    out(t("cli.skill.listTitle", { count: skills.length }));
    table(skills.map((skill) => skill.id + " | " + skill.source + " | " + (skill.status ?? "-") + " | conf " + (skill.confidence ?? "-") + " | " + (skill.domains ?? []).join(",")));
    return;
  }
  if (action === "catalog") {
    const result = catalog.catalog({ budget: Number(flags.budget ?? 600), includePacks: Boolean(flags.packs) });
    table(result.lines);
    out(t("cli.skill.catalogSummary", { listed: result.listed, total: result.total, tokens: result.tokens }));
    return;
  }
  if (action === "search") {
    const hits = catalog.search(positionals.join(" "), { limit: Number(flags.limit ?? 5), includePacks: Boolean(flags.packs) });
    table(hits.map((hit) => hit.id + " (" + hit.source + ", " + hit.status + ", score " + hit.score + ") " + hit.path));
    return;
  }
  if (action === "show") {
    const skill = catalog.show(positionals[0]);
    out(t("cli.skill.showTitle", { id: skill.id, source: skill.source, status: skill.status, tokens: skill.tokens }));
    out(skill.content);
    return;
  }
  if (action === "test") {
    const result = catalog.test(positionals[0]);
    out(t("cli.skill.testTitle", { id: result.id, ready: result.ready ? "ok" : "problems" }));
    table(result.problems.length ? result.problems : ["no problems found"]);
    return;
  }
  if (action === "history") {
    const history = catalog.history(positionals[0]);
    out(t("cli.skill.historyTitle", { id: history.id, current: history.current ?? "-" }));
    table(history.versions.map((version) => "v" + version.version + " | " + version.status + " | conf " + version.confidence + " | uses " + version.uses));
    return;
  }
  if (action === "promote") {
    const skill = catalog.promote(positionals[0], String(flags.status ?? positionals[1] ?? "active"));
    out(t("cli.skill.promoted", { id: skill.id, status: skill.status }));
    return;
  }
  if (action === "rollback") {
    const skill = catalog.rollback(positionals[0], Number(positionals[1] ?? flags.version));
    out(t("cli.skill.rolledBack", { id: skill.id, version: skill.version }));
    return;
  }
  if (action === "stats") {
    const stats = catalog.stats();
    out(t("cli.skill.statsTitle", { skills: stats.skills, tokens: stats.catalogTokens }));
    table(Object.entries(stats.byStatus).map(([status, count]) => status + ": " + count));
    table(Object.entries(stats.bySource).map(([source, count]) => source + ": " + count));
    return;
  }
  if (action === "pack" || action === "packs") {
    runSkillPackCommand({ runtime, i18n, tokens: rest });
    return;
  }
  if (action === "curate") {
    runSkillCurateCommand({ runtime, i18n, tokens: rest });
    return;
  }
  if (action === "online") {
    return runSkillOnlineCommand({ runtime, i18n, tokens: rest });
  }
  throw new Error(t("cli.skill.unknownAction", { action }));
}
