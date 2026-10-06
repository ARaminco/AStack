import { HostedAgentRuntime } from "./hosted-runtime.mjs";

/**
 * Codex runtime adapter.
 *
 * Codex (CLI, IDE extension or desktop app) hosts AStack the same way Claude
 * Code does: it loads AGENTS.md, reaches the astack MCP server and receives the
 * shared-brain context from its session-start hook. This adapter writes the
 * same work order format as the Claude Code adapter, so a mission planned in
 * one runtime can be executed in the other.
 *
 * Unattended execution through `codex exec` is a different path: configure
 * runtime.providers.codex.command and the generic CLI adapter is used instead.
 */
export class CodexRuntime extends HostedAgentRuntime {
  constructor(options = {}) {
    super("codex", options);
  }

  describe() {
    return {
      id: this.id,
      name: "Codex",
      status: "implemented",
      capabilities: ["reasoning", "coding", "tool-use", "long-context", "file-edit"],
      strengths: ["software", "refactoring", "testing", "review"],
      contextWindow: 200000,
      costClass: "high",
      available: this.ready(),
      note: "Executes through the Codex session that hosts AStack (AGENTS.md); work orders are written to .astack/runtimes/codex."
    };
  }
}
