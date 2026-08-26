import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FacetMemory, memoryFacets } from "./facets.mjs";

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
    this.facets = new FacetMemory(root, { clock });
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
    return this.facets.stats();
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
    writeFileSync(target, markdown + "\n\n" + structured + "\n", "utf8");
    return target;
  }
}

export { memoryFacets };
