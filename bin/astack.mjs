#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalization } from "../localization-engine/service.mjs";
import { createRuntime } from "../runtime/astack-runtime.mjs";
import { runProjectCommand } from "../delivery-engine/cli.mjs";
import { runAgentCommand, runDomainCommand, runLeadCommand, runTeamCommand } from "../cli/orchestration-cli.mjs";
import { runContextCommand, runGraphCommand, runLearningCommand, runMemoryCommand, runSkillCommand } from "../cli/intelligence-cli.mjs";
import { runBrowserCommand, runMissionCommand, runScheduleCommand, runSignalCommand } from "../cli/operations-cli.mjs";
import { runApprovalCommand, runAuditCommand, runAuthorityCommand, runRuntimeCommand, runSecretCommand, runToolCommand } from "../cli/trust-cli.mjs";
import { runAskCommand, runOwnerCommand, runStandupCommand } from "../cli/chief-cli.mjs";
import { runInteropCommand, runMcpCommand } from "../cli/interop-cli.mjs";
import { runGraphifyCommand } from "../cli/graphify-cli.mjs";
import { runSetupCommand } from "../cli/setup-cli.mjs";
import { runUpdateCommand } from "../cli/update-cli.mjs";
import { pendingMigrations } from "../upgrade-engine/migrations.mjs";

const i18n = createLocalization();
const runtime = createRuntime();

const COMMANDS = [
  "setup", "init", "install", "doctor", "update", "upgrade", "review", "ask", "standup", "owner",
  "context", "memory", "graph", "learn", "skill",
  "mission", "schedule", "signal", "browser",
  "authority", "approval", "audit", "secret", "tool", "runtime", "interop", "mcp", "graphify",
  "domain", "team", "agent", "lead", "project", "workflow", "provider", "plugin", "knowledge", "backup"
];

function printHelp() {
  console.log(i18n.t("cli.title"));
  console.log("");
  console.log(i18n.t("cli.usage"));
  console.log("  astack <command> [args]");
  console.log("");
  console.log(i18n.t("cli.commands"));
  for (const command of COMMANDS) {
    console.log("  " + command.padEnd(12) + i18n.t("cli.help." + command));
  }
}

function doctor({ verbose = false } = {}) {
  const required = [
    "core", "runtime", "orchestrator", "departments", "domains", "providers", "knowledge-packs", "plugins",
    "memory-engine", "workflow-engine", "delivery-engine", "team-engine", "agent-engine", "upgrade-engine",
    "localization-engine", "configuration-engine", "event-bus", "permission-system", "installer", "documentation",
    "tests", "context-engine", "knowledge-graph", "learning-engine", "scheduler-engine", "browser-engine",
    "signal-engine", "mission-engine", "trust-engine", "tool-registry", "runtime-providers", "chief-of-staff", "interop-engine",
    "CLAUDE.md", "AGENTS.md"
  ];
  const missing = required.filter((item) => !existsSync(join(runtime.root, item)));
  const config = runtime.configuration.requireSections([
    "project", "language", "architecture", "models", "memory", "plugins", "telemetry", "security", "delivery",
    "domains", "teams", "agents", "upgrade", "cli", "context", "learning", "runtime", "browser", "authority", "audit"
  ]);
  if (missing.length || !config.ok) {
    throw new Error("missing=" + missing.join(",") + " config=" + config.missing.join(","));
  }
  console.log(i18n.t("cli.doctorOk"));
  console.log("Claude Code: CLAUDE.md");
  console.log("Codex: AGENTS.md");
  const interop = runtime.interop.status();
  const graph = runtime.graphify.status();
  console.log("Graphify: " + (graph.installed ? graph.version + (graph.graph.built ? ", " + graph.graph.nodes + " nodes" + (graph.graph.stale ? " (stale)" : "") : ", graph not built") : "not installed (astack graphify setup)"));
  console.log("Shared contract: AGENTS.md#" + interop.contract.hash + (interop.parity ? " (Claude Code and Codex in parity)" : " (run: astack interop sync)"));
  console.log("Departments: " + runtime.departments.length);
  console.log("Enterprise Roles: " + JSON.parse(readFileSync(join(runtime.root, "roles", "enterprise-roles.json"), "utf8")).roles.length);
  console.log("Domains: " + runtime.domains.list().length);
  console.log("Providers: " + runtime.providers.length);
  console.log("Knowledge Packs: " + runtime.knowledgePackRegistry.list().length);
  console.log("Delivery Templates: " + runtime.projects.templates().length);
  console.log("Projects: " + runtime.projects.list().length);
  console.log("Teams: " + runtime.teams.list().length);
  console.log("Agents: " + runtime.agents.list().length);
  console.log("Memory facets: " + runtime.memory.facetNames().length);
  console.log("Skills: " + runtime.skills.stats().skills);
  console.log("Tools: " + runtime.tools.stats().tools);
  console.log("Runtimes: " + runtime.runtimes.list().map((entry) => entry.id).join(", "));
  console.log("Jobs: " + runtime.scheduler.list().length);
  console.log("Hooks: " + runtime.signals.list().length);
  console.log("Missions: " + runtime.missions.list().length);
  console.log("Browser: " + runtime.browser.status().driver);
  console.log("Authority default: " + runtime.authority.describe().defaultLevel);
  console.log("Telemetry: disabled");
  // An install that upgraded from an older core ran the previous upgrade command,
  // which had no migration step. Report what is still waiting rather than letting
  // it be missed.
  const pending = pendingMigrations(runtime.workspaceRoot);
  if (pending.length) {
    console.log(i18n.t("cli.upgrade.migrationsPending", { count: pending.length }));
    for (const migration of pending) {
      console.log("- " + migration.id + ": " + migration.description);
    }
    console.log(i18n.t("cli.upgrade.migrationsHint"));
  }
  if (verbose) {
    const context = runtime.context.stats();
    console.log("Context index: " + (context.built ? context.files + " files, " + context.symbols + " symbols" : "not built"));
    console.log("Context savings: " + Math.round(context.savingsRatio * 100) + "%");
  }
}

