import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "../../lib/text.mjs";
import { AgentRuntime } from "../agent-runtime.mjs";

/**
 * Generic CLI runtime adapter.
 *
 * Any agent runtime that can be driven from a command line — a coding agent, a
 * local model wrapper, a self hosted service client — becomes an AStack runtime
 * by declaring its command template in the provider manifest. The prompt is
 * written to a file and passed as an argument, so nothing sensitive ends up in
 * a process listing, and execution is gated by the automation policy.
 */
export class CliRuntime extends AgentRuntime {
  constructor(id, options = {}) {
    super(id, options);
    this.command = options.config?.command ?? null;
    this.args = options.config?.args ?? ["--prompt-file", "{promptFile}"];
    this.policy = options.policy ?? null;
    this.timeoutMs = options.config?.timeoutMs ?? 600000;
    this.label = options.config?.name ?? id;
  }

  describe() {
    const verdict = this.command && this.policy ? this.policy.allowCommand(this.command) : { allowed: Boolean(this.command) };
    return {
      id: this.id,
      name: this.label,
      status: this.command ? "experimental" : "adapter-ready",
      capabilities: this.config?.capabilities ?? ["reasoning", "tool-use"],
      strengths: this.config?.strengths ?? [],
      contextWindow: this.config?.contextWindow ?? null,
      costClass: this.config?.costClass ?? "medium",
      available: Boolean(this.command) && verdict.allowed,
      note: this.command
        ? "Runs `" + this.command + "` for each session; allowlist it in the automation policy to enable."
        : "Set runtime.providers." + this.id + ".command in astack.config.yaml to enable this runtime."
    };
  }

  promptPath(session) {
    return join(this.directory, "prompts", session.id + ".md");
  }

  buildPrompt(session) {
    const brief = session.brief ?? {};
    return [
      "# AStack mission brief",
      "",
      "Role: " + session.role,
      "Objective: " + session.objective,
      "",
      ...(brief.contextLines ?? []),
      ...(brief.memoryLines ?? []),
      "",
      "Report a short structured result: what was done, findings, artifacts, open questions, recommended next step."
    ].join("\n");
  }

  async run(sessionId) {
    const session = this.readSession(sessionId);
    if (!this.command) {
      return this.saveSession({
        ...session,
        state: "failed",
        updatedAt: this.now(),
        report: { summary: "runtime " + this.id + " has no command configured", outcome: "failed", at: this.now() }
      });
    }
    const verdict = this.policy?.allowCommand(this.command) ?? { allowed: true };
    if (!verdict.allowed) {
      return this.saveSession({
        ...session,
        state: "failed",
        updatedAt: this.now(),
        report: { summary: "blocked by automation policy: " + verdict.reason, outcome: "failed", at: this.now() }
      });
    }
    const promptFile = this.promptPath(session);
    mkdirSync(join(this.directory, "prompts"), { recursive: true });
    writeFileSync(promptFile, this.buildPrompt(session), "utf8");
    const args = this.args.map((argument) => String(argument).replace("{promptFile}", promptFile).replace("{objective}", session.objective));
    const started = Date.now();
    const output = await new Promise((resolve) => {
      execFile(this.command, args, { cwd: this.root, timeout: this.timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        resolve({ error, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      });
    });
    const durationMs = Date.now() - started;
    if (output.error) {
      return this.saveSession({
        ...session,
        state: "failed",
        updatedAt: this.now(),
        report: { summary: redactSecrets(output.error.message).slice(0, 400), outcome: "failed", at: this.now() },
        metrics: { ...session.metrics, turns: session.metrics.turns + 1, durationMs: session.metrics.durationMs + durationMs }
      });
    }
    return this.report(sessionId, {
      summary: redactSecrets(output.stdout).slice(-4000),
      durationMs,
      outcome: "done"
    });
  }
}
