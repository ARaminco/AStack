import { parseArgs } from "../delivery-engine/cli.mjs";
import { DEFAULT_SOURCE, UpgradeEngine, fetchSource } from "../upgrade-engine/upgrade-engine.mjs";

const out = (line) => console.log(line);

export function runDomainCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action, ...rest] = tokens;
  if (action === "detect") {
    const detected = runtime.domains.detect(rest.join(" "));
    out(detected ? t("cli.domain.detected", { id: detected.id, name: detected.nameFa }) : t("cli.domain.none"));
    return;
  }
  out(t("cli.domain.listTitle"));
  for (const domain of runtime.domains.list()) {
    out("- " + domain.id + " | " + domain.nameFa + " | " + domain.departments.join(", "));
  }
}

export function runTeamCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action, ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const teams = runtime.teams;

  if (!action || action === "list") {
    out(t("cli.team.listTitle"));
    for (const team of teams.list()) {
      out("- " + team.id + " | " + team.domain + " | " + team.status + " | members=" + team.members.length + (team.project ? " | project=" + team.project : ""));
    }
    return;
  }
  if (action === "create") {
    if (!flags.domain) {
      throw new Error(t("cli.team.domainRequired"));
    }
    const team = teams.create({ name: positionals.join(" "), domain: String(flags.domain), mission: flags.mission ? String(flags.mission) : "" });
    out(t("cli.team.created", { id: team.id, members: team.members.length }));
    return;
  }
  const id = positionals[0];
  if (!id) {
    throw new Error(t("cli.team.idRequired"));
  }
  if (action === "show") {
    const team = teams.get(id);
    out(t("cli.team.showTitle", { id: team.id, name: team.name, domain: team.domain, status: team.status }));
    for (const member of teams.roster(id)) {
      out("- " + member.role + (member.lead ? " (lead)" : "") + " | " + (member.department ?? "-") + " | agent=" + (member.agent ?? "-"));
    }
    return;
  }
  if (action === "add") {
    const member = teams.addMember(id, { role: String(flags.role ?? ""), department: flags.dept ? String(flags.dept) : null, lead: Boolean(flags.lead) });
    out(t("cli.team.memberAdded", { role: member.role }));
    return;
  }
  if (action === "remove") {
    const removed = teams.removeMember(id, String(flags.role ?? ""));
    out(t("cli.team.memberRemoved", { role: removed.role }));
    return;
  }
  if (action === "project") {
    teams.assignProject(id, positionals[1]);
    out(t("cli.team.projectLinked", { id, project: positionals[1] }));
    return;
  }
  if (action === "status") {
    const team = teams.setStatus(id, positionals[1]);
    out(t("cli.team.statusChanged", { id, status: team.status }));
    return;
  }
  if (action === "disband") {
    teams.disband(id);
    out(t("cli.team.disbanded", { id }));
    return;
  }
  throw new Error(t("cli.team.unknownAction", { action }));
}

export function runAgentCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action, ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const agents = runtime.agents;

  if (!action || action === "list") {
    out(t("cli.agent.listTitle"));
    for (const agent of agents.list()) {
      out("- " + agent.id + " | " + agent.role + " | " + agent.status + " | team=" + (agent.team ?? "-") + " | assignments=" + agent.assignments.length);
    }
    return;
  }
  if (action === "standup") {
    out(t("cli.agent.standupTitle"));
    for (const line of agents.standup()) {
      out("- " + line.id + " | " + line.role + " | " + line.status + " | open=" + line.open + " | overdue=" + line.overdue + " | next=" + (line.nextDue ?? "-"));
    }
    return;
  }
  if (action === "run-due") {
    const dispatched = agents.runDue();
    if (!dispatched.length) {
      out(t("cli.agent.nothingDue"));
      return;
    }
    out(t("cli.agent.ranDue", { count: dispatched.length }));
    for (const entry of dispatched) {
      out("- " + entry.agentId + " " + entry.assignmentId + " -> " + entry.workOrder);
    }
    return;
  }
  if (action === "create") {
    const agent = agents.create({
      name: positionals.join(" ") || undefined,
      role: flags.role ? String(flags.role) : undefined,
      department: flags.dept ? String(flags.dept) : null,
      team: flags.team ? String(flags.team) : null,
      mission: flags.mission ? String(flags.mission) : ""
    });
    out(t("cli.agent.created", { id: agent.id, role: agent.role }));
    return;
  }
  const id = positionals[0];
  if (!id) {
    throw new Error(t("cli.agent.idRequired"));
  }
  if (action === "show") {
    const agent = agents.get(id);
    out(t("cli.agent.showTitle", { id: agent.id, role: agent.role, status: agent.status }));
    for (const assignment of agent.assignments) {
      out("- " + assignment.id + " | " + assignment.status + " | next=" + (assignment.schedule.next ?? "-") + " | " + assignment.objective);
    }
    return;
  }
  if (action === "brief") {
    agents.brief(id, positionals.slice(1).join(" "));
    out(t("cli.agent.briefed", { id }));
    return;
  }
  if (action === "assign") {
    const assignment = agents.assign(id, {
      objective: positionals.slice(1).join(" "),
      every: flags.every ? String(flags.every) : null,
      at: flags.at ? String(flags.at) : null,
      deliverable: flags.deliverable ? String(flags.deliverable) : null,
      priority: flags.priority ? String(flags.priority) : "normal"
    });
    out(t("cli.agent.assigned", { id: assignment.id, agent: id, next: assignment.schedule.next }));
    return;
  }
  if (action === "report") {
    const run = agents.report(id, positionals[1], {
      summary: flags.summary ? String(flags.summary) : "",
      result: flags.failed ? "failed" : "done"
    });
    out(t("cli.agent.reported", { id: positionals[1], status: run.status }));
    return;
  }
  if (action === "pause" || action === "resume" || action === "retire") {
    const handler = { pause: () => agents.pause(id), resume: () => agents.resume(id), retire: () => agents.retire(id) }[action];
    const agent = handler();
    out(t("cli.agent.statusChanged", { id, status: agent.status }));
    return;
  }
  if (action === "workload") {
    const load = agents.workload(id);
    out(t("cli.agent.workload", { id, total: load.total }));
    for (const [status, count] of Object.entries(load.byStatus)) {
      out("- " + status + ": " + count);
    }
    return;
  }
  throw new Error(t("cli.agent.unknownAction", { action }));
}

