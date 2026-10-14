import { parseArgs } from "../delivery-engine/cli.mjs";
import { DaemonEngine } from "../daemon-engine/daemon-engine.mjs";
import { applyPlan, describePlan, servicePlan } from "../daemon-engine/service-installer.mjs";

const out = (line) => console.log(line);

function table(rows) {
  for (const row of rows) {
    out(String(row).startsWith("-") ? String(row) : "- " + row);
  }
}

function printRun(t, run, { full = false } = {}) {
  out(t("cli.runner.result", { id: run.id, status: run.status, engine: run.engine ?? run.requestedEngine ?? "-", cost: formatCost(run.cost) }));
  out(String(run.summary ?? ""));
  if (run.status === "awaiting-approval" && run.approvals?.length) {
    out(t("cli.runner.approvalsWaiting", { ids: run.approvals.join(", "), id: run.id }));
  }
  if (run.refusal) {
    out(t("cli.runner.refused", { reason: run.refusal }));
  }
  if (run.command) {
    out(t("cli.runner.command", { command: run.command }));
  }
  if (run.ceilingClamped) {
    out(t("cli.runner.ceilingClamped", { ceiling: run.ceiling }));
  }
  if (full && run.output) {
    out("");
    out(run.output);
  }
}

function formatCost(cost) {
  if (!cost) {
    return "$0";
  }
  return "$" + Number(cost.usd ?? 0).toFixed(4) + (cost.metered === false ? " (unmetered)" : "");
}

/**
 * `astack run "<objective>" [--engine auto|claude|codex|ollama|mock] [--dry-run] [--mission <id>] [--ceiling L1] [--queue]`
 */
export async function runRunCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const { positionals, flags } = parseArgs(tokens);
  const objective = positionals.join(" ").trim() || null;
  const missionId = flags.mission ? String(flags.mission) : null;
  if (!objective && !missionId) {
    throw new Error(t("cli.runner.needsObjective"));
  }
  const request = {
    objective,
    missionId,
    source: flags.source ? String(flags.source) : "cli",
    engine: flags.engine ? String(flags.engine) : null,
    ceiling: flags.ceiling ? String(flags.ceiling) : null,
    model: flags.model ? String(flags.model) : null,
    budgetUsd: flags.budget ? Number(flags.budget) : null,
    dryRun: Boolean(flags.dryRun)
  };
  if (flags.queue) {
    const queued = runtime.runner.enqueue(request);
    out(t("cli.runner.queued", { id: queued.id }));
    return;
  }
  const run = await runtime.runner.execute(request);
  printRun(t, run, { full: true });
  if (["failed", "refused"].includes(run.status)) {
    process.exitCode = 1;
  }
}

/**
 * `astack runner list|show <id>|resume <id>|status|drain|engines|enable-signal-runs`
 */
export async function runRunnerCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "status", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const runner = runtime.runner;

  if (action === "list") {
    const runs = runner.list({ limit: Number(flags.limit ?? 20), status: flags.status ? String(flags.status) : null });
    out(t("cli.runner.listTitle", { count: runs.length }));
    table(runs.map((run) =>
      run.id + " | " + run.status + " | " + (run.engine ?? run.requestedEngine ?? "-") + " | " + run.source + " | " + formatCost(run.cost) + " | " + String(run.objective ?? "").slice(0, 50)
    ));
    return;
  }
  if (action === "show") {
    const run = runner.get(positionals[0]);
    printRun(t, run);
    table([
      "objective: " + run.objective,
      "source: " + run.source,
      "ceiling: " + run.ceiling,
      "mission: " + (run.missionId ?? "-"),
      "created: " + run.createdAt + " | finished: " + (run.finishedAt ?? "-"),
      "turns: " + (run.turns ?? 0) + (run.sessionId ? " | session " + run.sessionId : "")
    ]);
    const output = runner.output(run.id) ?? run.output;
    if (output) {
      out("");
      out(output);
    }
    return;
  }
  if (action === "resume") {
    const run = await runner.resume(positionals[0], { note: flags.note ? String(flags.note) : null });
    printRun(t, run, { full: true });
    return;
  }
  if (action === "drain") {
    const results = await runner.drain({ limit: flags.limit ? Number(flags.limit) : null });
    out(t("cli.runner.drained", { count: results.length }));
    table(results.map((run) => run.id + " " + run.status + " — " + String(run.summary ?? "").slice(0, 120)));
    return;
  }
  if (action === "engines") {
    const engines = await runner.engineStatus({ refresh: true });
    out(t("cli.runner.enginesTitle", { count: engines.length }));
    table(engines.map((engine) => engine.id + " | " + (engine.available ? "available" : "unavailable") + " | " + engine.detail));
    return;
  }
  if (action === "enable-signal-runs") {
    // Inbound signals may only start runs after the owner opts in once.
    runtime.automationPolicy.allowActionPermanently("run-agent");
    runtime.audit.record({ actor: "owner", action: "policy-allow-action", target: "run-agent", riskLevel: "L3", result: "signal rules may enqueue runner work" });
    out(t("cli.runner.signalRunsEnabled"));
    return;
  }
  if (action === "status") {
    const status = runner.status();
    out(t("cli.runner.statusTitle", {
      runs: status.runs,
      queued: status.queued,
      active: status.active.length,
      waiting: status.awaitingApproval.length,
      spent: status.spentTodayUsd.toFixed(4),
      budget: status.dailyBudgetUsd
    }));
    table([
      "max_concurrent: " + status.maxConcurrent,
      "default engine: " + status.defaultEngine,
      ...Object.entries(status.byStatus).map(([state, count]) => state + ": " + count),
      ...status.awaitingApproval.map((id) => "awaiting approval: " + id)
    ]);
    return;
  }
  throw new Error(t("cli.runner.unknownAction", { action }));
}

