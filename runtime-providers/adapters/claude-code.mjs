import { HostedAgentRuntime } from "./hosted-runtime.mjs";

/**
 * Claude Code runtime adapter.
 *
 * AStack often runs inside Claude Code, so this adapter does not spawn a
 * model: it produces the execution package Claude Code consumes — a compact
 * work order with the objective, the retrieved context, the selected skill and
 * the tool budget — and tracks the session state around it. That is a real,
 * working integration path, not a stub, and it keeps the platform honest about
 * who executes the turn.
 */
export class ClaudeCodeRuntime extends HostedAgentRuntime {
  constructor(options = {}) {
    super("claude-code", options);
  }

  get contractFile() {
    return "CLAUDE.md";
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
}
