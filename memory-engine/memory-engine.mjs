import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";

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
  constructor(root) {
    this.root = root;
    this.directory = join(root, "memory");
  }

  scopes() {
    return scopes;
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

  backup() {
    mkdirSync(join(this.root, ".astack", "backups"), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = join(this.root, ".astack", "backups", "memory-" + stamp + ".md");
    const content = scopes.map((scope) => "## " + scope + "\n" + this.read(scope)).join("\n\n");
    writeFileSync(target, content, "utf8");
    return target;
  }
}
