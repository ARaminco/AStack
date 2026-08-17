#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalization } from "../localization-engine/service.mjs";
import { createRuntime } from "../runtime/astack-runtime.mjs";
import { runProjectCommand } from "../delivery-engine/cli.mjs";
import { runAgentCommand, runDomainCommand, runLeadCommand, runTeamCommand, runUpgradeCommand } from "../cli/orchestration-cli.mjs";

const i18n = createLocalization();
const runtime = createRuntime();

function printHelp() {
  console.log(i18n.t("cli.title"));
  console.log("");
  console.log(i18n.t("cli.usage"));
  console.log("  astack <command> [args]");
  console.log("");
  console.log(i18n.t("cli.commands"));
  for (const command of ["init", "install", "doctor", "upgrade", "review", "domain", "team", "agent", "lead", "project", "workflow", "provider", "plugin", "memory", "knowledge", "backup"]) {
    console.log("  " + command.padEnd(12) + i18n.t("cli.help." + command));
  }
}

function doctor() {
  const required = ["core", "runtime", "orchestrator", "departments", "domains", "providers", "knowledge-packs", "plugins", "memory-engine", "workflow-engine", "delivery-engine", "team-engine", "agent-engine", "upgrade-engine", "localization-engine", "configuration-engine", "event-bus", "permission-system", "installer", "documentation", "tests", "CLAUDE.md"];
  const missing = required.filter((item) => !existsSync(join(runtime.root, item)));
  const config = runtime.configuration.requireSections(["project", "language", "architecture", "models", "memory", "plugins", "telemetry", "security", "delivery", "domains", "teams", "agents", "upgrade", "cli"]);
  if (missing.length || !config.ok) {
    throw new Error("missing=" + missing.join(",") + " config=" + config.missing.join(","));
  }
  console.log(i18n.t("cli.doctorOk"));
  console.log("Claude Code: CLAUDE.md");
  console.log("Departments: " + runtime.departments.length);
  console.log("Enterprise Roles: " + JSON.parse(readFileSync(join(runtime.root, "roles", "enterprise-roles.json"), "utf8")).roles.length);
  console.log("Domains: " + runtime.domains.list().length);
  console.log("Providers: " + runtime.providers.length);
  console.log("Knowledge Packs: " + runtime.knowledgePackRegistry.list().length);
  console.log("Delivery Templates: " + runtime.projects.templates().length);
  console.log("Projects: " + runtime.projects.list().length);
  console.log("Teams: " + runtime.teams.list().length);
  console.log("Agents: " + runtime.agents.list().length);
  console.log("Telemetry: disabled");
}

function list(title, items) {
  console.log(title);
  for (const item of items) {
    console.log("- " + (item.id ?? item));
  }
}

function run() {
  const [command, ...rest] = process.argv.slice(2);
  const tokens = rest.filter(Boolean);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "init" || command === "install") {
    doctor();
    console.log(command === "init" ? i18n.t("cli.initDone") : i18n.t("cli.installed"));
    return;
  }
  if (command === "doctor") {
    doctor();
    return;
  }
  if (command === "update" || command === "upgrade") {
    runUpgradeCommand({ runtime, i18n, tokens });
    return;
  }
  if (command === "review") {
    const result = runtime.orchestrator.run(tokens.join(" "));
    console.log(i18n.t("cli.reviewIntro"));
    for (const line of result.answer) {
      console.log("- " + line);
    }
    return;
  }
  if (command === "domain") {
    runDomainCommand({ runtime, i18n, tokens });
    return;
  }
  if (command === "team") {
    runTeamCommand({ runtime, i18n, tokens });
    return;
  }
  if (command === "agent") {
    runAgentCommand({ runtime, i18n, tokens });
    return;
  }
  if (command === "lead") {
    runLeadCommand({ runtime, i18n, tokens });
    return;
  }
  if (command === "project") {
    runProjectCommand({ runtime, i18n, tokens });
    return;
  }
  if (command === "workflow") {
    list(i18n.t("cli.workflowList"), runtime.workflows.list());
    return;
  }
  if (command === "provider") {
    list(i18n.t("cli.providerList"), runtime.providers);
    return;
  }
  if (command === "plugin") {
    list(i18n.t("cli.pluginList"), runtime.pluginRegistry.list());
    return;
  }
  if (command === "memory") {
    list(i18n.t("cli.memoryList"), runtime.memory.scopes());
    return;
  }
  if (command === "knowledge") {
    list(i18n.t("cli.knowledgeList"), runtime.knowledgePackRegistry.list());
    return;
  }
  if (command === "backup") {
    console.log(i18n.t("cli.backupCreated", { path: runtime.memory.backup() }));
    return;
  }
  throw new Error(i18n.t("cli.unknownCommand", { command }));
}

try {
  run();
} catch (error) {
  console.error(i18n.t("cli.errorPrefix") + ": " + error.message);
  process.exitCode = 1;
}
