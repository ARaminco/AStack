import { parseArgs } from "../delivery-engine/cli.mjs";

const out = (line) => console.log(line);

function table(rows) {
  for (const row of rows) {
    out(String(row).startsWith("-") ? String(row) : "- " + row);
  }
}

export async function runAskCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const { positionals, flags } = parseArgs(tokens);
  const request = positionals.join(" ");
  if (!request) {
    throw new Error(t("cli.chief.requestRequired"));
  }
  const chief = runtime.chief;

  if (flags.dryRun) {
    const plan = chief.dryRun(request, { domain: flags.domain ? String(flags.domain) : null });
    out(t("cli.chief.dryRunTitle"));
    table(plan.summary);
    out(t("cli.chief.plannedSteps"));
    table(plan.plan.steps.map((step) => step.title + " (" + (step.authority ?? "L1") + (step.tool ? ", " + step.tool + "." + step.action : "") + ")"));
    if (plan.externalEffects.length) {
      out(t("cli.chief.externalEffects"));
      table(plan.externalEffects);
    }
    if (plan.requiredCredentials.length) {
      out(t("cli.chief.credentials"));
      table(plan.requiredCredentials);
    }
    if (plan.approvalCheckpoints.length) {
      out(t("cli.chief.checkpoints"));
      table(plan.approvalCheckpoints);
    }
    if (plan.openQuestions.length) {
      out(t("cli.chief.questions"));
      table(plan.openQuestions);
    }
    return;
  }

  if (flags.engage) {
    const engagement = chief.engage(request, {
      domain: flags.domain ? String(flags.domain) : null,
      project: flags.project ? String(flags.project) : null,
      formTeam: flags.team ? true : flags.solo ? false : null
    });
    out(t("cli.chief.engaged", {
      mission: engagement.mission?.id ?? "-",
      team: engagement.team?.team?.id ?? "-",
      agents: engagement.team?.agents.length ?? 0
    }));
    table(engagement.brief.summary);
    out(t("cli.chief.plannedSteps"));
    table(engagement.brief.plan.steps.map((step) => step.title + " (" + (step.authority ?? "L1") + ")"));
    if (engagement.run && engagement.mission) {
      const result = await runtime.missions.run(engagement.mission.id);
      out(result.summary);
    }
    return;
  }

  const brief = chief.brief(request, {
    domain: flags.domain ? String(flags.domain) : null,
    project: flags.project ? String(flags.project) : null,
    includeRepoMap: !flags.noMap
  });
  out(t("cli.chief.briefTitle", { request: request.slice(0, 80) }));
  table(brief.summary);
  if (brief.entities.length) {
    out(t("cli.chief.entities"));
    table(brief.entities.map((entity) => entity.type + " " + entity.name + " (" + entity.score + ")"));
  }
  if (brief.experience.length) {
    out(t("cli.chief.experience"));
    table(brief.experience.map((episode) => episode.id + " (" + episode.outcome + ", " + episode.similarity + "): " + episode.task.slice(0, 70)));
  }
  out(t("cli.chief.plannedSteps"));
  table(brief.plan.steps.map((step) => step.title + " (" + (step.authority ?? "L1") + ")"));
  if (flags.context) {
    out("");
    out(runtime.chief.contextRouter.render(brief.context));
  }
  if (brief.openQuestions.length) {
    out(t("cli.chief.questions"));
    table(brief.openQuestions);
  }
}

export function runOwnerCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "capsule", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const owner = runtime.chief.owner;

  if (action === "capsule") {
    const capsule = owner.capsule({ budget: Number(flags.budget ?? runtime.budgets.ownerCapsule ?? 800) });
    out(t("cli.owner.capsuleTitle", { tokens: capsule.tokens, budget: capsule.budget }));
    table(capsule.lines);
    return;
  }
  if (action === "show") {
    out(JSON.stringify(owner.read(), null, 2));
    return;
  }
  if (action === "set") {
    const patch = {};
    if (flags.name) {
      patch.name = String(flags.name);
    }
    if (flags.timezone) {
      patch.timezone = String(flags.timezone);
    }
    if (flags.style) {
      patch.responseStyle = String(flags.style);
    }
    if (flags.company) {
      patch.companies = String(flags.company).split(",").map((entry) => entry.trim());
    }
    if (flags.workflow) {
      patch.recurringWorkflows = String(flags.workflow).split(",").map((entry) => entry.trim());
    }
    const profile = owner.update(patch);
    out(t("cli.owner.updated", { updatedAt: profile.updatedAt }));
    return;
  }
  if (action === "prefer") {
    const entry = owner.learnPreference(positionals.join(" "), { evidence: flags.evidence ? String(flags.evidence) : null });
    out(t("cli.owner.preference", { text: entry }));
    return;
  }
  if (action === "context") {
    const package_ = runtime.chief.contextRouter.route(positionals.join(" ") || "current priorities", { budgets: runtime.budgets });
    out(runtime.chief.contextRouter.render(package_));
    return;
  }
  if (action === "summarize") {
    const result = owner.summarizeConversation({
      summary: String(flags.summary ?? positionals.join(" ")),
      decisions: flags.decision ? [{ title: String(flags.decision), reason: flags.reason ? String(flags.reason) : "" }] : [],
      newFacts: flags.fact ? [{ title: String(flags.fact) }] : [],
      openQuestions: flags.question ? [String(flags.question)] : [],
      preferences: flags.preference ? [String(flags.preference)] : [],
      domain: flags.domain ? String(flags.domain) : null,
      project: flags.project ? String(flags.project) : null
    });
    out(t("cli.owner.summarized", { stored: result.stored }));
    return;
  }
  throw new Error(t("cli.owner.unknownAction", { action }));
}

export function runStandupCommand({ runtime, i18n }) {
  const t = i18n.t.bind(i18n);
  const standup = runtime.chief.standup();
  out(t("cli.chief.standupTitle"));
  table(standup.capsule.lines);
  if (standup.missions) {
    out(t("cli.chief.missions", { missions: standup.missions.missions, active: standup.missions.active, waiting: standup.missions.waitingApproval }));
    table(standup.missions.recent.map((mission) => mission.id + " | " + mission.state + " | " + mission.step + " | " + mission.title.slice(0, 50)));
  }
  if (standup.pendingApprovals.length) {
    out(t("cli.chief.pendingApprovals", { count: standup.pendingApprovals.length }));
    table(standup.pendingApprovals.map((approval) => approval.id + " | " + approval.action + " | " + approval.summary.slice(0, 60)));
  }
  if (standup.learning) {
    out(t("cli.chief.learning", standup.learning));
  }
  const scheduler = runtime.scheduler.status();
  out(t("cli.chief.jobs", { jobs: scheduler.jobs, due: scheduler.due, incidents: scheduler.incidents }));
  const signals = runtime.signals.status();
  if (signals.hooks) {
    out(t("cli.chief.signals", signals));
  }
}