function list(title, items) {
  console.log(title);
  for (const item of items) {
    console.log("- " + (item.id ?? item));
  }
}

async function run() {
  const [command, ...rest] = process.argv.slice(2);
  const tokens = rest.filter(Boolean);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  const context = { runtime, i18n, tokens };
  switch (command) {
    case "setup":
      runSetupCommand(context);
      return;
    case "init":
    case "install": {
      // "Install" means the full setup: migrations, both runtimes, Graphify,
      // the index and the global skill. Doctor then validates the result.
      runSetupCommand(context);
      if (process.exitCode) {
        return;
      }
      doctor();
      console.log(command === "init" ? i18n.t("cli.initDone") : i18n.t("cli.installed"));
      return;
    }
    case "doctor":
      doctor({ verbose: tokens.includes("--verbose") });
      return;
    case "update":
    case "upgrade":
      runUpdateCommand(context);
      return;
    case "review": {
      const result = runtime.orchestrator.run(tokens.join(" "));
      console.log(i18n.t("cli.reviewIntro"));
      for (const line of result.answer) {
        console.log("- " + line);
      }
      return;
    }
    case "ask":
    case "brief":
      await runAskCommand(context);
      return;
    case "standup":
      runStandupCommand(context);
      return;
    case "owner":
      runOwnerCommand(context);
      return;
    case "context":
      runContextCommand(context);
      return;
    case "memory":
      runMemoryCommand(context);
      return;
    case "graph":
      runGraphCommand(context);
      return;
    case "learn":
    case "learning":
      runLearningCommand(context);
      return;
    case "skill":
      runSkillCommand(context);
      return;
    case "mission":
      await runMissionCommand(context);
      return;
    case "schedule":
      await runScheduleCommand(context);
      return;
    case "signal":
      await runSignalCommand(context);
      return;
    case "browser":
      await runBrowserCommand(context);
      return;
    case "authority":
      runAuthorityCommand(context);
      return;
    case "approval":
      runApprovalCommand(context);
      return;
    case "audit":
      runAuditCommand(context);
      return;
    case "secret":
      runSecretCommand(context);
      return;
    case "tool":
      runToolCommand(context);
      return;
    case "runtime":
      await runRuntimeCommand(context);
      return;
    case "interop":
      await runInteropCommand(context);
      return;
    case "mcp":
      await runMcpCommand(context);
      return;
    case "graphify":
      runGraphifyCommand(context);
      return;
    case "domain":
      runDomainCommand(context);
      return;
    case "team":
      runTeamCommand(context);
      return;
    case "agent":
      runAgentCommand(context);
      return;
    case "lead":
      runLeadCommand(context);
      return;
    case "project":
      runProjectCommand(context);
      return;
    case "workflow":
      list(i18n.t("cli.workflowList"), runtime.workflows.list());
      return;
    case "provider":
      list(i18n.t("cli.providerList"), runtime.providers);
      return;
    case "plugin":
      list(i18n.t("cli.pluginList"), runtime.pluginRegistry.list());
      return;
    case "knowledge":
      list(i18n.t("cli.knowledgeList"), runtime.knowledgePackRegistry.list());
      return;
    case "backup":
      console.log(i18n.t("cli.backupCreated", { path: runtime.memory.backup() }));
      return;
    default:
      throw new Error(i18n.t("cli.unknownCommand", { command }));
  }
}

try {
  await run();
} catch (error) {
  console.error(i18n.t("cli.errorPrefix") + ": " + error.message);
  process.exitCode = 1;
}
