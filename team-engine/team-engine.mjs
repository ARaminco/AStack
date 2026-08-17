import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const teamStatuses = ["forming", "active", "paused", "disbanded"];

export class TeamEngine {
  constructor(root, { clock, eventBus, domains } = {}) {
    this.root = root;
    this.directory = join(root, ".astack", "teams");
    this.clock = clock ?? (() => new Date());
    this.eventBus = eventBus ?? null;
    this.domains = domains ?? null;
  }

  now() {
    return this.clock().toISOString();
  }

  list() {
    if (!existsSync(this.directory)) {
      return [];
    }
    return readdirSync(this.directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(this.directory, entry.name, "team.json")))
      .map((entry) => this.get(entry.name));
  }

  get(id) {
    const path = join(this.directory, id, "team.json");
    if (!existsSync(path)) {
      throw new Error("Unknown team: " + id);
    }
    return JSON.parse(readFileSync(path, "utf8"));
  }

  save(team) {
    const dir = join(this.directory, team.id);
    mkdirSync(dir, { recursive: true });
    team.updatedAt = this.now();
    writeFileSync(join(dir, "team.json"), JSON.stringify(team, null, 2) + "\n", "utf8");
    return team;
  }

  create({ name, domain, mission = "", project = null }) {
    if (!this.domains) {
      throw new Error("TeamEngine requires a domain registry to assemble teams");
    }
    const blueprint = this.domains.get(domain).blueprint;
    const id = this.uniqueSlug(name);
    const members = [
      { role: blueprint.lead.role, department: blueprint.lead.department, lead: true, agent: null },
      ...blueprint.members.map((member) => ({ role: member.role, department: member.department, lead: false, agent: null }))
    ];
    const team = {
      id,
      name,
      domain,
      mission,
      project,
      status: "forming",
      members,
      createdAt: this.now(),
      events: []
    };
    this.record(team, "team-created", { name, domain });
    this.save(team);
    this.eventBus?.emit("team.created", { teamId: id, domain });
    return team;
  }

  uniqueSlug(name) {
    const base = slug(name);
    if (!existsSync(join(this.directory, base, "team.json"))) {
      return base;
    }
    let counter = 2;
    while (existsSync(join(this.directory, base + "-" + counter, "team.json"))) {
      counter += 1;
    }
    return base + "-" + counter;
  }

  record(team, type, payload = {}) {
    team.events.push({ at: this.now(), type, ...payload });
  }

  addMember(id, { role, department, lead = false }) {
    const team = this.get(id);
    if (team.members.some((member) => member.role === role)) {
      throw new Error("Role already on team " + id + ": " + role);
    }
    const member = { role, department: department ?? null, lead, agent: null };
    team.members.push(member);
    this.record(team, "member-added", { role });
    this.save(team);
    return member;
  }

  removeMember(id, role) {
    const team = this.get(id);
    const index = team.members.findIndex((member) => member.role === role);
    if (index === -1) {
      throw new Error("Role not on team " + id + ": " + role);
    }
    const [removed] = team.members.splice(index, 1);
    this.record(team, "member-removed", { role });
    this.save(team);
    return removed;
  }

  linkAgent(id, role, agentId) {
    const team = this.get(id);
    const member = team.members.find((entry) => entry.role === role);
    if (!member) {
      throw new Error("Role not on team " + id + ": " + role);
    }
    member.agent = agentId;
    this.record(team, "agent-linked", { role, agentId });
    this.save(team);
    return member;
  }

  assignProject(id, projectId) {
    const team = this.get(id);
    team.project = projectId;
    this.record(team, "project-linked", { projectId });
    this.save(team);
    return team;
  }

  setStatus(id, status) {
    if (!teamStatuses.includes(status)) {
      throw new Error("Unknown team status: " + status + ". Use: " + teamStatuses.join(", "));
    }
    const team = this.get(id);
    team.status = status;
    this.record(team, "status-changed", { status });
    this.save(team);
    this.eventBus?.emit("team.status", { teamId: id, status });
    return team;
  }

  disband(id) {
    return this.setStatus(id, "disbanded");
  }

  roster(id) {
    const team = this.get(id);
    return team.members.map((member) => ({
      role: member.role,
      department: member.department,
      lead: member.lead,
      agent: member.agent
    }));
  }
}

function slug(name) {
  const value = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!value) {
    throw new Error("Team name must contain latin letters or digits");
  }
  return value;
}
