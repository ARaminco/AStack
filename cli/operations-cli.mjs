import { parseArgs } from "../delivery-engine/cli.mjs";
import { SchedulerDaemon } from "../scheduler-engine/daemon.mjs";
import { SignalServer } from "../signal-engine/http-server.mjs";
import { describeKind } from "../scheduler-engine/monitors.mjs";
import { describeSchedule } from "../scheduler-engine/cron.mjs";

const out = (line) => console.log(line);

function table(rows) {
  for (const row of rows) {
    out(String(row).startsWith("-") ? String(row) : "- " + row);
  }
}

function parseSchedule(flags) {
  if (flags.every) {
    return { every: String(flags.every) };
  }
  if (flags.cron) {
    return { cron: String(flags.cron) };
  }
  if (flags.at) {
    return { at: String(flags.at) };
  }
  throw new Error("A job needs --every <30m>, --cron \"*/10 * * * *\" or --at <iso-time>");
}

export async function runScheduleCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "list", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const scheduler = runtime.scheduler;

  if (action === "list") {
    const jobs = scheduler.list({ kind: flags.kind ? String(flags.kind) : null });
    out(t("cli.schedule.listTitle", { count: jobs.length }));
    table(jobs.map((job) =>
      job.id + " | " + job.kind + " | " + describeSchedule(job.schedule) + " | " + (job.enabled ? "enabled" : "disabled") +
      " | next " + (job.state.next ?? "-") + " | last " + (job.state.lastStatus ?? "-")
    ));
    return;
  }
  if (action === "kinds") {
    table(scheduler.kinds().map((kind) => kind + " — " + describeKind(kind)));
    return;
  }
  if (action === "add") {
    const job = scheduler.create({
      name: positionals.join(" ") || String(flags.name ?? ""),
      id: flags.id ? String(flags.id) : null,
      kind: String(flags.kind ?? "http-check"),
      schedule: parseSchedule(flags),
      payload: flags.payload ? JSON.parse(String(flags.payload)) : buildPayload(flags),
      policy: {
        timeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
        retries: flags.retries ? Number(flags.retries) : undefined,
        catchUp: Boolean(flags.catchUp)
      },
      alert: {
        failuresBefore: flags.alertAfter ? Number(flags.alertAfter) : undefined,
        escalateToAgent: flags.escalate ? String(flags.escalate) : null
      },
      domain: flags.domain ? String(flags.domain) : null,
      project: flags.project ? String(flags.project) : null,
      tags: flags.tags ? String(flags.tags).split(",").map((tag) => tag.trim()) : []
    });
    out(t("cli.schedule.created", { id: job.id, kind: job.kind, next: job.state.next }));
    return;
  }
  if (action === "show") {
    const job = scheduler.read(positionals[0]);
    out(t("cli.schedule.showTitle", { id: job.id, kind: job.kind, schedule: describeSchedule(job.schedule) }));
    table([
      "enabled: " + job.enabled,
      "next: " + (job.state.next ?? "-"),
      "runs: " + job.state.runs + " (ok " + job.state.successes + ", failed " + job.state.failures + ")",
      "consecutive failures: " + job.state.consecutiveFailures,
      "incident: " + (job.state.incident ?? "none"),
      "payload: " + JSON.stringify(job.payload)
    ]);
    table(scheduler.runLog(job.id, { limit: 5 }).map((run) => run.startedAt + " " + run.status + " — " + run.summary));
    return;
  }
  if (action === "run") {
    const { run } = await scheduler.runJob(positionals[0], { manual: true });
    out(t("cli.schedule.ran", { id: positionals[0], status: run.status, summary: run.summary }));
    return;
  }
  if (action === "tick") {
    const results = await scheduler.tick({ limit: Number(flags.limit ?? 25) });
    if (!results.length) {
      out(t("cli.schedule.nothingDue"));
      return;
    }
    out(t("cli.schedule.ticked", { count: results.length }));
    table(results.map((result) => result.id + " " + result.status + " — " + result.summary));
    return;
  }
  if (action === "watch") {
    const daemon = new SchedulerDaemon(scheduler, { interval: String(flags.interval ?? "60s"), root: runtime.workspaceRoot, log: out });
    await daemon.start({ once: Boolean(flags.once) });
    return;
  }
  if (action === "stop") {
    const daemon = new SchedulerDaemon(scheduler, { root: runtime.workspaceRoot, log: out });
    const result = daemon.stop();
    out(t("cli.schedule.stopped", { stopped: String(result.stopped), pid: result.pid ?? "-", reason: result.reason ?? "" }));
    return;
  }
  if (action === "status") {
    const status = scheduler.status();
    const daemon = new SchedulerDaemon(scheduler, { root: runtime.workspaceRoot, log: () => {} }).status();
    out(t("cli.schedule.statusTitle", { jobs: status.jobs, due: status.due, failing: status.failing, incidents: status.incidents }));
    table([
      "daemon: " + (daemon.running ? "running (pid " + daemon.pid + ")" : "stopped"),
      "next due: " + (status.nextDue ?? "-"),
      ...Object.entries(status.byKind).map(([kind, count]) => kind + ": " + count)
    ]);
    return;
  }
  if (action === "enable" || action === "disable") {
    const job = scheduler.setEnabled(positionals[0], action === "enable");
    out(t("cli.schedule.toggled", { id: job.id, state: job.enabled ? "enabled" : "disabled" }));
    return;
  }
  if (action === "remove") {
    const job = scheduler.remove(positionals[0]);
    out(t("cli.schedule.removed", { id: job.id }));
    return;
  }
  if (action === "history") {
    table(scheduler.runLog(positionals[0], { limit: Number(flags.limit ?? 20) }).map((run) => run.startedAt + " | " + run.status + " | " + run.durationMs + "ms | " + run.summary));
    return;
  }
  if (action === "incidents") {
    const incidents = scheduler.incidents({ open: flags.open ? true : flags.all ? null : true });
    out(t("cli.schedule.incidentsTitle", { count: incidents.length }));
    table(incidents.map((incident) => incident.id + " | " + incident.jobId + " | " + (incident.closedAt ? "closed" : "open") + " | " + incident.summary));
    return;
  }
  if (action === "defaults") {
    const created = scheduler.installDefaults();
    out(t("cli.schedule.defaults", { count: created.length }));
    table(created.map((job) => job.id + " (" + describeSchedule(job.schedule) + ")"));
    return;
  }
  if (action === "policy") {
    const policy = runtime.automationPolicy;
    if (positionals[0] === "allow-command") {
      policy.allowCommandPermanently(positionals[1]);
      out(t("cli.schedule.policyUpdated", { what: "command " + positionals[1] }));
      return;
    }
    if (positionals[0] === "allow-host") {
      policy.allowHostPermanently(positionals[1]);
      out(t("cli.schedule.policyUpdated", { what: "host " + positionals[1] }));
      return;
    }
    out(JSON.stringify(policy.policy, null, 2));
    return;
  }
  throw new Error(t("cli.schedule.unknownAction", { action }));
}

