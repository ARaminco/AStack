import { IntentEngine } from "./intent-engine.mjs";
import { OwnerModel } from "./owner-model.mjs";
import { TeamPlanner } from "./team-planner.mjs";
import { ContextRouter } from "../context-engine/context-router.mjs";

/**
 * The Chief of Staff.
 *
 * One layer above orchestration: it reads the request the way a chief of staff
 * would — what does the owner mean, what do we already know, which engagement
 * is this, how risky is it, who is the smallest team that can do it, which
 * skill did we learn last time, which tools and runtime fit, and what needs the
 * owner's signature. It returns a brief, and on request turns that brief into a
 * durable mission.
 */
export class ChiefOfStaff {
  constructor(root, {
    clock,
    eventBus = null,
    domains = null,
    memory = null,
    graph = null,
    context = null,
    projects = null,
    learning = null,
    tools = null,
    teams = null,
    agents = null,
    missions = null,
    authority = null,
    approvals = null,
    audit = null,
    router = null,
    runtimes = null,
    workflows = null,
    budgets = {}
  } = {}) {
    this.root = root;
    this.clock = clock ?? (() => new Date());
    this.eventBus = eventBus;
    this.domains = domains;
    this.memory = memory;
    this.graph = graph;
    this.context = context;
    this.projects = projects;
    this.learning = learning;
    this.tools = tools;
    this.teams = teams;
    this.agents = agents;
    this.missions = missions;
    this.authority = authority;
    this.approvals = approvals;
    this.audit = audit;
    this.modelRouter = router;
    this.runtimes = runtimes;
    this.workflows = workflows;
    this.budgets = budgets;
    this.owner = new OwnerModel(root, { clock: this.clock, memory, graph, projects });
    this.intentEngine = new IntentEngine({ domains, clock: this.clock });
    this.teamPlanner = new TeamPlanner({ domains, teams, agents });
    this.contextRouter = new ContextRouter({ context, memory, graph, projects, learning, tools, owner: this.owner, domains, clock: this.clock });
  }

  now() {
    return this.clock().toISOString();
  }

  /**
   * Read a request and produce the full plan without doing anything yet.
   */
  brief(request, { domain = null, project = null, budgets = {}, includeRepoMap = true } = {}) {
    const intent = this.intentEngine.analyze(request, { domain });
    const contextPackage = this.contextRouter.route(request, {
      domain: intent.domain,
      project,
      budgets: { ...this.budgets, ...budgets },
      includeRepoMap,
      intent
    });
    const skills = this.learning?.match(request, { domain: intent.domain, limit: 3 }) ?? [];
    const experience = this.learning?.experience?.similar(request, { domain: intent.domain, limit: 3 }) ?? [];
    const toolMatches = (intent.needs ?? []).flatMap((need) => this.tools?.search(need, { limit: 2 }) ?? []);
    const uniqueTools = [...new Map(toolMatches.map((tool) => [tool.id, tool])).values()];
    const decision = this.authority?.evaluate({
      action: intent.verb,
      level: intent.authority,
      domain: intent.domain,
      tool: uniqueTools[0]?.id ?? null
    }) ?? null;
    const routing = this.modelRouter?.route({
      task: request,
      risk: intent.authority,
      contextTokens: contextPackage.tokens,
      requiresTools: uniqueTools.map((tool) => tool.id)
    }) ?? null;
    const team = this.teamPlanner.plan(intent);
    const workflow = this.selectWorkflow(request, intent);
    const plan = this.buildPlan({ intent, skills, tools: uniqueTools, contextPackage });
    return {
      at: this.now(),
      request,
      intent,
      domain: intent.domain,
      project: contextPackage.project,
      entities: contextPackage.entities,
      context: contextPackage,
      skills,
      experience,
      tools: uniqueTools,
      authority: decision,
      runtime: routing,
      team,
      workflow,
      plan,
      approvalNeeded: Boolean(decision?.requiresApproval),
      openQuestions: intent.questions,
      summary: this.summarize({ intent, team, decision, routing, skills, contextPackage })
    };
  }

