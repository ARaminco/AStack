import { readFileSync } from "node:fs";
import { join } from "node:path";

export class DomainRegistry {
  constructor(root) {
    this.root = root;
    this.manifest = JSON.parse(readFileSync(join(root, "domains", "domains.json"), "utf8"));
  }

  list() {
    return this.manifest.domains;
  }

  get(id) {
    const domain = this.list().find((entry) => entry.id === id);
    if (!domain) {
      throw new Error("Unknown domain: " + id + ". Available: " + this.list().map((entry) => entry.id).join(", "));
    }
    return domain;
  }

  detect(text) {
    const haystack = String(text || "").toLowerCase();
    if (!haystack.trim()) {
      return null;
    }
    const scored = this.list()
      .map((domain) => ({
        domain,
        score: domain.keywords.reduce((sum, keyword) => {
          const needle = keyword.toLowerCase();
          return sum + (haystack.includes(needle) ? (needle.length > 3 ? 2 : 1) : 0);
        }, 0)
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.domain.id.localeCompare(b.domain.id));
    return scored.length ? { ...scored[0].domain, confidence: scored[0].score } : null;
  }
}
