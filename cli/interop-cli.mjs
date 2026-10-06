import { readFileSync } from "node:fs";
import { parseArgs } from "../delivery-engine/cli.mjs";
import { detectRuntime } from "../interop-engine/interop-engine.mjs";
import { serveMcp } from "../interop-engine/mcp-server.mjs";

const out = (line) => console.log(line);

function splitList(value) {
  return value === undefined || value === true ? [] : String(value).split(";").map((entry) => entry.trim()).filter(Boolean);
}

function readHookPayload() {
  if (process.stdin.isTTY) {
    return {};
  }
  try {
    const text = readFileSync(0, "utf8").trim();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function describeEntry(entry) {
  const when = String(entry.at).slice(0, 16).replace("T", " ");
  if (entry.kind === "update") {
    return when + " AStack update " + (entry.from ?? "?") + " → " + (entry.to ?? "?") + " (" + (entry.ref ?? "-") + "): " + entry.result;
  }
  if (entry.kind === "handoff") {
    return when + " " + entry.runtime + " handoff: " + entry.summary + (entry.recommendedNextStep ? " → " + entry.recommendedNextStep : "");
  }
  const workspace = entry.workspace ? " " + (entry.workspace.branch ?? "?") + "@" + (entry.workspace.head ?? "?") + (entry.workspace.changedFiles ? " +" + entry.workspace.changedFiles : "") : "";
  return when + " " + entry.runtime + " " + entry.kind + workspace;
}

export async function runInteropCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "status", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const interop = runtime.interop;

  if (action === "status" || action === "doctor") {
    const status = interop.status();
    out(t("cli.interop.statusTitle"));
    out("- " + t("cli.interop.contract", { hash: status.contract.hash ?? "-", bytes: status.contract.bytes }));
    out("- " + t("cli.interop.memory", { path: status.sharedMemory }));
    out("- " + t("cli.interop.journal", { path: status.journal.path, entries: status.journal.entries }));
    const claude = status.runtimes["claude-code"];
    const codex = status.runtimes.codex;
    out("- Claude Code: " + t("cli.interop.runtimeLine", { instructions: claude.instructions ? "CLAUDE.md → @AGENTS.md" : "CLAUDE.md ✗", wired: claude.wired ? "✓" : "✗" }));
    out("    " + t("cli.interop.claudeMemory", { path: claude.privateMemory ?? "-" }));
    out("- Codex: " + t("cli.interop.runtimeLine", { instructions: codex.instructions ? "AGENTS.md" : "AGENTS.md ✗", wired: codex.wired ? "✓" : "✗" }));
    out("    " + t(codex.trust.trusted ? "cli.interop.codexTrusted" : codex.trust.installed ? "cli.interop.codexUntrusted" : "cli.interop.codexMissing", { key: codex.trust.key }));
    out("    " + t("cli.interop.codexHooks"));
    for (const [id, entry] of Object.entries(status.lastSeen)) {
      if (entry) {
        out("    " + t("cli.interop.lastSeen", { runtime: id, entry: describeEntry(entry) }));
      }
    }
    for (const entry of status.pending) {
      out("- " + t("cli.interop.pending", entry));
    }
    out(status.parity ? t("cli.interop.parityOk") : t("cli.interop.parityMissing"));
    if (action === "doctor" && !status.parity) {
      process.exitCode = 1;
    }
    return;
  }
  if (action === "sync") {
    const dryRun = Boolean(flags.dryRun);
    const result = interop.sync({ dryRun });
    out(t(dryRun ? "cli.interop.syncPlan" : "cli.interop.syncDone"));
    for (const entry of result) {
      out("- [" + entry.runtime + "] " + entry.path + ": " + entry.action);
    }
    if (flags.trustCodex && !dryRun) {
      const trust = interop.trustCodex();
      out(t(trust.changed ? "cli.interop.trustAdded" : "cli.interop.trustPresent", { key: trust.key, backup: trust.backup ?? "-" }));
    } else if (!interop.codexTrust().trusted) {
      out(t("cli.interop.trustHint"));
    }
    return;
  }
  if (action === "hook") {
    // A hook must never break the session that runs it: failures are reported
    // as context, and the process always exits cleanly.
    const event = positionals[0];
    const runtimeId = flags.runtime ? String(flags.runtime) : detectRuntime();
    const payload = readHookPayload();
    try {
      if (event === "session-start") {
        const result = interop.sessionStart({ runtime: runtimeId, payload });
        out(JSON.stringify(result.output));
      } else if (event === "session-end") {
        interop.sessionEnd({ runtime: runtimeId, payload });
      } else {
        throw new Error("unknown hook event: " + event);
      }
    } catch (error) {
      if (event === "session-start") {
        out(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "AStack shared brain unavailable: " + error.message } }));
      } else {
        console.error("astack interop hook: " + error.message);
      }
    }
    process.exitCode = 0;
    return;
  }
  if (action === "context") {
    out(interop.sessionContext({ runtime: flags.runtime ? String(flags.runtime) : detectRuntime() }));
    return;
  }
  if (action === "handoff") {
    const record = interop.handoff({
      runtime: flags.runtime ? String(flags.runtime) : detectRuntime(),
      summary: positionals.join(" "),
      done: flags.done ? String(flags.done) : "",
      findings: splitList(flags.findings),
      openQuestions: splitList(flags.open),
      next: flags.next ? String(flags.next) : "",
      artifacts: splitList(flags.artifacts),
      project: flags.project ? String(flags.project) : null
    });
    out(t("cli.interop.handoffSaved", { runtime: record.runtime, memory: record.memoryId ?? "-" }));
    return;
  }
  if (action === "journal") {
    const entries = interop.journal({ limit: Number(flags.limit ?? 10), runtime: flags.runtime ? String(flags.runtime) : null });
    out(t("cli.interop.journalTitle", { count: entries.length }));
    for (const entry of entries) {
      out("- " + describeEntry(entry));
    }
    return;
  }
  if (action === "import-claude-memory") {
    const report = interop.importClaudeMemory();
    out(report.directory ? t("cli.interop.imported", report) : t("cli.interop.noClaudeMemory"));
    return;
  }
  throw new Error(t("cli.interop.unknownAction", { action }));
}

export async function runMcpCommand({ i18n, tokens }) {
  const [action = "serve"] = tokens;
  if (action === "serve") {
    await serveMcp();
    return;
  }
  if (action === "tools") {
    const { mcpTools } = await import("../interop-engine/mcp-server.mjs");
    for (const tool of mcpTools) {
      out("- " + tool.name + ": " + tool.description);
    }
    return;
  }
  throw new Error(i18n.t("cli.interop.unknownAction", { action }));
}
