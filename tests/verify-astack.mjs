import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createRuntime } from "../runtime/astack-runtime.mjs";
import { createLocalization, supportedLocales } from "../localization-engine/service.mjs";
import { evaluatePermission } from "../permission-system/policy.mjs";

const root = process.cwd();
const requiredDirs = ["core", "runtime", "orchestrator", "departments", "domains", "providers", "knowledge-packs", "plugins", "memory-engine", "workflow-engine", "delivery-engine", "team-engine", "agent-engine", "upgrade-engine", "localization-engine", "configuration-engine", "event-bus", "permission-system", "installer", "documentation", "tests", ".github", "context-engine", "knowledge-graph", "learning-engine", "mission-engine", "scheduler-engine", "signal-engine", "browser-engine", "tool-registry", "runtime-providers", "trust-engine", "chief-of-staff", "lib"];
for (const dir of requiredDirs) {
  assert.ok(existsSync(join(root, dir)), "missing " + dir);
}

assert.ok(existsSync(join(root, "CLAUDE.md")), "CLAUDE.md is required for Claude Code");
assert.ok(readFileSync(join(root, "CLAUDE.md"), "utf8").includes("Claude Code"));
assert.ok(existsSync(join(root, "scripts", "astack-upgrade.mjs")), "standalone upgrader is required");
assert.deepEqual(supportedLocales, ["fa", "en", "ar", "tr"]);
assert.equal(createLocalization({ locale: "fa" }).direction, "rtl");

const runtime = createRuntime();
assert.equal(runtime.configuration.requireSections(["project", "language", "architecture", "models", "memory", "plugins", "telemetry", "security", "delivery", "domains", "teams", "agents", "upgrade", "cli", "context", "graph", "learning", "runtime", "tools", "missions", "scheduler", "signals", "browser", "authority", "audit", "secrets"]).ok, true);
assert.equal(runtime.configuration.get("context.owner_capsule_budget"), 800, "context budgets are readable, not just present");
assert.deepEqual(runtime.configuration.get("authority.autonomous"), ["L0", "L1", "L2"]);
assert.equal(runtime.departments.length, 33);
assert.equal(runtime.providers.length, 8);
assert.equal(runtime.knowledgePackRegistry.list().length, 18);
assert.equal(runtime.workflows.list().length, 27);
assert.equal(runtime.memory.scopes().length, 11);
assert.equal(runtime.memory.facetNames().length, 12, "the structured memory facets are available beside the markdown scopes");
assert.ok(runtime.skills.list().length >= 35, "built in skills include the advanced operational packs");
for (const id of ["speech-to-text", "document-ocr", "image-design", "web-operator", "tax-filing"]) {
  assert.ok(runtime.skills.list().some((skill) => skill.id === id), "missing skill: " + id);
}
assert.ok(runtime.skills.catalog({ budget: 400 }).tokens <= 400, "the skill catalog respects its budget");
assert.ok(runtime.tools.list().length >= 15);
assert.equal(runtime.tools.inspect("browser").status, "implemented");
assert.equal(runtime.tools.inspect("computer").status, "future", "unbuilt capabilities are declared as future, never as working");
assert.ok(runtime.runtimes.list().some((entry) => entry.id === "claude-code" && entry.available));
assert.equal(runtime.authority.describe().defaultLevel, "L2");
assert.ok(runtime.scheduler.kinds().includes("http-check"));
assert.ok(typeof runtime.chief.brief === "function" && typeof runtime.missions.run === "function" && typeof runtime.signals.create === "function");
assert.equal(runtime.domains.list().length, 10);
assert.ok(runtime.departments.some((department) => department.id === "delivery"));
assert.ok(runtime.departments.some((department) => department.id === "legal-practice"));
assert.ok(runtime.departments.some((department) => department.id === "accounting"));
assert.ok(runtime.departments.some((department) => department.id === "tax"));
assert.equal(runtime.workflows.select("sprint roadmap").id, "project-delivery");
assert.equal(runtime.workflows.select("پرونده حقوقی در دادگاه").id, "legal-case");
assert.equal(runtime.workflows.select("اظهارنامه مالیات ارزش افزوده").id, "tax-filing");
assert.equal(runtime.projects.templates().length, 8);
const roleCatalog = JSON.parse(readFileSync(join(root, "roles", "enterprise-roles.json"), "utf8"));
assert.ok(roleCatalog.roles.length >= 215);
assert.ok(roleCatalog.roles.some((role) => role.specialization === "Laravel"));
assert.ok(roleCatalog.roles.some((role) => role.specialization === "MCP"));
assert.ok(roleCatalog.roles.some((role) => role.specialization === "VMware ESXi"));
assert.ok(roleCatalog.roles.some((role) => role.specialization === "Scrum"));
assert.ok(roleCatalog.roles.some((role) => role.specialization === "Litigation"));
assert.ok(roleCatalog.roles.some((role) => role.specialization === "VAT"));
assert.ok(roleCatalog.roles.some((role) => role.specialization === "Bookkeeping"));
assert.equal(evaluatePermission("read-project").allowed, true);
assert.equal(evaluatePermission("write-secret").allowed, false);

const legalIntent = runtime.orchestrator.analyzeIntent("پرونده حقوقی و قرارداد ملکی");
assert.equal(legalIntent.domain.id, "legal");
assert.ok(legalIntent.departments.some((department) => department.id === "legal-practice"));
const taxIntent = runtime.orchestrator.analyzeIntent("tax filing for VAT");
assert.equal(taxIntent.domain.id, "tax");
assert.equal(taxIntent.workflow.id, "tax-filing");

const doctor = execFileSync(process.execPath, [join(root, "bin", "astack.mjs"), "doctor"], { encoding: "utf8" });
assert.match(doctor, /بررسی سلامت AStack Enterprise کامل شد/);
assert.match(doctor, /Claude Code: CLAUDE.md/);
assert.match(doctor, /Domains: 10/);
assert.match(doctor, /Memory facets: 12/);
assert.match(doctor, /Browser: /);
assert.match(doctor, /Authority default: L2/);

const review = execFileSync(process.execPath, [join(root, "bin", "astack.mjs"), "review", "Laravel security deployment"], { encoding: "utf8" });
assert.match(review, /Orchestrator/);
assert.match(review, /Departmentهای فعال/);

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
const banned = ["TO" + "DO", "PLACE" + "HOLDER", "FIX" + "ME"];
for (const file of files) {
  const text = readFileSync(join(root, file), "utf8");
  assert.ok(!text.includes("G" + "Stack"), "legacy product reference in " + file);
  for (const marker of banned) {
    assert.ok(!text.includes(marker), marker + " in " + file);
  }
}

console.log("AStack Enterprise verification passed.");
