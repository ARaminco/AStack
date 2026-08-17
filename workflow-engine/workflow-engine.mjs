import { readFileSync } from "node:fs";
import { join } from "node:path";

export class WorkflowEngine {
  constructor(root) {
    this.root = root;
    this.manifest = JSON.parse(readFileSync(join(root, "workflow-engine", "workflows.json"), "utf8"));
  }

  list() {
    return this.manifest.workflows;
  }

  byId(id) {
    const workflow = this.list().find((entry) => entry.id === id);
    if (!workflow) {
      throw new Error("Unknown workflow: " + id);
    }
    return workflow;
  }

  selectStrict(intent) {
    const text = String(intent).toLowerCase();
    let best = null;
    let bestScore = 0;
    for (const workflow of this.list()) {
      const score = workflow.keywords.reduce((sum, keyword) => {
        const needle = keyword.toLowerCase();
        return sum + (text.includes(needle) ? (needle.length > 3 ? 2 : 1) : 0);
      }, 0);
      if (score > bestScore) {
        best = workflow;
        bestScore = score;
      }
    }
    return best;
  }

  select(intent) {
    return this.selectStrict(intent) ?? this.list()[0];
  }
}
