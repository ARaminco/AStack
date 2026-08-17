import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { burndown } from "./metrics.mjs";

const ticks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function sparkline(values) {
  const numbers = values.map(Number);
  if (!numbers.length) {
    return "";
  }
  const max = Math.max(...numbers);
  const min = Math.min(...numbers);
  const range = max - min || 1;
  return numbers.map((value) => ticks[Math.min(ticks.length - 1, Math.floor(((value - min) / range) * (ticks.length - 1)))]).join("");
}

export function describeCodes(prefix, entries, t) {
  return entries.map((entry) => {
    const params = { ...(entry.params ?? entry) };
    if (params.band) {
      params.band = t("delivery.band." + params.band);
    }
    return t("delivery." + prefix + "." + entry.code, params);
  });
}

export function renderStatusReport(status, t) {
  const { project, health, evm, forecast, risks, nextActions, criticalPath, activeSprint, velocity } = status;
  const lines = [];
  lines.push("# " + t("delivery.report.title", { name: project.name }));
  lines.push("");
  lines.push(t("delivery.report.generatedAt", { date: project.updatedAt?.slice(0, 10) ?? "" }));
  lines.push("");
  lines.push("## " + t("delivery.report.summary"));
  lines.push(t("delivery.report.phaseLine", { phase: t("delivery.phase." + project.phase) }));
  lines.push(t("delivery.report.healthLine", { score: health.score, rag: t("delivery.rag." + health.rag) }));
  for (const reason of describeCodes("reason", health.reasons, t)) {
    lines.push("- " + reason);
  }
  lines.push("");
  if (evm) {
    lines.push("## " + t("delivery.report.evm"));
    lines.push("| " + ["BAC", "PV", "EV", "AC", "SPI", "CPI", "EAC", "VAC", "TCPI"].join(" | ") + " |");
    lines.push("|" + " --- |".repeat(9));
    lines.push("| " + [evm.bac, evm.pv, evm.ev, evm.ac, evm.spi ?? "-", evm.cpi ?? "-", evm.eac ?? "-", evm.vac ?? "-", evm.tcpi ?? "-"].join(" | ") + " |");
    lines.push("");
  }
  if (activeSprint) {
    lines.push("## " + t("delivery.report.sprint"));
    lines.push(t("delivery.report.sprintLine", { id: activeSprint.id, goal: activeSprint.goal, end: activeSprint.end.slice(0, 10) }));
    const burn = burndown(activeSprint, project.workItems);
    lines.push(t("delivery.report.burndownLine", { chart: sparkline(burn.series.map((point) => point.remaining)), scope: burn.scope }));
    lines.push("");
  }
  if (velocity.average !== null) {
    lines.push(t("delivery.report.velocityLine", { average: velocity.average, chart: sparkline(velocity.samples) }));
    lines.push("");
  }
  if (forecast?.dates) {
    lines.push("## " + t("delivery.report.forecast"));
    lines.push(t("delivery.report.forecastLine", { p50: forecast.dates.p50, p85: forecast.dates.p85, p95: forecast.dates.p95, target: project.targetDate ?? "-" }));
    lines.push("");
  }
  if (criticalPath.path.length) {
    lines.push("## " + t("delivery.report.criticalPath"));
    lines.push(t("delivery.report.criticalPathLine", { duration: criticalPath.duration, path: criticalPath.path.join(" -> ") }));
    lines.push("");
  }
  if (risks.length) {
    lines.push("## " + t("delivery.report.risks"));
    for (const risk of risks.slice(0, 5)) {
      lines.push("- " + t("delivery.report.riskLine", { id: risk.id, title: risk.title, score: risk.score, band: t("delivery.band." + risk.band) }));
    }
    lines.push("");
  }
  lines.push("## " + t("delivery.report.milestones"));
  for (const milestone of project.milestones) {
    lines.push("- " + t("delivery.report.milestoneLine", { id: milestone.id, title: milestone.title, due: milestone.due, status: t("delivery.milestone." + milestone.status) }));
  }
  lines.push("");
  if (nextActions.length) {
    lines.push("## " + t("delivery.report.nextActions"));
    for (const action of describeCodes("action", nextActions, t)) {
      lines.push("- " + action);
    }
  }
  return lines.join("\n") + "\n";
}

export function writeStatusReport(engine, id, t, { asOf } = {}) {
  const status = engine.status(id, { asOf });
  const content = renderStatusReport(status, t);
  const dir = join(engine.directory, id, "reports");
  mkdirSync(dir, { recursive: true });
  const stamp = (asOf ?? engine.now()).slice(0, 10);
  const path = join(dir, "status-" + stamp + ".md");
  writeFileSync(path, content, "utf8");
  return { path, content, status };
}

export function renderDigest(digest, t) {
  const lines = [t("delivery.digest.title", { since: digest.since.slice(0, 10) })];
  if (!digest.events.length) {
    lines.push("- " + t("delivery.digest.quiet"));
  }
  for (const event of digest.events) {
    const label = event.title ? event.type + " " + (event.itemId ?? "") + " (" + event.title + ")" : event.type;
    lines.push("- " + event.at.slice(0, 16).replace("T", " ") + " " + label);
  }
  for (const blocked of digest.blocked) {
    lines.push("- " + t("delivery.digest.blockedLine", { id: blocked.id, title: blocked.title, reason: blocked.reason ?? "" }));
  }
  return lines;
}