function buildPayload(flags) {
  const payload = {};
  if (flags.url) {
    payload.url = String(flags.url);
  }
  if (flags.expectStatus) {
    payload.expect = { ...(payload.expect ?? {}), status: Number(flags.expectStatus) };
  }
  if (flags.expectContains) {
    payload.expect = { ...(payload.expect ?? {}), contains: String(flags.expectContains) };
  }
  if (flags.maxLatency) {
    payload.expect = { ...(payload.expect ?? {}), maxLatencyMs: Number(flags.maxLatency) };
  }
  if (flags.command) {
    payload.command = String(flags.command);
    payload.args = flags.args ? String(flags.args).split(" ") : [];
  }
  if (flags.profile) {
    payload.profile = String(flags.profile);
  }
  return payload;
}

export async function runSignalCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "list", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const signals = runtime.signals;

  if (action === "list") {
    const hooks = signals.list();
    out(t("cli.signal.listTitle", { count: hooks.length }));
    table(hooks.map((hook) => hook.id + " | " + hook.source + " | " + (hook.enabled ? "enabled" : "disabled") + " | rules " + hook.rules.length + " | received " + hook.state.received));
    return;
  }
  if (action === "create") {
    const hook = signals.create({
      name: positionals.join(" "),
      id: flags.id ? String(flags.id) : null,
      source: String(flags.source ?? "generic"),
      requireSignature: flags.noSignature ? false : true,
      mapping: flags.mapping ? JSON.parse(String(flags.mapping)) : {},
      defaults: { domain: flags.domain ? String(flags.domain) : null, project: flags.project ? String(flags.project) : null }
    });
    out(t("cli.signal.created", { id: hook.id, source: hook.source }));
    out(t("cli.signal.endpoint", { url: signals.endpoint(hook.id, { host: String(flags.host ?? "http://127.0.0.1:8787") }) }));
    out(t("cli.signal.secret", { secret: hook.secret }));
    return;
  }
  if (action === "rule") {
    const rule = signals.addRule(positionals[0], {
      when: {
        contains: flags.contains ? String(flags.contains).split(",").map((entry) => entry.trim()) : undefined,
        regex: flags.regex ? String(flags.regex) : undefined,
        from: flags.from ? String(flags.from) : undefined,
        domain: flags.domain ? String(flags.domain) : undefined
      },
      then: JSON.parse(String(flags.then ?? '[{"action":"notify","params":{}}]')),
      stop: Boolean(flags.stop)
    });
    out(t("cli.signal.ruleAdded", { hook: positionals[0], id: rule.id, actions: rule.then.map((entry) => entry.action).join(",") }));
    return;
  }
  if (action === "endpoint") {
    out(signals.endpoint(positionals[0], { host: String(flags.host ?? "http://127.0.0.1:8787") }));
    return;
  }
  if (action === "emit") {
    const payload = flags.payload ? JSON.parse(String(flags.payload)) : { text: positionals.slice(1).join(" "), from: flags.from ? String(flags.from) : "cli" };
    const event = signals.emit(positionals[0], payload);
    out(t("cli.signal.emitted", { id: event.id, domain: event.domain ?? "-" }));
    if (!flags.queueOnly) {
      const processed = await signals.process(event);
      table(processed.reactions.map((reaction) => reaction.action + ": " + (reaction.ok ? "ok" : "failed") + " — " + reaction.summary));
    }
    return;
  }
  if (action === "process") {
    const processed = await signals.processQueue({ limit: Number(flags.limit ?? 50) });
    out(t("cli.signal.processed", { count: processed.length }));
    table(processed.map((event) => event.id + " -> " + event.reactions.map((reaction) => reaction.action).join(",")));
    return;
  }
  if (action === "inbox") {
    const events = signals.inbox({ state: flags.state ? String(flags.state) : null, limit: Number(flags.limit ?? 20) });
    table(events.map((event) => event.id + " | " + event.at.slice(0, 16) + " | " + event.state + " | " + (event.domain ?? "-") + " | " + event.text.slice(0, 60)));
    return;
  }
  if (action === "serve") {
    const server = new SignalServer(signals, {
      port: Number(flags.port ?? 8787),
      host: String(flags.host ?? "127.0.0.1"),
      log: out,
      processImmediately: !flags.queueOnly
    });
    await server.start();
    await new Promise(() => {});
    return;
  }
  if (action === "status") {
    const status = signals.status();
    out(t("cli.signal.statusTitle", status));
    return;
  }
  if (action === "remove") {
    const hook = signals.remove(positionals[0]);
    out(t("cli.signal.removed", { id: hook.id }));
    return;
  }
  throw new Error(t("cli.signal.unknownAction", { action }));
}