export function runLeadCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action, ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const leadership = runtime.leadership;

  if (action === "plan") {
    const proposal = leadership.propose(positionals.join(" "));
    out(t("cli.lead.planTitle", { goal: proposal.goal }));
    out(t("cli.lead.planDomain", { name: proposal.domain.nameFa, id: proposal.domain.id }));
    out(t("cli.lead.planWorkflow", { id: proposal.workflow }));
    out(t("cli.lead.planLead", { role: proposal.team.lead.role, department: proposal.team.lead.department }));
    for (const member of proposal.team.members) {
      out("- " + member.role + " | " + member.department);
    }
    return;
  }
  if (action === "team") {
    const formed = leadership.formTeam(positionals.join(" "), { name: flags.name ? String(flags.name) : null });
    out(t("cli.lead.teamFormed", { id: formed.team.id, agents: formed.agents.length }));
    for (const agent of formed.agents) {
      out("- " + agent.id + " | " + agent.role);
    }
    return;
  }
  if (action === "delegate") {
    const projectId = positionals[0];
    if (!projectId || !flags.team) {
      throw new Error(t("cli.lead.delegateUsage"));
    }
    const delegated = leadership.delegate({ projectId, teamId: String(flags.team), every: flags.every ? String(flags.every) : null });
    out(t("cli.lead.delegated", { count: delegated.length, team: String(flags.team), project: projectId }));
    for (const entry of delegated) {
      out("- " + entry.itemId + " -> " + entry.agentId + " (" + entry.assignmentId + ")");
    }
    return;
  }
  if (action === "standup" || !action) {
    const report = leadership.standup();
    out(t("cli.lead.standupTitle", { teams: report.teams.length, due: report.due, review: report.awaitingReview }));
    for (const team of report.teams) {
      out("- " + team.id + " | " + team.domain + " | " + team.status + " | members=" + team.members + (team.project ? " | project=" + team.project : ""));
    }
    for (const agent of report.agents) {
      out("- " + agent.id + " | open=" + agent.open + " | overdue=" + agent.overdue + (agent.lastReport ? " | last=" + agent.lastReport.status : ""));
    }
    return;
  }
  if (action === "review") {
    const queue = leadership.reviewQueue();
    out(t("cli.lead.reviewTitle", { count: queue.length }));
    for (const entry of queue) {
      out("- " + entry.agentId + " | " + entry.assignmentId + "/" + entry.runId + " | " + entry.objective + " | " + entry.workOrder);
    }
    return;
  }
  throw new Error(t("cli.lead.unknownAction", { action }));
}

export function runUpgradeCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const { flags } = parseArgs(tokens);
  const source = String(flags.from ?? process.env.ASTACK_SOURCE ?? DEFAULT_SOURCE);
  out(t("cli.upgrade.checking", { source }));
  const fetched = fetchSource(runtime.root, source);
  const keep = flags.keep ? String(flags.keep).split(",").map((entry) => entry.trim()).filter(Boolean) : [];
  const engine = new UpgradeEngine(runtime.root, { sourceDir: fetched.dir, keep });
  const plan = engine.plan();
  out(t("cli.upgrade.versions", { current: plan.currentVersion, latest: plan.sourceVersion }));
  if (plan.upToDate && !flags.force) {
    out(t("cli.upgrade.upToDate"));
    return;
  }
  out(t("cli.upgrade.planLine", { add: plan.counts.add, update: plan.counts.update, seed: plan.counts.seed, preserved: plan.counts.preserved }));
  if (flags.check) {
    for (const change of plan.changes.filter((entry) => entry.action !== "preserved").slice(0, 40)) {
      out("- " + change.action + " " + change.path);
    }
    out(t("cli.upgrade.checkDone"));
    return;
  }
  const result = engine.apply({ force: Boolean(flags.force) });
  out(t("cli.upgrade.applied", { count: result.appliedCount, backup: result.backupDir }));
  if (result.configSectionsAdded?.length) {
    out(t("cli.upgrade.configAdded", { sections: result.configSectionsAdded.join(", ") }));
  }
  out(t("cli.upgrade.doctorHint"));
}
