import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainRegistry } from "../domains/domain-registry.mjs";
import { TeamEngine, teamStatuses } from "../team-engine/team-engine.mjs";
import { AgentEngine, parseInterval } from "../agent-engine/agent-engine.mjs";
import { Leadership } from "../agent-engine/leadership.mjs";
import { ProjectEngine } from "../delivery-engine/project-engine.mjs";
import { UpgradeEngine, compareVersions, findInstallRoot, readVersion } from "../upgrade-engine/upgrade-engine.mjs";

const root = process.cwd();

// Domain registry
const domains = new DomainRegistry(root);
assert.equal(domains.list().length, 10);
assert.equal(domains.detect("پرونده حقوقی و قرارداد").id, "legal");
assert.equal(domains.detect("tax filing for VAT").id, "tax");
assert.equal(domains.detect("monthly bookkeeping ledger close").id, "accounting");
assert.equal(domains.detect("کمپین بازاریابی برند").id, "marketing");
assert.equal(domains.detect(""), null);
assert.throws(() => domains.get("unknown-domain"), /Unknown domain/);
for (const domain of domains.list()) {
  assert.ok(domain.blueprint?.lead?.role, "domain missing blueprint lead: " + domain.id);
  assert.ok(domain.keywords.length >= 5, "domain needs keywords: " + domain.id);
}

// Sandbox for stateful engines
const sandbox = mkdtempSync(join(tmpdir(), "astack-orchestration-"));
let tick = new Date("2026-01-01T08:00:00.000Z").getTime();
const clock = () => new Date(tick);
const teams = new TeamEngine(sandbox, { clock, domains });
const agents = new AgentEngine(sandbox, { clock });
const projects = new ProjectEngine(sandbox, { clock });
const leadership = new Leadership({ domains, teams, agents, projects, clock });

// Leadership: propose and form a team for a legal engagement
const proposal = leadership.propose("پرونده حقوقی قرارداد ملکی");
assert.equal(proposal.domain.id, "legal");
assert.equal(proposal.workflow, "legal-case");
const formed = leadership.formTeam("پرونده حقوقی قرارداد ملکی", { name: "Legal Case Team" });
assert.equal(formed.team.domain, "legal");
assert.equal(formed.team.status, "active");
assert.ok(formed.team.members.length >= 5);
assert.equal(formed.agents.length, formed.team.members.length);
assert.ok(formed.team.members.every((member) => member.agent));
assert.ok(teamStatuses.includes(formed.team.status));

// Scheduling
assert.equal(parseInterval("30m"), 30 * 60 * 1000);
assert.equal(parseInterval("1d"), 24 * 60 * 60 * 1000);
assert.throws(() => parseInterval("soon"), /Invalid interval/);
const lead = formed.agents[0];
agents.assign(lead.id, { objective: "Prepare the case intake summary", every: "1d", deliverable: "Intake memo" });
assert.equal(agents.due().length, 1);
const dispatched = agents.runDue();
assert.equal(dispatched.length, 1);
assert.ok(existsSync(join(sandbox, dispatched[0].workOrder)), "work order file missing");
const workOrderText = readFileSync(join(sandbox, dispatched[0].workOrder), "utf8");
assert.match(workOrderText, /Work Order A-1\/R-1/);
assert.match(workOrderText, /Prepare the case intake summary/);
assert.equal(agents.due().length, 0);
assert.equal(agents.openRuns().length, 1);
agents.report(lead.id, dispatched[0].assignmentId, { summary: "Intake memo drafted" });
assert.equal(agents.openRuns().length, 0);
assert.equal(agents.due().length, 0);
tick += 24 * 60 * 60 * 1000 + 1000;
assert.equal(agents.due().length, 1, "recurring assignment must come due again");

