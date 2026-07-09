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

  select(intent) {
    const text = String(intent).toLowerCase();
    return this.list().find((workflow) => workflow.keywords.some((keyword) => text.includes(keyword))) ?? this.list()[0];
  }
}
