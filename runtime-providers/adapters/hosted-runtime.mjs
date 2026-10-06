import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRuntime } from "../agent-runtime.mjs";

/**
 * A runtime that executes inside an interactive agent session rather than a
 * spawned process: Claude Code or Codex hosting AStack.
 *
 * The adapter does not call a model. It writes the compact work order the
 * hosting session executes — objective, retrieved context, memory, selected
 * skills, tool catalog and authority ceiling — and tracks the session state
 * around it. Both hosted runtimes write the same work order format, so a
 * mission can move from one to the other without translation.
 */
export class HostedAgentRuntime extends AgentRuntime {
  /** The contract file the hosting runtime loads before any task. */
  get contractFile() {
    return "AGENTS.md";
  }

  workOrderPath(session) {
    return join(this.directory, "work-orders", session.id + ".md");
  }

  async run(sessionId) {
    const session = this.readSession(sessionId);
    const lines = [
      "# Work Order " + session.id,
      "",
      "- Runtime: " + this.id,
      "- Role: " + session.role,
      "- Mission: " + (session.mission ?? "-"),
      "- Issued: " + this.now(),
      "",
      "## Objective",
      session.objective,
      ""
    ];
    const brief = session.brief ?? {};
    if (brief.contextLines?.length) {
      lines.push("## Retrieved context (index only, expand before relying on it)");
      lines.push(...brief.contextLines);
      lines.push("");
    }
    if (brief.memoryLines?.length) {
      lines.push("## Memory");
      lines.push(...brief.memoryLines);
      lines.push("");
    }
    if (brief.skills?.length) {
      lines.push("## Skills to load");
      for (const skill of brief.skills) {
        lines.push("- " + skill.id + " (" + skill.status + ", conf " + skill.confidence + "): " + skill.path);
      }
      lines.push("");
    }
    if (brief.toolCatalog?.length) {
      lines.push("## Tool catalog (load full schema only for what you use)");
      lines.push(...brief.toolCatalog);
      lines.push("");
    }
    if (brief.authority) {
      lines.push("## Authority");
      lines.push("- ceiling: " + brief.authority.ceiling + " — " + brief.authority.meaning);
      lines.push("- approval required for: " + (brief.authority.requiresApproval ? "yes" : "no"));
      lines.push("");
    }
    lines.push("## Reporting");
    lines.push("Report with: astack mission report " + (session.mission ?? "<mission>") + " --summary \"...\"");
    lines.push("");
    const path = this.workOrderPath(session);
    mkdirSync(join(this.directory, "work-orders"), { recursive: true });
    writeFileSync(path, lines.join("\n"), "utf8");
    const updated = this.saveSession({
      ...session,
      state: "running",
      updatedAt: this.now(),
      workOrder: [".astack", "runtimes", this.id, "work-orders", session.id + ".md"].join("/"),
      steps: [...session.steps, { at: this.now(), event: "work-order-written", path }]
    });
    this.eventBus?.emit("runtime.workorder.written", { runtime: this.id, session: session.id, path: updated.workOrder });
    return updated;
  }

  ready() {
    return existsSync(join(this.root, this.contractFile));
  }
}
