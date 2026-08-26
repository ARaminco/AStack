const TOKENS_PER_AGENT = 12000;

const SPECIALIST_BY_NEED = {
  browse: { role: "browser-operator", department: "operations", reason: "the task reaches an external site" },
  "form-fill": { role: "browser-operator", department: "operations", reason: "a form must be completed on a portal" },
  extract: { role: "document-analyst", department: "documentation", reason: "documents must be read and structured" },
  map: { role: "principal-architect", department: "architecture", reason: "the change touches the codebase structure" },
  schedule: { role: "operations-engineer", department: "operations", reason: "the work must keep running in the background" }
};

/**
 * Just in time team formation.
 *
 * The default is one agent. Each additional seat has to earn itself: a
 * capability the current team does not have, a review the risk level demands,
 * or a workload the complexity justifies. Every seat carries an estimated token
 * cost so the owner can see what the team costs before it is formed.
 */
export class TeamPlanner {
  constructor({ domains = null, teams = null, agents = null, performance = null } = {}) {
    this.domains = domains;
    this.teams = teams;
    this.agents = agents;
    this.performance = performance;
  }

  blueprint(domainId) {
    try {
      return this.domains?.get(domainId)?.blueprint ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Decide the smallest team that can deliver the intent.
   */
  plan(intent, { maxAgents = 6, forceTeam = false } = {}) {
    const domainId = intent.domain ?? "business";
    const blueprint = this.blueprint(domainId);
    const seats = [];
    const rationale = [];
    const lead = blueprint?.lead ?? { role: "program-manager", department: "delivery" };
    const analystRole = blueprint?.members?.[0] ?? { role: "analyst", department: "research" };

    if (intent.complexity < 0.3 && !forceTeam && !intent.externalAction) {
      seats.push({ ...analystRole, purpose: "answer the request end to end", primary: true });
      rationale.push("درخواست ساده است؛ یک متخصص کافی است.");
    } else {
      seats.push({ ...lead, purpose: "own the outcome and review the result", primary: true, lead: true });
      rationale.push("کار چند مرحله‌ای است؛ یک راهبر برای بازبینی خروجی لازم است.");
      seats.push({ ...analystRole, purpose: "do the core work of the domain" });
    }

    for (const need of intent.needs ?? []) {
      const specialist = SPECIALIST_BY_NEED[need];
      if (!specialist) {
        continue;
      }
      const unavoidable = ["browse", "form-fill"].includes(need);
      if (!unavoidable && intent.complexity < 0.3) {
        continue;
      }
      if (seats.some((seat) => seat.role === specialist.role)) {
        continue;
      }
      if (seats.length >= maxAgents) {
        break;
      }
      seats.push({ role: specialist.role, department: specialist.department, purpose: specialist.reason });
      rationale.push("افزودن " + specialist.role + ": " + specialist.reason);
    }

    if (["L4"].includes(intent.authority) && seats.length < maxAgents && !seats.some((seat) => /review|compliance|counsel/.test(seat.role))) {
      const reviewer = blueprint?.members?.find((member) => /review|counsel|audit|qa|compliance/.test(member.role))
        ?? { role: "compliance-reviewer", department: "legal" };
      seats.push({ ...reviewer, purpose: "verify before an irreversible action" });
      rationale.push("اقدام غیرقابل‌بازگشت است؛ یک بازبین قبل از ثبت اضافه شد.");
    }

    if (intent.complexity > 0.75 && blueprint?.members?.length && seats.length < maxAgents) {
      for (const member of blueprint.members) {
        if (seats.length >= maxAgents) {
          break;
        }
        if (!seats.some((seat) => seat.role === member.role)) {
          seats.push({ ...member, purpose: "specialist depth for a complex engagement" });
        }
      }
      rationale.push("پیچیدگی بالاست؛ تیم تا اندازه نقشه دامنه گسترش یافت.");
    }

    const estimatedTokens = seats.length * Math.round(TOKENS_PER_AGENT * (0.6 + intent.complexity));
    return {
      domain: domainId,
      size: seats.length,
      seats: seats.map((seat, index) => ({
        order: index + 1,
        role: seat.role,
        department: seat.department ?? null,
        lead: Boolean(seat.lead),
        purpose: seat.purpose,
        historicalReliability: this.reliability(seat.role)
      })),
      estimatedTokens,
      estimatedCostClass: estimatedTokens > 90000 ? "high" : estimatedTokens > 40000 ? "medium" : "low",
      rationale
    };
  }

  reliability(role) {
    const stats = this.performance?.[role];
    if (!stats) {
      return null;
    }
    return { runs: stats.runs, successRate: stats.successRate };
  }

  /**
   * Materialize the plan as a real team with one agent per seat.
   */
  form(plan, { goal, name = null }) {
    if (!this.teams || !this.agents) {
      throw new Error("Team formation needs the team and agent engines");
    }
    const team = this.teams.create({
      name: name ?? plan.domain + "-jit-team",
      domain: plan.domain,
      mission: goal
    });
    const created = [];
    for (const seat of plan.seats) {
      if (!team.members.some((member) => member.role === seat.role)) {
        this.teams.addMember(team.id, { role: seat.role, department: seat.department, lead: seat.lead });
      }
      const agent = this.agents.create({
        name: seat.role + "-" + team.id,
        role: seat.role,
        department: seat.department,
        team: team.id,
        mission: goal + " — " + seat.purpose
      });
      this.teams.linkAgent(team.id, seat.role, agent.id);
      created.push(agent);
    }
    for (const member of this.teams.get(team.id).members) {
      if (!member.agent) {
        this.teams.removeMember(team.id, member.role);
      }
    }
    this.teams.setStatus(team.id, "active");
    return { team: this.teams.get(team.id), agents: created };
  }
}

export { TOKENS_PER_AGENT, SPECIALIST_BY_NEED };
