import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export class ProviderRegistry {
  constructor(root) {
    this.root = root;
    this.directory = join(root, "providers");
  }

  list() {
    if (!existsSync(this.directory)) {
      return [];
    }
    return readdirSync(this.directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const manifestPath = join(this.directory, entry.name, "manifest.json");
        const pluginPath = join(this.directory, entry.name, "plugin.json");
        const path = existsSync(manifestPath) ? manifestPath : pluginPath;
        return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { id: entry.name };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  find(id) {
    return this.list().find((item) => item.id === id);
  }
}