/**
 * `astack daemon start [--foreground]|stop|status|logs|install-service|uninstall-service|service-status [--dry-run]`
 */
export async function runDaemonCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "status", ...rest] = tokens;
  const { flags } = parseArgs(rest);
  const quiet = Boolean(flags.quiet);
  const daemon = new DaemonEngine({ runtime, log: quiet ? null : out });

  if (action === "start") {
    if (flags.foreground) {
      await daemon.run();
      return;
    }
    const result = await daemon.startBackground();
    out(result.started ? t("cli.daemon.started", { pid: result.pid }) : t("cli.daemon.notStarted", { pid: result.pid ?? "-", reason: result.reason }));
    if (!result.started && result.reason !== "already running") {
      process.exitCode = 1;
    }
    return;
  }
  if (action === "stop") {
    const result = await daemon.stop({ timeoutMs: Number(flags.timeout ?? 20000) });
    out(t("cli.daemon.stopped", { stopped: String(result.stopped), pid: result.pid ?? "-", reason: result.reason ?? "" }));
    return;
  }
  if (action === "status") {
    const status = daemon.status();
    out(status.running
      ? t("cli.daemon.running", { pid: status.pid, since: status.startedAt, heartbeat: status.heartbeatAt ?? "-" })
      : t("cli.daemon.notRunning"));
    table(status.services.map((service) =>
      service.name + " | " + service.state + " | restarts " + service.restarts + (service.lastCrash ? " | last crash " + service.lastCrash.at + ": " + service.lastCrash.error : "")
    ));
    if (!status.running) {
      table(status.planned.map((entry) => entry.directory + ": " + (entry.exists ? "available" : "not installed")));
    }
    out(t("cli.daemon.logPath", { path: status.log }));
    return;
  }
  if (action === "logs") {
    const lines = daemon.logs({ lines: Number(flags.lines ?? 50) });
    if (!lines.length) {
      out(t("cli.daemon.noLogs"));
    }
    for (const line of lines) {
      out(line);
    }
    return;
  }
  if (["install-service", "uninstall-service", "service-status"].includes(action)) {
    const plan = servicePlan({
      platform: flags.platform ? String(flags.platform) : process.platform,
      workspaceRoot: runtime.workspaceRoot,
      coreRoot: runtime.root,
      windowsLauncher: String(runtime.configuration.get("daemon.windows_launcher", "conhost-headless"))
    });
    const kind = action === "install-service" ? "install" : action === "uninstall-service" ? "uninstall" : "status";
    out(t("cli.daemon.servicePlan", { action: kind, platform: plan.platform }));
    for (const line of describePlan(plan, { action: kind })) {
      out(line);
    }
    if (flags.dryRun || (flags.platform && String(flags.platform) !== process.platform)) {
      out(t("cli.daemon.dryRun"));
      return;
    }
    const done = applyPlan(plan, { action: kind, audit: runtime.audit });
    for (const entry of done) {
      out("- " + entry.command + (entry.status ? " (exit " + entry.status + ")" : ""));
      if (entry.output) {
        out(entry.output);
      }
    }
    if (kind !== "status") {
      out(t("cli.daemon.serviceDone", { action: kind, name: plan.name }));
    }
    return;
  }
  throw new Error(t("cli.daemon.unknownAction", { action }));
}
