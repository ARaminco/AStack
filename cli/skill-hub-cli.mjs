import { parseArgs } from "../delivery-engine/cli.mjs";
import { significant } from "../skill-hub/scanner.mjs";

const out = (line) => console.log(line);

function table(rows) {
  for (const row of rows) {
    out(String(row).startsWith("-") ? String(row) : "- " + row);
  }
}

function truthy(value) {
  return value !== undefined && value !== false && value !== "false";
}

function hubOf(runtime, t) {
  if (!runtime.skillHub) {
    throw new Error(t("cli.skillHub.unavailable"));
  }
  return runtime.skillHub;
}

/**
 * `astack skill pack <list|search|show|import|scan|remove|updates>`
 */
export function runSkillPackCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "list", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const hub = hubOf(runtime, t);

  if (action === "list") {
    const packs = hub.listPacks();
    out(t("cli.skillHub.listTitle", { count: packs.length, state: hub.enabled ? t("cli.skillHub.enabled") : t("cli.skillHub.disabled") }));
    table(packs.map((pack) => pack.name + " | " + pack.skills + " | " + Object.entries(pack.byRisk).map(([level, count]) => level + ":" + count).join(" ") + " | " + (pack.license ?? "-") + " | " + (pack.source?.url ?? pack.source?.input ?? "-") + (pack.source?.commit ? "@" + pack.source.commit.slice(0, 12) : "")));
    return;
  }
  if (action === "search") {
    const query = positionals.join(" ");
    const hits = hub.search(query, { pack: flags.pack ? String(flags.pack) : null, limit: Number(flags.limit ?? 8), weighted: !truthy(flags.raw) });
    out(t("cli.skillHub.searchTitle", { query, count: hits.length }));
    table(hits.map((hit) => hit.id + " (" + hit.status + ", risk " + hit.risk + (hit.compat === "hermes-runtime" ? ", hermes-runtime" : "") + ", score " + hit.score + ") " + hit.description.slice(0, 90)));
    return;
  }
  if (action === "show") {
    const skill = hub.show(positionals[0]);
    const findings = significant(skill.scan.findings);
    out(t("cli.skillHub.showTitle", { id: skill.id, risk: skill.scan.risk, findings: findings.length, scripts: skill.scan.scripts.length, tokens: skill.tokens }));
    if (skill.scan.requiresReview) {
      out(t("cli.skillHub.requiresReview"));
    }
    table(findings.slice(0, Number(flags.findings ?? 12)).map((finding) => "[" + finding.severity + "] " + finding.rule + " " + finding.file + ":" + finding.line + " " + finding.excerpt.slice(0, 90)));
    out(t("cli.skillHub.dataNotice"));
    out("");
    out(skill.content);
    return;
  }
  if (action === "import") {
    const source = positionals[0];
    const report = hub.import(source, {
      pack: flags.pack ? String(flags.pack) : null,
      dryRun: truthy(flags.dryRun),
      paths: flags.path ? String(flags.path).split(",").map((entry) => entry.trim()).filter(Boolean) : null,
      sourceUrl: flags.sourceUrl ? String(flags.sourceUrl) : null,
      commit: flags.commit ? String(flags.commit) : null
    });
    const counts = report.catalog.counts;
    out(t(report.dryRun ? "cli.skillHub.importPreview" : "cli.skillHub.imported", {
      pack: report.pack,
      skills: counts.skills,
      excluded: report.excluded.length,
      risk: Object.entries(counts.byRisk).map(([level, count]) => level + ":" + count).join(" "),
      review: counts.requiresReview
    }));
    if (report.dryRun) {
      table(report.skills.slice(0, Number(flags.limit ?? 40)).map((skill) => skill.id + " | " + (skill.tier ?? "-") + " | " + skill.category + " | risk " + skill.risk + (skill.hasScripts ? " | scripts" : "") + (skill.compat === "hermes-runtime" ? " | hermes-runtime" : "")));
    }
    table(report.excluded.map((entry) => t("cli.skillHub.excludedLine", { file: entry.upstream, reason: entry.reason })));
    return;
  }
  if (action === "scan") {
    const result = hub.scan(positionals[0]);
    out(t("cli.skillHub.scanned", { pack: result.pack, risk: Object.entries(result.counts.byRisk).map(([level, count]) => level + ":" + count).join(" "), review: result.counts.requiresReview }));
    table(result.results.filter((entry) => entry.risk === "high" || entry.risk === "blocked").map((entry) => entry.id + " → " + entry.risk));
    return;
  }
  if (action === "remove") {
    const result = hub.remove(positionals[0]);
    out(t("cli.skillHub.removed", { pack: result.pack, path: result.trash }));
    return;
  }
  if (action === "updates") {
    const result = hub.checkUpdates();
    out(t("cli.skillHub.updatesTitle"));
    table(result.results.map((entry) => entry.pack + " | " + entry.status + (entry.remote ? " | " + entry.remote.slice(0, 12) : "") + (entry.reason ? " | " + entry.reason : "")));
    return;
  }
  throw new Error(t("cli.skillHub.unknownAction", { action }));
}

/**
 * `astack skill curate [--apply] [--source builtin|learned|pack] [--limit n]`
 */
export function runSkillCurateCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const { flags } = parseArgs(tokens);
  const hub = hubOf(runtime, t);
  const apply = truthy(flags.apply);
  const report = hub.curate({ apply, source: flags.source ? String(flags.source) : null });
  out(t(apply ? "cli.skillHub.curateApplied" : "cli.skillHub.curateTitle", report.summary));
  const shown = truthy(flags.all) ? report.skills : report.skills.filter((entry) => entry.recommendation !== "keep").concat(report.skills.filter((entry) => entry.recommendation === "keep").slice(0, 10));
  table(shown.slice(0, Number(flags.limit ?? 60)).map((entry) =>
    entry.recommendation + " | " + entry.id + " | " + entry.source + " | uses " + entry.uses +
    " | success " + (entry.successRate === null ? "-" : Math.round(entry.successRate * 100) + "%") +
    " | last " + (entry.lastUsed ? String(entry.lastUsed).slice(0, 10) : "-") +
    (entry.duplicates.length ? " | ~" + entry.duplicates[0].id + " (" + entry.duplicates[0].similarity + ")" : "") +
    " | " + entry.reasons.join("; ")));
  if (apply) {
    table(report.applied.map((entry) => entry.id + " → " + entry.action));
  } else {
    out(t("cli.skillHub.curateHint"));
  }
}
