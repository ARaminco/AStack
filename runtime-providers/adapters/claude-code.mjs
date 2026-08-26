import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRuntime } from "../agent-runtime.mjs";

/**
 * Claude Code runtime adapter.
 *
 * AStack normally runs inside Claude Code, so this adapter does not spawn a
 * model: it produces the execution package Claude Code consumes — a compact
 * work order with the objective, the retrieved context, the selected skill and
 * the tool budget — and tracks the session state around it. That is a real,
 * working integration path, not a stub, and it keeps the platform honest about
 * who executes the turn.
 */
export class ClaudeCodeRuntime extends AgentRuntime {
  constructor(options = {}) {
    super("claude-code", options);
  }

  describe() {
    return {
      id: this.id,
      name: "Claude Code",
      status: "implemented",
      capabilities: ["reasoning", "coding", "tool-use", "long-context", "file-edit"],
      strengths: ["software", "analysis", "documentation", "review"],
      contextWindow: 200000,
      costClass: "high",
      available: true,
      note: "Executes through the Claude Code session that hosts AStack; work orders are written to .astack/runtimes/claude-code."
    };
  }

  workOrderPath(session) {
    return join(this.directory, "work-orders", session.id + ".md");
  }

  async run(sessionId) {
    const session = this.readSession(sessionId);
    const lines = [
      "# Work Order " + session.id,
      "",
      "- Runtime: claude-code",
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
    return existsSync(join(this.root, "CLAUDE.md"));
  }
}
