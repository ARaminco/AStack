import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export class ConfigurationEngine {
  constructor(root) {
    this.root = root;
    this.path = join(root, "astack.config.yaml");
  }

  readText() {
    if (!existsSync(this.path)) {
      throw new Error("astack.config.yaml is missing");
    }
    return readFileSync(this.path, "utf8");
  }

  requireSections(sections) {
    const text = this.readText();
    const missing = sections.filter((section) => !text.includes(section + ":"));
    return { ok: missing.length === 0, missing };
  }
}