// Delegation from a project board
const project = projects.create({ name: "Contract Dispute" });
projects.addWorkItem(project.id, { title: "Collect the evidence bundle", department: "legal-practice", points: 3 });
projects.addWorkItem(project.id, { title: "Draft the response brief", department: "legal-practice", points: 5, moscow: "must" });
const delegated = leadership.delegate({ projectId: project.id, teamId: formed.team.id });
assert.equal(delegated.length, 2);
assert.ok(delegated.every((entry) => entry.agentId && entry.assignmentId && entry.itemId));
assert.equal(new Set(delegated.map((entry) => entry.agentId)).size, 2, "delegation must round-robin across department members");
assert.equal(teams.get(formed.team.id).project, project.id);
const standup = leadership.standup();
assert.equal(standup.teams.length, 1);
assert.equal(standup.agents.length, formed.agents.length);
assert.ok(standup.due >= 3);
const dueBefore = agents.due().length;
const paused = agents.pause(lead.id);
assert.equal(paused.status, "paused");
const dueAfter = agents.due();
assert.ok(dueAfter.length < dueBefore, "pausing an agent must remove its due assignments");
assert.ok(dueAfter.every((entry) => entry.agent.id !== lead.id), "paused agents must not be dispatched");
agents.resume(lead.id);

// Upgrade engine against a synthetic legacy install
assert.equal(compareVersions("2.0.0", "1.9.9"), 1);
assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
const legacy = mkdtempSync(join(tmpdir(), "astack-legacy-"));
mkdirSync(join(legacy, "orchestrator"), { recursive: true });
writeFileSync(join(legacy, "orchestrator", "orchestrator.mjs"), "export const legacy = true;\n");
mkdirSync(join(legacy, "core"), { recursive: true });
writeFileSync(join(legacy, "core", "manifest.json"), JSON.stringify({ id: "astack-core", version: "1.0.0" }) + "\n");
writeFileSync(join(legacy, "astack.config.yaml"), "project:\n  name: Legacy Install\n");
mkdirSync(join(legacy, "memory"), { recursive: true });
writeFileSync(join(legacy, "memory", "decision.md"), "# decision\n\n- keep this owner note\n");
assert.equal(findInstallRoot(join(legacy, "orchestrator")), legacy);
assert.equal(readVersion(legacy), "1.0.0");

const keepAware = new UpgradeEngine(legacy, { sourceDir: root, keep: ["orchestrator"] });
assert.ok(keepAware.plan().changes.some((change) => change.path === "orchestrator/orchestrator.mjs" && change.action === "preserved"));

const upgrader = new UpgradeEngine(legacy, { sourceDir: root });
const plan = upgrader.plan();
assert.equal(plan.currentVersion, "1.0.0");
assert.equal(plan.sourceVersion, "2.0.0");
assert.equal(plan.upToDate, false);
assert.ok(plan.changes.some((change) => change.path === "orchestrator/orchestrator.mjs" && change.action === "update"));
assert.ok(plan.changes.some((change) => change.path.startsWith("agent-engine/") && change.action === "add"));
assert.ok(plan.changes.some((change) => change.path === "package.json" && change.action === "seed"));
assert.ok(!plan.changes.some((change) => change.path.startsWith("memory/")), "memory must never appear in the plan");

const applied = upgrader.apply();
assert.ok(applied.applied);
assert.ok(applied.appliedCount > 0);
assert.match(readFileSync(join(legacy, "orchestrator", "orchestrator.mjs"), "utf8"), /class Orchestrator/);
assert.ok(existsSync(join(legacy, "agent-engine", "agent-engine.mjs")));
assert.ok(existsSync(join(legacy, "upgrade-engine", "upgrade-engine.mjs")));
assert.match(readFileSync(join(legacy, "memory", "decision.md"), "utf8"), /keep this owner note/);
const upgradedConfig = readFileSync(join(legacy, "astack.config.yaml"), "utf8");
assert.match(upgradedConfig, /Legacy Install/, "owner config values must survive the upgrade");
assert.match(upgradedConfig, /domains:/, "new config sections must be appended");
assert.match(upgradedConfig, /upgrade:/, "new config sections must be appended");
assert.ok(applied.configSectionsAdded.includes("domains"));
assert.match(readFileSync(join(applied.backupDir, "orchestrator", "orchestrator.mjs"), "utf8"), /legacy = true/);
assert.ok(existsSync(join(applied.backupDir, "upgrade-report.json")));
assert.equal(readVersion(legacy), "2.0.0");
assert.equal(new UpgradeEngine(legacy, { sourceDir: root }).plan().upToDate, true);

rmSync(sandbox, { recursive: true, force: true });
rmSync(legacy, { recursive: true, force: true });
console.log("AStack orchestration verification passed.");
