import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appendLedger, economyDirectory, readEconomyConfig, tail } from "./storage.mjs";
import { Limits } from "./limits.mjs";
import { LiveRegistry } from "./live.mjs";
import { DEFAULT_ROUTES, decideRoute } from "./policy.mjs";

const hookContext = (event, additionalContext) => ({ hookSpecificOutput: { hookEventName: event, additionalContext } });
const permission = (decision, reason, updatedInput) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason, ...(updatedInput ? { updatedInput } : {}) } });

export function transcriptContext(path) {
  const lines = tail(path, 512 * 1024).split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].includes('"output_tokens"')) {
      continue;
    }
    try {
      const usage = JSON.parse(lines[index]).message?.usage;
      if (usage) {
        return ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].reduce((sum, key) => sum + (Number(usage[key]) || 0), 0);
      }
    } catch {
      // Partial or oversized records in the tail are skipped.
    }
  }
  return 0;
}

export function subagentTranscript(input) {
  if (!input.transcript_path) {
    return null;
  }
  if (/[\\/]subagents[\\/]/.test(input.transcript_path)) {
    return existsSync(input.transcript_path) ? input.transcript_path : null;
  }
  if (!/^[\w-]+$/.test(input.agent_id ?? "") || !/^[\w-]+$/.test(input.session_id ?? "")) {
    return null;
  }
  const path = join(dirname(input.transcript_path), input.session_id, "subagents", "agent-" + input.agent_id + ".jsonl");
  return existsSync(path) ? path : null;
}

export class EconomyEngine {
  constructor({ root = process.cwd(), home = homedir(), directory = economyDirectory(home), config = readEconomyConfig(root), clock = () => Date.now() } = {}) {
    Object.assign(this, { root, home, directory, config, clock });
    this.limits = new Limits({ directory, config, clock });
    this.live = new LiveRegistry({ directory, clock });
  }

