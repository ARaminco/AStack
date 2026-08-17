import { seedDemo } from "./demo.mjs";
import { itemStatuses } from "./project-engine.mjs";
import { describeCodes, renderDigest, renderStatusReport, sparkline, writeStatusReport } from "./reporting.mjs";

export function parseArgs(tokens) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      if (equals !== -1) {
        flags[token.slice(2, equals)] = token.slice(equals + 1);
      } else if (index + 1 < tokens.length && !tokens[index + 1].startsWith("--")) {
        flags[token.slice(2)] = tokens[index + 1];
        index += 1;
      } else {
        flags[token.slice(2)] = true;
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

function splitList(value) {
  return String(value ?? "").split(";").map((entry) => entry.trim()).filter(Boolean);
}

function parseEstimate(value) {
  const [optimistic, likely, pessimistic] = String(value).split(",").map(Number);
  return { optimistic, likely, pessimistic };
}

export function runProjectCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const engine = runtime.projects;
  const [action, ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const out = (line) => console.log(line);

  if (!action || action === "help") {
    out(t("cli.project.usage"));
    return;
  }
  if (action === "templates") {
    out(t("cli.project.templatesTitle"));
    for (const template of engine.templates()) {
      out("- " + template.id + " (" + template.name + ")");
    }
    return;
  }
  if (action === "init") {
    const project = engine.create({
      name: positionals.join(" "),
      description: flags.describe ?? "",
      targetDate: flags.target ?? null,
      template: flags.template ?? null
    });
    out(t("cli.project.created", { id: project.id }));
    return;
  }
  if (action === "demo") {
    const id = seedDemo(runtime.root, { eventBus: runtime.eventBus });
    out(t("cli.project.demoReady", { id }));
    return;
  }
  if (action === "list") {
    out(t("cli.project.listTitle"));
    for (const project of engine.list()) {
      const status = engine.status(project.id);
      out("- " + t("cli.project.listLine", {
        id: project.id,
        phase: t("delivery.phase." + project.phase),
        rag: t("delivery.rag." + status.health.rag),
        score: status.health.score,
        spi: status.evm?.spi ?? "-",
        p85: status.forecast.dates?.p85 ?? "-"
      }));
    }
    return;
  }

  const id = positionals[0];
  if (!id) {
    throw new Error(t("cli.project.idRequired"));
  }

  if (action === "status") {
    const status = engine.status(id, { asOf: flags["as-of"] ? flags["as-of"] + "T00:00:00.000Z" : undefined });
    out(renderStatusReport(status, t));
    return;
  }
  if (action === "report") {
    const { path } = writeStatusReport(engine, id, t, { asOf: flags["as-of"] ? flags["as-of"] + "T00:00:00.000Z" : undefined });
    out(t("cli.project.reportSaved", { path }));
    return;
  }
  if (action === "board") {
    const board = engine.board(id);
    out(t("cli.project.boardTitle", { id }));
    for (const status of itemStatuses) {
      const items = board.columns[status];
      const limit = board.wipLimits[status];
      const marker = board.violations.some((violation) => violation.status === status) ? " !" : "";
      out(status + (limit !== undefined ? " [" + items.length + "/" + limit + "]" : " [" + items.length + "]") + marker);
      for (const item of items) {
        out("  " + item.id + " " + item.title + (item.blockedReason ? " (" + item.blockedReason + ")" : ""));
      }
    }
    return;
  }
  if (action === "backlog") {
    out(t("cli.project.backlogTitle", { id }));
    for (const item of engine.backlog(id)) {
      out("- " + item.id + " [" + item.moscow + " wsjf=" + item.priority.wsjf + "] " + item.title + " (" + item.points + "pt)");
    }
    return;
  }
  if (action === "add") {
    const wsjf = flags.value || flags.time || flags.risk
      ? { businessValue: Number(flags.value ?? 0), timeCriticality: Number(flags.time ?? 0), riskReduction: Number(flags.risk ?? 0), jobSize: Number(flags.points ?? 1) }
      : null;
    const item = engine.addWorkItem(id, {
      title: positionals.slice(1).join(" "),
      type: flags.type,
      points: flags.points,
      department: flags.dept,
      parent: flags.parent,
      moscow: flags.moscow,
      dependsOn: flags.after ? String(flags.after).split(",").map((entry) => entry.trim()) : [],
      estimate: flags.est ? parseEstimate(flags.est) : null,
      wsjf
    });
    out(t("cli.project.itemAdded", { id: item.id }));
    return;
  }
  if (action === "move" || action === "start" || action === "done" || action === "block" || action === "unblock") {
    const itemId = positionals[1];
    const statusByAction = { start: "in-progress", done: "done", block: "blocked", unblock: "ready" };
    const status = statusByAction[action] ?? positionals[2];
    const item = engine.moveItem(id, itemId, status, {
      force: Boolean(flags.force),
      actualEffort: flags.effort !== undefined ? Number(flags.effort) : null,
      reason: flags.reason ?? null
    });
    out(t("cli.project.itemMoved", { id: item.id, status: item.status }));
    return;
  }
  if (action === "charter") {
    engine.setCharter(id, {
      outcome: flags.outcome ?? "",
      successCriteria: splitList(flags.criteria),
      constraints: splitList(flags.constraints)
    });
    out(t("cli.project.charterSaved"));
    return;
  }
  if (action === "milestone") {
    if (positionals[1] === "done") {
      engine.completeMilestone(id, positionals[2]);
      out(t("cli.project.milestoneDone", { id: positionals[2] }));
    } else {
      const milestone = engine.addMilestone(id, { title: positionals.slice(1).join(" "), due: flags.due });
      out(t("cli.project.milestoneAdded", { id: milestone.id }));
    }
    return;
  }
  if (action === "sprint") {
    if (positionals[1] === "plan") {
      const sprint = engine.planSprint(id, { goal: flags.goal ?? "", days: flags.days, capacity: flags.capacity });
      out(t("cli.project.sprintPlanned", { id: sprint.id, committed: sprint.committed.length, capacity: sprint.capacity }));
    } else if (positionals[1] === "close") {
      const sprint = engine.closeSprint(id, { notes: flags.notes ?? "", actions: splitList(flags.actions) });
      out(t("cli.project.sprintClosed", { id: sprint.id, points: sprint.completedPoints }));
    } else {
      throw new Error(t("cli.project.sprintUsage"));
    }
    return;
  }
  if (action === "risk") {
    if (positionals[1] === "add") {
      const risk = engine.addRisk(id, {
        title: positionals.slice(2).join(" "),
        probability: Number(flags.p),
        impact: Number(flags.i),
        owner: flags.owner ?? null,
        mitigation: flags.mitigation ?? ""
      });
      out(t("cli.project.riskAdded", { id: risk.id }));
    } else if (positionals[1] === "close") {
      engine.closeRisk(id, positionals[2]);
      out(t("cli.project.riskClosed", { id: positionals[2] }));
    } else {
      const status = engine.status(id);
      out(t("cli.project.riskTitle", { id }));
      for (const risk of status.risks) {
        out("- " + t("delivery.report.riskLine", { id: risk.id, title: risk.title, score: risk.score, band: t("delivery.band." + risk.band) }));
      }
    }
    return;
  }
  if (action === "gate") {
    const gate = engine.gate(engine.get(id));
    if (gate.ok) {
      out(t("cli.project.gateOk"));
    } else {
      out(t("cli.project.gateUnmet"));
      for (const line of describeCodes("gate", gate.unmet.map((code) => ({ code, params: {} })), t)) {
        out("- " + line);
      }
    }
    return;
  }
  if (action === "advance") {
    const result = engine.advancePhase(id);
    if (result.advanced) {
      out(t("cli.project.advanced", { phase: t("delivery.phase." + result.phase) }));
    } else {
      out(t("cli.project.notAdvanced"));
      for (const line of describeCodes("gate", result.unmet.map((code) => ({ code, params: {} })), t)) {
        out("- " + line);
      }
    }
    return;
  }
  if (action === "baseline") {
    const project = engine.setBaseline(id, { targetDate: flags.target });
    out(t("cli.project.baselineSet", { points: project.baseline.totalPoints, target: project.baseline.targetDate }));
    return;
  }
  if (action === "critical-path") {
    const path = engine.criticalPath(id);
    out(t("delivery.report.criticalPathLine", { duration: path.duration, path: path.path.join(" -> ") || "-" }));
    for (const task of path.tasks.filter((entry) => entry.critical)) {
      out("- " + task.id + " (" + task.duration + "d, slack 0)");
    }
    return;
  }
  if (action === "forecast") {
    const forecast = engine.forecast(id, { runs: flags.runs ? Number(flags.runs) : undefined, seed: flags.seed ? Number(flags.seed) : undefined });
    if (!forecast.dates) {
      out(t("cli.project.forecastUnavailable"));
      return;
    }
    out(t("delivery.report.forecastLine", { p50: forecast.dates.p50, p85: forecast.dates.p85, p95: forecast.dates.p95, target: forecast.targetDate ?? "-" }));
    out(t("cli.project.throughputLine", { chart: sparkline(forecast.samples), remaining: forecast.remainingPoints }));
    return;
  }
  if (action === "next") {
    out(t("cli.project.nextTitle", { id }));
    const project = engine.get(id);
    for (const line of describeCodes("action", engine.nextBestActions(project), t)) {
      out("- " + line);
    }
    return;
  }
  if (action === "digest") {
    const digest = engine.digest(id, { sinceDays: flags.days ? Number(flags.days) : 1 });
    for (const line of renderDigest(digest, t)) {
      out(line);
    }
    return;
  }
  if (action === "decision") {
    const decision = engine.recordDecision(id, { title: positionals.slice(1).join(" "), choice: flags.choice ?? "", context: flags.context ?? "" });
    out(t("cli.project.decisionSaved", { id: decision.id }));
    return;
  }
  if (action === "scaffold") {
    const intent = runtime.orchestrator.analyzeIntent(String(flags.goal ?? ""));
    const project = engine.scaffold(id, { goal: String(flags.goal ?? ""), departments: intent.departments });
    out(t("cli.project.scaffolded", { count: project.workItems.length, departments: intent.departments.map((department) => department.id).join(", ") }));
    return;
  }
  if (action === "raci") {
    out(t("cli.project.raciTitle", { id }));
    for (const row of engine.raci(id)) {
      out("- " + row.deliverable + " | R: " + row.responsible.join(",") + " | A: " + row.accountable + " | C: " + row.consulted.join(",") + " | I: " + row.informed.join(","));
    }
    return;
  }
  throw new Error(t("cli.project.unknownAction", { action }));
}
