import { parseArgs } from "../delivery-engine/cli.mjs";

const out = (line) => console.log(line);
const ACTIONS = new Set(["reindex", "index", "status", "owner-profile", "query"]);

function list(value) {
  if (value === undefined || value === null || value === true) {
    return null;
  }
  return String(value).split(",").map((entry) => entry.trim()).filter(Boolean);
}

function semanticFlag(value) {
  if (value === undefined || value === true) {
    return null;
  }
  const mode = String(value).toLowerCase();
  if (!["on", "off", "auto"].includes(mode)) {
    throw new Error("--semantic takes on, off or auto");
  }
  return mode;
}

/**
 * astack search "<query>" [--source x,y] [--k 10] [--semantic on|off|auto] [--as-of DATE] [--include-superseded] [--budget N] [--json]
 * astack search reindex [--source x] [--force] [--semantic off] [--sessions-root PATH,...]
 * astack search status [--json]
 * astack search owner-profile [--budget N] [--summarise] [--json]
 */
export async function runSearchCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const search = runtime.search;
  const first = tokens[0];
  const action = ACTIONS.has(first) ? first : "query";
  const { positionals, flags } = parseArgs(ACTIONS.has(first) ? tokens.slice(1) : tokens);

  if (action === "reindex" || action === "index") {
    const report = await search.index({
      sources: list(flags.source ?? flags.sources),
      force: Boolean(flags.force),
      semantic: semanticFlag(flags.semantic),
      sessionRoots: list(flags.sessionsRoot) ?? [],
      embedLimit: flags.embedLimit ? Number(flags.embedLimit) : null
    });
    if (flags.json) {
      out(JSON.stringify(report, null, 2));
      return;
    }
    if (report.fallback) {
      out(t("cli.search.fallback", { reason: report.fallback }));
    }
    out(t("cli.search.reindexed", { ms: report.durationMs, backend: report.backend }));
    for (const [id, entry] of Object.entries(report.sources)) {
      out("- " + id + ": " + t("cli.search.sourceLine", entry) + (entry.errors.length ? " ! " + entry.errors.slice(0, 3).join("; ") : ""));
    }
    out(report.semantic?.used
      ? t("cli.search.embedded", { count: report.embedded, model: report.semantic.model })
      : t("cli.search.semanticOff", { reason: report.semantic?.reason ?? "-" }));
    return;
  }

  if (action === "status") {
    const status = search.status();
    if (flags.json) {
      out(JSON.stringify(status, null, 2));
      return;
    }
    out(t("cli.search.statusTitle", { backend: status.backend, path: status.path }));
    if (status.fallback) {
      out(t("cli.search.fallback", { reason: status.fallback }));
    }
    if (!status.exists) {
      out(t("cli.search.notBuilt"));
      return;
    }
    out("- " + t("cli.search.statusLine", { docs: status.docs, kb: Math.round(status.bytes / 1024), at: status.lastIndexedAt ?? "-" }));
    for (const [id, entry] of Object.entries(status.bySource)) {
      out("- " + id + ": " + entry.docs + " docs, " + entry.units + " units, " + entry.vectors + " vectors");
    }
    out("- semantic: " + status.semantic.mode + " (" + status.semantic.model + ")" + (status.models.length ? " · " + status.models.map((model) => model.model + " " + model.count + "×" + model.dim).join(", ") : ""));
    return;
  }

  if (action === "owner-profile") {
    const profile = await search.ownerProfile({
      budget: Number(flags.budget ?? 900),
      runner: runtime.runner ?? null,
      summarise: Boolean(flags.summarise ?? flags.summarize)
    });
    if (flags.json) {
      out(JSON.stringify(profile, null, 2));
      return;
    }
    out(profile.text.trimEnd());
    if (profile.summaryError) {
      out(t("cli.search.summaryUnavailable", { reason: profile.summaryError }));
    }
    out(t("cli.search.profileSaved", { path: profile.path ?? "-", tokens: profile.tokens }));
    return;
  }

  const query = positionals.join(" ").trim();
  if (!query) {
    throw new Error(t("cli.search.usage"));
  }
  const result = await search.query(query, {
    sources: list(flags.source ?? flags.sources),
    k: flags.k ? Number(flags.k) : null,
    semantic: semanticFlag(flags.semantic),
    asOf: flags.asOf ? String(flags.asOf) : null,
    includeSuperseded: Boolean(flags.includeSuperseded),
    budget: flags.budget ? Number(flags.budget) : null
  });
  if (flags.json) {
    out(JSON.stringify(result, null, 2));
    return;
  }
  if (result.fallback) {
    out(t("cli.search.fallback", { reason: result.fallback }));
  }
  if (!result.indexed) {
    out(t("cli.search.notBuilt"));
    return;
  }
  out(t("cli.search.resultsTitle", {
    query,
    count: result.results.length,
    ms: result.tookMs,
    mode: result.semantic.used ? "hybrid" : "lexical"
  }));
  for (const hit of result.results) {
    out("- [" + hit.source + (hit.kind ? ":" + hit.kind : "") + " " + hit.score + "] " + hit.title);
    out("    " + [hit.path, hit.date ? hit.date.slice(0, 10) : null].filter(Boolean).join(" · "));
    out("    " + hit.snippet);
  }
  if (result.omitted) {
    out(t("cli.search.omitted", { omitted: result.omitted, budget: result.budget }));
  }
  if (!result.semantic.used && result.semantic.reason && result.semantic.mode !== "off") {
    out(t("cli.search.semanticOff", { reason: result.semantic.reason }));
  }
}