  decision(input, running = 0) {
    const pressure = this.limits.pressure().pressure;
    const request = input.tool_input ?? input;
    const cachedModel = this.limits.read().sessions?.[input.session_id]?.model;
    let frontmatterModel = null;
    if (/^[\w-]+$/.test(request.subagent_type ?? "")) {
      for (const root of [this.root, this.home]) {
        const path = join(root, ".claude", "agents", request.subagent_type + ".md");
        if (existsSync(path)) {
          frontmatterModel = readFileSync(path, "utf8").slice(0, 4096).match(/^model:\s*([^\s#]+)/m)?.[1]?.replace(/^["']|["']$/g, "");
          break;
        }
      }
    }
    const inherited = frontmatterModel && frontmatterModel !== "inherit" ? frontmatterModel : process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? this.config.default_subagent_model ?? (typeof cachedModel === "string" ? cachedModel : cachedModel?.id) ?? "sonnet";
    return decideRoute(request, { pressure, config: this.config, running, inheritedModel: inherited });
  }

  route(input) {
    const request = input?.tool_input;
    if (this.config.enabled === false || !["Agent", "Task"].includes(input?.tool_name) || !request || typeof request.prompt !== "string" || typeof request.subagent_type !== "string" || typeof request.description !== "string") {
      return null;
    }
    const running = Object.keys(this.live.read()[input.session_id] ?? {}).length;
    const decision = this.decision(input, running);
    if (!decision.denied) {
      decision.denied = !this.live.rememberRoute(input, decision);
    }
    appendLedger(this.directory, { kind: "route", session: input.session_id, agent: input.agent_id, ...decision });
    if (decision.denied) {
      return permission("deny", "سقف عامل‌های هم‌زمان پر است؛ منتظر پایان یک عامل بمانید، کارها را ادغام کنید یا به Codex بسپارید. Parallel cap " + decision.cap + " reached. Wait for a running agent, merge tasks, or use astack_delegate / astack delegate for Codex.");
    }
    const brief = "[AStack economy] Token budget: " + decision.budget + ". Stop and report immediately when told. Read large files/pages once in one-shot calls; never accumulate images. Delegate bulk build/read/test work to Codex via astack_delegate; review its result.";
    return permission("allow", decision.reason + (decision.delegate ? "; delegate build/bulk-read to Codex when available" : ""), { ...request, model: decision.model, prompt: brief + "\n\n" + request.prompt });
  }

  guardTool(input) {
    if (this.config.enabled === false || !input.agent_id) {
      return null;
    }
    // Past the budget the agent may still write its result (an output file, a todo update); it may not read more.
    if (/^(Write|Edit|MultiEdit|NotebookEdit|TodoWrite)$/.test(String(input.tool_name ?? ""))) {
      return null;
    }
    const context = transcriptContext(subagentTranscript(input));
    const { budget } = this.decision({ subagent_type: input.agent_type });
    return context >= budget ? permission("deny", "Context budget reached (" + Math.round(context / 1000) + " k tokens). Do not read or search any more. Write your result now (an output file if your task asks for one), then reply with it in the requested format; the lead will start a fresh agent for anything left.") : null;
  }

  onSubagentStart(input) {
    if (this.config.enabled === false) {
      return null;
    }
    const decision = this.decision({ ...input, subagent_type: input.agent_type });
    this.live.start(input, decision.model);
    return hookContext("SubagentStart", "AStack economy: context budget " + decision.budget + " tokens. Stop and report when told; read pages once; delegate bulk work to Codex.");
  }

  onSubagentStop(input) {
    this.live.stop(input);
    return null;
  }

  onPrompt(input) {
    if (this.config.enabled === false) {
      return null;
    }
    const pressure = this.limits.pressure();
    const cached = this.limits.read().sessions?.[input.session_id];
    const context = cached && this.clock() - cached.capturedAt <= 1800000
      ? cached.context?.total_input_tokens ?? transcriptContext(input.transcript_path) : transcriptContext(input.transcript_path);
    if (["amber", "red", "critical"].includes(pressure.pressure) || context > (this.config.main_context_threshold ?? 250000)) {
      return hookContext("UserPromptSubmit", "AStack economy: 5h " + (pressure.fiveHour ?? "unknown") + "%, 7d " + (pressure.weekly ?? "unknown") + "%, pressure " + pressure.pressure + ", context " + context + ". Use cheaper models / Codex, keep parallel work within the cap, and suggest /compact to the owner.");
    }
    return null;
  }

  statusline(input, { chain = this.config.statusline?.chain, run = spawnSync, raw = JSON.stringify(input) } = {}) {
    this.limits.capture(input);
    if (chain) {
      const command = typeof chain === "string" ? chain : chain.command;
      if (command && !command.includes("astack-economy-hook.mjs")) {
        const result = run(command, { shell: true, input: raw, encoding: "utf8", windowsHide: true, timeout: 2000, cwd: this.root });
        if (!result.error && result.status === 0) {
          return result.stdout ?? "";
        }
      }
    }
    const pressure = this.limits.pressure();
    return [typeof input.model === "string" ? input.model : input.model?.display_name ?? input.model?.id ?? "-", "ctx " + (input.context_window?.used_percentage ?? "?") + "%", "5h " + (pressure.fiveHour ?? "?") + "%", "7d " + (pressure.weekly ?? "?") + "%", pressure.pressure].join(" · ");
  }

  async status({ since = null, probes = true } = {}) {
    const { UsageMeter } = await import("./usage-meter.mjs");
    const { codexAvailability, localModels } = await import("./delegate.mjs");
    const weeklyReset = this.limits.read().claude?.rate_limits?.seven_day?.resets_at;
    const start = since ?? (weeklyReset ? new Date((weeklyReset * 1000) - 7 * 86400000) : new Date(this.clock() - 86400000));
    const usage = await new UsageMeter({ home: this.home, directory: this.directory, config: this.config, clock: this.clock }).snapshot({ since: start });
    this.limits.captureCodex(usage.codex);
    const [codex, local] = probes ? await Promise.all([
      codexAvailability({ home: this.home, directory: this.directory, cwd: this.root }), localModels({ config: this.config })
    ]) : [null, []];
    return { enabled: this.config.enabled !== false, ...usage, limits: this.limits.pressure(usage), codex: { ...usage.codex, ...codex }, local, routes: Object.fromEntries(Object.keys(DEFAULT_ROUTES).map((job) => [job, decideRoute({ subagent_type: job === "bulk-read" ? "paralegal" : job, prompt: job, model: "opus" }, { pressure: this.limits.pressure(usage).pressure, config: this.config }).model])) };
  }
}

export function renderStatus(report, i18n) {
  const t = i18n.t.bind(i18n);
  const limits = report.limits;
  const lines = [t("cli.economy.status", {
    state: t("cli.economy." + (report.enabled ? "on" : "off")), five: limits.fiveHour?.toFixed(1) ?? "?", week: limits.weekly?.toFixed(1) ?? "?",
    source: t("cli.economy." + limits.source), age: limits.ageMs === null ? "-" : Math.round(limits.ageMs / 60000), pressure: t("cli.economy." + limits.pressure), burn: Math.round(report.burnRate)
  })];
  for (const consumer of report.topConsumers.slice(0, 8)) {
    lines.push("- " + (consumer.title ?? consumer.id) + ": " + Math.round(consumer.units) + " (" + consumer.share.toFixed(1) + "%)");
  }
  lines.push(t("cli.economy.live", { count: Object.values(report.live).reduce((sum, agents) => sum + Object.keys(agents).length, 0) }));
  for (const [session, agents] of Object.entries(report.live)) {
    for (const [id, agent] of Object.entries(agents)) {
      lines.push("- " + session + "/" + id + " · " + (agent.type ?? "-") + " · " + (agent.model ?? "-") + " · " + new Date(agent.startedAt).toISOString());
    }
  }
  lines.push(t("cli.economy.codex", { percent: report.codex.rate_limits?.primary?.used_percent ?? "?", available: t("cli.economy." + (typeof report.codex.available !== "boolean" ? "notChecked" : report.codex.available ? "available" : "unavailable")) }));
  lines.push(t("cli.economy.local", { models: report.local.join(", ") || "-" }));
  lines.push(t("cli.economy.routes", { routes: Object.entries(report.routes).map(([job, model]) => job + "→" + model).join(", ") }));
  return lines.join("\n");
}
