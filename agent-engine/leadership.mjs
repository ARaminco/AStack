export class Leadership {
  constructor({ domains, teams, agents, projects, clock } = {}) {
    if (!domains || !teams || !agents) {
      throw new Error("Leadership requires domains, teams, and agents engines");
    }
    this.domains = domains;
    this.teams = teams;
    this.agents = agents;
    this.projects = projects ?? null;
    this.clock = clock ?? (() => new Date());
  }

  propose(goal) {
    const domain = this.domains.detect(goal) ?? this.domains.get("business");
    return {
      goal,
      domain: { id: domain.id, name: domain.name, nameFa: domain.nameFa },
      workflow: domain.workflow,
      deliverables: domain.deliverables ?? [],
      team: {
        lead: domain.blueprint.lead,
        members: domain.blueprint.members
      }
    };
  }

  formTeam(goal, { name = null, domain = null } = {}) {
    const proposal = domain
      ? { domain: { id: domain }, goal }
      : this.propose(goal);
    const domainId = proposal.domain.id;
    const team = this.teams.create({
      name: name ?? domainId + " team",
      domain: domainId,
      mission: goal
    });
    const created = [];
    for (const member of team.members) {
      const agent = this.agents.create({
        name: member.role + "-" + team.id,
        role: member.role,
        department: member.department,
        team: team.id,
        mission: goal
      });
      this.teams.linkAgent(team.id, member.role, agent.id);
      created.push(agent);
    }
    this.teams.setStatus(team.id, "active");
    return { team: this.teams.get(team.id), agents: created };
  }

  delegate({ projectId, teamId, every = null }) {
    if (!this.projects) {
      throw new Error("Leadership requires a project engine to delegate project work");
    }
    const project = this.projects.get(projectId);
    const team = this.teams.get(teamId);
    const byDepartment = new Map();
    for (const member of team.members) {
      if (member.agent && member.department) {
        const pool = byDepartment.get(member.department) ?? { agents: [], cursor: 0 };
        pool.agents.push(member.agent);
        byDepartment.set(member.department, pool);
      }
    }
    const pickFrom = (pool) => {
      const agentId = pool.agents[pool.cursor % pool.agents.length];
      pool.cursor += 1;
      return agentId;
    };
    const fallback = team.members.find((member) => member.lead && member.agent)?.agent
      ?? team.members.find((member) => member.agent)?.agent
      ?? null;
    const delegated = [];
    const candidates = project.workItems.filter(
      (item) => ["backlog", "ready"].includes(item.status) && item.type !== "epic"
    );
    for (const item of candidates) {
      const pool = item.department ? byDepartment.get(item.department) : null;
      const agentId = (pool ? pickFrom(pool) : null) ?? fallback;
      if (!agentId) {
        continue;
      }
      const assignment = this.agents.assign(agentId, {
        objective: "[" + project.id + " " + item.id + "] " + item.title,
        deliverable: "Finish " + item.id + " and move it to done on the " + project.id + " board",
        every,
        priority: item.moscow === "must" ? "high" : "normal"
      });
      delegated.push({ agentId, assignmentId: assignment.id, itemId: item.id });
    }
    this.teams.assignProject(teamId, projectId);
    return delegated;
  }

  standup({ asOf } = {}) {
    const teams = this.teams.list().filter((team) => team.status !== "disbanded");
    const agents = this.agents.standup({ asOf });
    return {
      teams: teams.map((team) => ({
        id: team.id,
        name: team.name,
        domain: team.domain,
        status: team.status,
        project: team.project,
        members: team.members.length
      })),
      agents,
      due: this.agents.due({ asOf }).length,
      awaitingReview: this.agents.openRuns().length
    };
  }

  reviewQueue() {
    return this.agents.openRuns().map(({ agent, assignment, run }) => ({
      agentId: agent.id,
      role: agent.role,
      team: agent.team,
      assignmentId: assignment.id,
      runId: run.id,
      objective: assignment.objective,
      workOrder: run.workOrder,
      since: run.startedAt
    }));
  }
}