  selectWorkflow(request, intent) {
    if (!this.workflows) {
      return null;
    }
    try {
      const keyword = this.workflows.selectStrict ? this.workflows.selectStrict(request) : null;
      if (keyword) {
        return keyword.id;
      }
      if (intent.domain) {
        return this.domains?.get(intent.domain)?.workflow ?? null;
      }
      return this.workflows.select(request)?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Convert the brief into a concrete step plan. Steps that reach outside the
   * system carry the authority level they will be checked against.
   */
  buildPlan({ intent, skills, tools, contextPackage }) {
    const steps = [];
    if (skills.length) {
      steps.push({ title: "load the learned skill " + skills[0].id, tool: null, action: null, authority: "L0" });
    }
    steps.push({
      title: "retrieve the exact sources behind the context package",
      tool: "context",
      action: "query",
      params: { text: intent.request, limit: 8 },
      authority: "L1"
    });
    if ((intent.needs ?? []).includes("recall")) {
      steps.push({
        title: "recall what we already know about this engagement",
        tool: "memory",
        action: "recall",
        params: { query: intent.request, limit: 10 },
        authority: "L1"
      });
    }
    if (intent.externalAction) {
      steps.push({
        title: "plan the browser flow before touching the site",
        tool: "browser",
        action: "plan",
        params: { profile: "default", steps: [] },
        authority: "L0"
      });
      steps.push({
        title: intent.authority === "L4" ? "run the flow and stop before the commit" : "run the browser flow",
        tool: "browser",
        action: "run",
        params: { profile: "default", capture: ["screenshot"] },
        authority: intent.authority === "L4" ? "L4" : "L3"
      });
    }
    if ((intent.needs ?? []).includes("schedule")) {
      steps.push({
        title: "install the background job that keeps this watched",
        tool: "scheduler",
        action: "add",
        params: { name: intent.request.slice(0, 60), kind: "http-check", schedule: { every: "10m" } },
        authority: "L2"
      });
    }
    steps.push({ title: "verify the result and capture evidence", tool: null, action: null, authority: "L1" });
    steps.push({ title: "record the episode so the system learns from this run", tool: null, action: null, authority: "L0" });
    return { steps, tools: tools.map((tool) => tool.id), contextTokens: contextPackage.tokens };
  }

  summarize({ intent, team, decision, routing, skills, contextPackage }) {
    const lines = [];
    lines.push("خواسته: " + intent.verb + " | دامنه: " + (intent.domain ?? "نامشخص") + " | پیچیدگی: " + intent.complexity);
    lines.push("تیم پیشنهادی: " + team.size + " نفر (" + team.seats.map((seat) => seat.role).join("، ") + ") — هزینه تخمینی " + team.estimatedTokens + " توکن");
    if (skills.length) {
      lines.push("مهارت آموخته‌شده مرتبط: " + skills[0].id + " با اعتماد " + skills[0].confidence);
    }
    if (routing?.runtime) {
      lines.push("اجرا روی runtime " + routing.runtime + " در سطح " + routing.tier);
    }
    if (decision) {
      lines.push(
        "سطح اختیار: " + decision.level + " — " + decision.meaning +
        (decision.requiresApproval ? " (نیازمند تأیید مالک)" : decision.blocked ? " (خارج از سقف مجاز)" : " (مجاز به اجرای خودکار)")
      );
    }
    lines.push("بسته زمینه: " + contextPackage.tokens + " توکن از بودجه " + contextPackage.budget + " — صرفه‌جویی " + contextPackage.tokensAvoided + " توکن");
    return lines;
  }

  /**
   * Explain what would happen, with no side effects at all.
   */
  dryRun(request, options = {}) {
    const brief = this.brief(request, options);
    return {
      ...brief,
      dryRun: true,
      externalEffects: brief.plan.steps
        .filter((step) => ["L3", "L4", "L5"].includes(step.authority))
        .map((step) => step.title + " (" + step.authority + ")"),
      requiredCredentials: brief.tools
        .map((tool) => {
          try {
            return this.tools?.inspect(tool.id)?.requiredCredentials ?? [];
          } catch {
            return [];
          }
        })
        .flat(),
      approvalCheckpoints: brief.plan.steps.filter((step) => step.authority === "L4").map((step) => step.title)
    };
  }

  /**
   * Commit the brief: form the team if one is needed and open a durable
   * mission that can be run, paused, approved and resumed.
   */
  engage(request, { domain = null, project = null, formTeam = null, run = false } = {}) {
    const brief = this.brief(request, { domain, project });
    const shouldFormTeam = formTeam ?? brief.team.size > 1;
    let team = null;
    if (shouldFormTeam && this.teams && this.agents) {
      team = this.teamPlanner.form(brief.team, { goal: request });
    }
    const mission = this.missions?.create({
      title: request.slice(0, 120),
      goal: request,
      domain: brief.domain,
      project: brief.project,
      team: team?.team?.id ?? null,
      steps: brief.plan.steps,
      tags: ["chief-of-staff"],
      runtime: brief.runtime?.runtime ?? null,
      context: { tokens: brief.context.tokens, sections: brief.context.sections.map((section) => section.title) }
    }) ?? null;
    this.audit?.record({
      actor: "chief-of-staff",
      action: "engagement-opened",
      target: mission?.id ?? request.slice(0, 80),
      riskLevel: brief.intent.authority,
      result: "team=" + (team?.team?.id ?? "solo") + " steps=" + brief.plan.steps.length,
      mission: mission?.id ?? null,
      project: brief.project
    });
    this.eventBus?.emit("chief.engaged", { mission: mission?.id ?? null, team: team?.team?.id ?? null, domain: brief.domain });
    return { brief, team, mission, run };
  }

  /**
   * The session opener: the identity capsule plus what is waiting.
   */
  standup() {
    const capsule = this.owner.capsule({ budget: this.budgets.ownerCapsule ?? 800 });
    const missions = this.missions?.status() ?? null;
    const approvals = this.approvals?.pending() ?? [];
    const learning = this.learning?.status() ?? null;
    return {
      capsule,
      missions,
      pendingApprovals: approvals.map((approval) => ({ id: approval.id, action: approval.action, summary: approval.summary })),
      learning: learning ? { skills: learning.skills, candidates: learning.readyCandidates, episodes: learning.episodes.episodes } : null
    };
  }
}

export { OwnerModel, IntentEngine, TeamPlanner, ContextRouter };
