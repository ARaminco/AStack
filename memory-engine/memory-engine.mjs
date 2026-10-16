import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryBlocks } from "./blocks.mjs";
import { FacetMemory, memoryFacets } from "./facets.mjs";
import { reflect } from "./reflect.mjs";

const scopes = [
  "global",
  "project",
  "department",
  "role",
  "team",
  "agent",
  "decision",
  "coding-standards",
  "architecture",
  "business",
  "user-preferences"
];

export class MemoryEngine {
  constructor(root, { clock } = {}) {
    this.root = root;
    this.directory = join(root, "memory");
    this.clock = clock ?? (() => new Date());
    this.facets = new FacetMemory(root, { clock });
    this.blocks = new MemoryBlocks(root, { clock, facets: this.facets });
  }

  /**
   * The scopes of one engagement, broadest first: the owner, then the project
   * and case being worked on, then the agent doing the work.
   */
  engagementScopes({ agent = null, project = null, caseId = null, role = null, team = null, scopes = [] } = {}) {
    const list = ["owner", "system"];
    if (project) {
      list.push("project:" + project);
    }
    if (caseId) {
      list.push(String(caseId).startsWith("case:") ? String(caseId) : "case:" + caseId);
    }
    if (team) {
      list.push("team:" + team);
    }
    if (role) {
      list.push("role:" + role);
    }
    if (agent) {
      list.push("agent:" + agent);
    }
    return [...new Set([...list, ...scopes])].filter((scope) => MemoryBlocks.validScope(scope));
  }

  /**
   * Active memory for an engagement: the blocks always in context, inside a
   * token budget.
   */
  active(options = {}) {
    return this.blocks.render({ scopes: this.engagementScopes(options), budget: options.budget ?? 1200 });
  }

  /**
   * Long-term recall limited to one task: what belongs to its project, case
   * or entities plus general knowledge.
   */
  scopedRecall({ query = "", project = null, caseId = null, entities = [], limit = 10, ...rest } = {}) {
    const scope = [
      ...(project ? ["project:" + project] : []),
      ...(caseId ? [String(caseId).startsWith("case:") ? String(caseId) : "case:" + caseId] : []),
      ...entities
    ];
    return this.facets.recall({ query, project, scope: scope.length ? scope : null, limit, ...rest });
  }

  reflect(options = {}) {
    return reflect({ facets: this.facets, blocks: this.blocks, clock: this.clock, ...options });
  }

  /**
   * Give an agent a persona and goals that survive across missions. Existing
   * blocks are kept; only the goals follow a new mission.
   */
  seedAgent(agent, { source = "agent-engine" } = {}) {
    if (!agent?.id || !MemoryBlocks.validScope("agent:" + agent.id)) {
      return null;
    }
    const persona = "agent:" + agent.id + "/persona";
    const goals = "agent:" + agent.id + "/goals";
    try {
      if (!this.blocks.get(persona)) {
        const lines = [
          "Role: " + agent.role + (agent.department ? " (" + agent.department + ")" : ""),
          agent.team ? "Team: " + agent.team + " — coordinate only through the lead and the Chief of Staff, never directly." : null,
          "Owner-facing language: Persian; code and assets: English.",
          "Stop before anything irreversible and ask for approval."
        ].filter(Boolean);
        this.blocks.set(persona, lines.join("\n"), { limit: 800, description: "Who this agent is; stable across missions.", source });
      }
      if (agent.mission) {
        this.blocks.set(goals, "Current mission: " + String(agent.mission).slice(0, 600), { limit: 1000, description: "What this agent is working toward now.", source });
      }
    } catch {
      // Active memory is a convenience for the agent; a refused value (a
      // secret-shaped mission text) must never stop the agent from existing.
      return null;
    }
    return { persona, goals };
  }

  scopes() {
    return scopes;
  }

  facetNames() {
    return memoryFacets;
  }

  read(scope) {
    if (!scopes.includes(scope)) {
      throw new Error("Unknown memory scope: " + scope);
    }
    const path = join(this.directory, scope + ".md");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  append(scope, entry) {
    if (!scopes.includes(scope)) {
      throw new Error("Unknown memory scope: " + scope);
    }
    mkdirSync(this.directory, { recursive: true });
    const path = join(this.directory, scope + ".md");
    const current = existsSync(path) ? readFileSync(path, "utf8") : "# " + scope + "\n";
    writeFileSync(path, current.trimEnd() + "\n\n- " + entry + "\n", "utf8");
    return path;
  }

  /**
   * Write into a structured facet and mirror a one line trace into the owner
   * facing markdown scope so both surfaces stay in sync.
   */
  remember(facet, entry = {}) {
    const record = this.facets.append(facet, entry);
    if (entry.scope && scopes.includes(entry.scope)) {
      this.append(entry.scope, "[" + facet + "] " + record.title + (record.body ? " — " + record.body.split(/\r?\n/)[0] : ""));
    }
    return record;
  }

  recall(options = {}) {
    return this.facets.recall(options);
  }

  brief(options = {}) {
    return this.facets.brief(options);
  }

  reinforce(id, options = {}) {
    return this.facets.reinforce(id, options);
  }

  forget(id) {
    return this.facets.forget(id);
  }

  consolidate(options = {}) {
    return this.facets.consolidate(options);
  }

  stats() {
    return { ...this.facets.stats(), active: this.blocks.stats() };
  }

  backup() {
    mkdirSync(join(this.root, ".astack", "backups"), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = join(this.root, ".astack", "backups", "memory-" + stamp + ".md");
    const markdown = scopes.map((scope) => "## " + scope + "\n" + this.read(scope)).join("\n\n");
    const structured = memoryFacets
      .map((facet) => {
        const records = this.facets.all(facet);
        const lines = records.map((record) => "- " + record.id + " | " + record.title + (record.body ? " | " + record.body.split(/\r?\n/)[0] : ""));
        return "## facet:" + facet + " (" + records.length + ")\n" + lines.join("\n");
      })
      .join("\n\n");
    const active = this.blocks
      .list()
      .map((block) => "## block:" + block.id + " (v" + block.version + ")\n" + block.value)
      .join("\n\n");
    writeFileSync(target, markdown + "\n\n" + structured + "\n" + (active ? "\n" + active + "\n" : ""), "utf8");
    return target;
  }
}

export { memoryFacets };