export async function runBrowserCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "status", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const browser = runtime.browser;

  if (action === "status") {
    const status = browser.status();
    out(t("cli.browser.statusTitle", { driver: status.driver, binary: status.binary ?? "-" }));
    out(status.note);
    table(status.profiles.map((profile) => profile.id + " | sites " + profile.sites + " | last used " + (profile.lastUsedAt ?? "-")));
    return;
  }
  if (action === "profile") {
    if (positionals[0] === "create") {
      const profile = browser.createProfile({ id: positionals[1], name: flags.name ? String(flags.name) : null, headless: !flags.headed });
      out(t("cli.browser.profileCreated", { id: profile.id, dir: profile.userDataDir }));
      return;
    }
    if (positionals[0] === "remove") {
      const profile = browser.removeProfile(positionals[1]);
      out(t("cli.browser.profileRemoved", { id: profile?.id ?? positionals[1] }));
      return;
    }
    table(browser.profiles().map((profile) => profile.id + " | " + profile.name + " | sites " + profile.sites.length));
    return;
  }
  if (action === "login") {
    out(t("cli.browser.loginOpening", { url: String(flags.url), profile: positionals[0] }));
    const result = await browser.login(positionals[0], {
      url: String(flags.url),
      waitForSelector: flags.waitFor ? String(flags.waitFor) : null,
      timeoutMs: Number(flags.timeout ?? 300000)
    });
    out(t("cli.browser.loginDone", { profile: result.profile, cookies: result.cookies, hosts: result.hosts }));
    return;
  }
  if (action === "health") {
    const health = browser.health(positionals[0]);
    out(t("cli.browser.healthTitle", { profile: health.profile }));
    table(health.sites.map((site) => site.host + " | " + site.state + " | cookies " + site.cookies + " | expires " + (site.expiresAt ?? "session")));
    if (health.needsLogin.length) {
      out(t("cli.browser.needsLogin", { hosts: health.needsLogin.join(", ") }));
    }
    return;
  }
  if (action === "run") {
    const steps = flags.steps ? JSON.parse(String(flags.steps)) : [];
    const result = await browser.run({
      profile: String(flags.profile ?? "default"),
      url: flags.url ? String(flags.url) : null,
      steps,
      capture: flags.capture ? String(flags.capture).split(",") : ["screenshot"],
      evidence: flags.evidence ? String(flags.evidence) : null,
      mission: flags.mission ? String(flags.mission) : null,
      headless: !flags.headed,
      dryRun: Boolean(flags.dryRun)
    });
    out(result.summary);
    table((result.steps ?? []).map((step) => step.order + ". " + step.action + " " + (step.ok ? "ok" : "failed") + " — " + step.detail));
    if (result.artifacts?.length) {
      out(t("cli.browser.artifacts", { count: result.artifacts.length }));
      table(result.artifacts);
    }
    if (result.requiresApproval) {
      out(t("cli.browser.approvalNeeded", { action: result.pending.pendingStep.action }));
    }
    return;
  }
  if (action === "resume") {
    const result = await browser.resume(positionals[0], { approve: !flags.reject });
    out(result.summary);
    return;
  }
  if (action === "evidence") {
    if (positionals[0] === "verify") {
      const report = browser.evidence.verify(positionals[1]);
      out(t("cli.browser.evidenceVerify", { bundle: report.bundle, entries: report.entries, intact: report.intact ? "ok" : "broken" }));
      table(report.problems.map((problem) => problem.id + ": " + problem.problem));
      return;
    }
    const bundle = positionals[0];
    if (!bundle) {
      table(browser.evidence.bundles().map((entry) => entry.bundle + " | entries " + entry.entries + " | last " + (entry.lastAt ?? "-")));
      return;
    }
    table(browser.evidence.entries(bundle).map((entry) => entry.at + " | " + entry.kind + " | " + entry.file + " | " + entry.sha256.slice(0, 12)));
    return;
  }
  throw new Error(t("cli.browser.unknownAction", { action }));
}

export async function runMissionCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "list", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const missions = runtime.missions;

  if (action === "list") {
    const list = missions.list({ state: flags.state ? String(flags.state) : null, limit: Number(flags.limit ?? 20) });
    out(t("cli.mission.listTitle", { count: list.length }));
    table(list.map((mission) => mission.id + " | " + mission.state + " | " + mission.currentStep + "/" + mission.steps.length + " | " + mission.title.slice(0, 60)));
    return;
  }
  if (action === "show") {
    const mission = missions.get(positionals[0]);
    out(t("cli.mission.showTitle", { id: mission.id, state: mission.state, title: mission.title }));
    table(mission.steps.map((step) => step.order + ". [" + step.state + "] " + step.title + (step.tool ? " (" + step.tool + "." + step.action + ", " + (step.authority ?? "-") + ")" : "")));
    if (mission.artifacts.length) {
      out(t("cli.mission.artifacts", { count: mission.artifacts.length }));
      table(mission.artifacts);
    }
    if (mission.approvals.length) {
      out(t("cli.mission.approvals", { ids: mission.approvals.join(", ") }));
    }
    return;
  }
  if (action === "create") {
    const mission = missions.create({
      title: positionals.join(" "),
      goal: flags.goal ? String(flags.goal) : null,
      domain: flags.domain ? String(flags.domain) : null,
      project: flags.project ? String(flags.project) : null,
      steps: flags.steps ? JSON.parse(String(flags.steps)) : []
    });
    out(t("cli.mission.created", { id: mission.id, steps: mission.steps.length }));
    return;
  }
  if (action === "step") {
    const mission = missions.addStep(positionals[0], {
      title: positionals.slice(1).join(" "),
      tool: flags.tool ? String(flags.tool) : null,
      action: flags.action ? String(flags.action) : null,
      params: flags.params ? JSON.parse(String(flags.params)) : {},
      authority: flags.authority ? String(flags.authority) : null
    });
    out(t("cli.mission.stepAdded", { id: mission.id, steps: mission.steps.length }));
    return;
  }
  if (action === "run") {
    const result = await missions.run(positionals[0], { dryRun: Boolean(flags.dryRun) });
    out(result.summary);
    table(result.mission.steps.map((step) => step.order + ". [" + step.state + "] " + step.title));
    return;
  }
  if (action === "resume") {
    missions.resume(positionals[0], { note: flags.note ? String(flags.note) : null });
    const result = await missions.run(positionals[0]);
    out(result.summary);
    return;
  }
  if (action === "pause") {
    out(t("cli.mission.paused", { id: missions.pause(positionals[0], { reason: flags.reason ? String(flags.reason) : null }).id }));
    return;
  }
  if (action === "cancel") {
    out(t("cli.mission.cancelled", { id: missions.cancel(positionals[0], { reason: flags.reason ? String(flags.reason) : null }).id }));
    return;
  }
  if (action === "replay") {
    const result = await missions.replay(positionals[0]);
    out(t("cli.mission.replayed", { original: result.original, replay: result.replay }));
    table(result.steps.map((step) => step.id + " " + step.state + " " + step.title));
    return;
  }
  if (action === "report") {
    const mission = missions.report(positionals[0], {
      summary: String(flags.summary ?? positionals.slice(1).join(" ")),
      outcome: flags.failed ? "failed" : "done"
    });
    out(t("cli.mission.reported", { id: mission.id, state: mission.state }));
    return;
  }
  if (action === "status") {
    const status = missions.status();
    out(t("cli.mission.statusTitle", { missions: status.missions, active: status.active, waiting: status.waitingApproval }));
    table(status.recent.map((mission) => mission.id + " | " + mission.state + " | " + mission.step + " | " + mission.title.slice(0, 50)));
    return;
  }
  throw new Error(t("cli.mission.unknownAction", { action }));
}
