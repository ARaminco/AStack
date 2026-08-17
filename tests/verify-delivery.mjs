import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completionProbability, criticalPath, pertEstimate, topologicalOrder } from "../delivery-engine/scheduling.mjs";
import { rankBacklog, riceScore, wsjfScore } from "../delivery-engine/prioritization.mjs";
import { rankRisks, riskExposure, riskScore } from "../delivery-engine/risk.mjs";
import { burndown, earnedValue, estimateAccuracy, healthScore, throughputDrift, totalPoints } from "../delivery-engine/metrics.mjs";
import { createRandom, forecastDates, monteCarloForecast } from "../delivery-engine/forecasting.mjs";
import { ProjectEngine, itemStatuses, phases } from "../delivery-engine/project-engine.mjs";
import { seedDemo } from "../delivery-engine/demo.mjs";
import { renderStatusReport, sparkline } from "../delivery-engine/reporting.mjs";
import { createLocalization } from "../localization-engine/service.mjs";

const root = process.cwd();

const pert = pertEstimate({ optimistic: 2, likely: 4, pessimistic: 8 });
assert.equal(pert.expected, (2 + 16 + 8) / 6);
assert.equal(pert.stdDev, 1);
assert.throws(() => pertEstimate({ optimistic: 5, likely: 4, pessimistic: 8 }));
assert.throws(() => pertEstimate({ optimistic: -1, likely: 2, pessimistic: 3 }));

const dag = [
  { id: "A", estimate: { optimistic: 2, likely: 3, pessimistic: 4 } },
  { id: "B", estimate: { optimistic: 1, likely: 2, pessimistic: 3 }, dependsOn: ["A"] },
  { id: "C", estimate: { optimistic: 4, likely: 5, pessimistic: 6 }, dependsOn: ["A"] },
  { id: "D", estimate: { optimistic: 2, likely: 4, pessimistic: 6 }, dependsOn: ["B", "C"] }
];
const plan = criticalPath(dag);
assert.equal(plan.duration, 12);
assert.deepEqual(plan.path, ["A", "C", "D"]);
assert.equal(plan.tasks.find((task) => task.id === "B").slack, 3);
assert.throws(() => topologicalOrder([{ id: "X", dependsOn: ["Y"] }, { id: "Y", dependsOn: ["X"] }]), /cycle/i);
const onTime = completionProbability(dag, 14);
assert.equal(onTime.probability, 0.99);

assert.equal(wsjfScore({ businessValue: 8, timeCriticality: 5, riskReduction: 3, jobSize: 4 }), 4);
assert.throws(() => wsjfScore({ businessValue: 8, timeCriticality: 5, riskReduction: 3, jobSize: 0 }));
assert.equal(riceScore({ reach: 100, impact: 2, confidence: 0.5, effort: 4 }), 25);
const ranked = rankBacklog([
  { id: "low-must", type: "story", moscow: "must", wsjf: { businessValue: 1, timeCriticality: 1, riskReduction: 1, jobSize: 3 } },
  { id: "high-should", type: "story", moscow: "should", wsjf: { businessValue: 9, timeCriticality: 9, riskReduction: 9, jobSize: 1 } }
]);
assert.equal(ranked[0].id, "low-must");

assert.deepEqual(riskScore({ probability: 5, impact: 5 }), { score: 25, band: "critical", suggestedResponse: "avoid" });
assert.equal(riskScore({ probability: 1, impact: 2 }).band, "low");
assert.equal(riskScore({ probability: 3, impact: 3 }).band, "high");
assert.throws(() => riskScore({ probability: 0, impact: 3 }));
assert.equal(riskExposure([{ probability: 5, impact: 5, status: "open" }]).exposure, 1);
assert.equal(rankRisks([{ id: "a", probability: 1, impact: 1 }, { id: "b", probability: 4, impact: 4 }])[0].id, "b");

const seededRandom = createRandom(42);
assert.equal(seededRandom(), createRandom(42)());
const certain = monteCarloForecast({ remainingPoints: 12, throughputSamples: [5], runs: 200, seed: 7 });
assert.deepEqual(certain.periods, { p50: 3, p85: 3, p95: 3 });
assert.equal(monteCarloForecast({ remainingPoints: 5, throughputSamples: [0, 0] }), null);
assert.deepEqual(forecastDates({ forecast: certain, from: "2026-01-01T00:00:00.000Z", periodDays: 7 }).p50, "2026-01-22");

const evm = earnedValue({
  baseline: { totalPoints: 20, setAt: "2026-01-01T00:00:00.000Z", targetDate: "2026-01-21T00:00:00.000Z" },
  workItems: [
    { id: "T-1", type: "story", status: "done", points: 8, actualEffort: 10, completedAt: "2026-01-10T00:00:00.000Z" },
    { id: "T-2", type: "story", status: "in-progress", points: 12 }
  ]
}, "2026-01-11T00:00:00.000Z");
assert.equal(evm.pv, 10);
assert.equal(evm.ev, 8);
assert.equal(evm.ac, 10);
assert.equal(evm.spi, 0.8);
assert.equal(evm.cpi, 0.8);
assert.equal(evm.eac, 25);
assert.equal(evm.eacTypical, 22);
assert.equal(evm.tcpi, 1.2);

const accuracy = estimateAccuracy([
  { status: "done", points: 4, actualEffort: 5 },
  { status: "done", points: 2, actualEffort: 2 }
]);
assert.equal(accuracy.mape, 0.13);
assert.equal(accuracy.effortRatio, 1.13);

assert.equal(throughputDrift([5, 5, 5, 5, 5, 5]).alarm, false);
assert.equal(throughputDrift([6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 0, 0, 0, 0, 0, 0]).alarm, true);

assert.equal(sparkline([0, 5, 10]).length, 3);

const scratch = mkdtempSync(join(tmpdir(), "astack-delivery-"));
const memoryLog = [];
const memoryStub = {
  append(scope, entry) {
    memoryLog.push(scope + "|" + entry);
    return scope;
  },
  read() {
    return memoryLog.map((line) => line.split("|")[1]).join("\n");
  }
};
let tick = new Date("2026-03-01T00:00:00.000Z").getTime();
const engine = new ProjectEngine(scratch, { memory: memoryStub, clock: () => new Date(tick) });

const project = engine.create({ name: "Lifecycle Check", targetDate: "2026-04-01" });
assert.equal(project.id, "lifecycle-check");
assert.equal(project.phase, phases[0]);
assert.equal(engine.advancePhase(project.id).advanced, false);
assert.ok(engine.gate(engine.get(project.id)).unmet.includes("charter-outcome-missing"));
engine.setCharter(project.id, { outcome: "Deliver the check", successCriteria: ["All gates pass"] });
assert.equal(engine.advancePhase(project.id).advanced, true);

assert.ok(engine.gate(engine.get(project.id)).unmet.includes("milestones-missing"));
engine.addMilestone(project.id, { title: "Halfway", due: "2026-03-15" });
const items = ["one", "two", "three", "four", "five"].map((name) =>
  engine.addWorkItem(project.id, { title: "Story " + name, type: "story", points: 2, moscow: "must" }));
engine.addRisk(project.id, { title: "Schedule slip", probability: 3, impact: 3 });
const advanced = engine.advancePhase(project.id);
assert.equal(advanced.phase, "execution");
assert.equal(engine.get(project.id).baseline.totalPoints, 10);

assert.throws(() => engine.moveItem(project.id, "T-99", "done"), /Unknown work item/);
const noPoints = engine.addWorkItem(project.id, { title: "Unsized", type: "story", points: 0 });
assert.throws(() => engine.moveItem(project.id, noPoints.id, "ready"), /Definition of ready/);
const blockedDep = engine.addWorkItem(project.id, { title: "Depends", type: "story", points: 1, dependsOn: [items[4].id] });
assert.throws(() => engine.moveItem(project.id, blockedDep.id, "in-progress"), /Dependencies not done/);
for (const item of items.slice(0, 4)) {
  engine.moveItem(project.id, item.id, "ready");
}

const sprint = engine.planSprint(project.id, { goal: "Prove flow", days: 7, capacity: 4 });
assert.equal(sprint.committed.length, 2);

engine.moveItem(project.id, items[0].id, "in-progress");
tick += 24 * 60 * 60 * 1000;
engine.moveItem(project.id, items[1].id, "in-progress");
engine.moveItem(project.id, items[2].id, "in-progress");
assert.throws(() => engine.moveItem(project.id, items[3].id, "in-progress"), new RegExp("WIP limit reached.*" + items[0].id));
engine.moveItem(project.id, items[0].id, "done", { actualEffort: 3 });
engine.moveItem(project.id, items[1].id, "done", { actualEffort: 2 });
engine.moveItem(project.id, items[2].id, "done", { actualEffort: 2 });
engine.moveItem(project.id, items[3].id, "in-progress");
engine.moveItem(project.id, items[3].id, "done", { actualEffort: 2 });
engine.moveItem(project.id, items[4].id, "ready");
engine.moveItem(project.id, items[4].id, "in-progress");
engine.moveItem(project.id, items[4].id, "done", { actualEffort: 3 });
engine.moveItem(project.id, noPoints.id, "descoped");
engine.moveItem(project.id, blockedDep.id, "in-progress");
engine.moveItem(project.id, blockedDep.id, "done", { actualEffort: 1 });
const closedSprint = engine.closeSprint(project.id, { notes: "Flow proven", actions: ["Keep WIP at three"] });
assert.ok(closedSprint.completedPoints >= 4);
assert.ok(memoryLog.some((line) => line.includes("retrospective")));

assert.equal(engine.advancePhase(project.id).phase, "closing");
assert.equal(engine.advancePhase(project.id).phase, "closed");
assert.ok(memoryLog.some((line) => line.includes("[calibration] project=lifecycle-check")));
assert.ok(engine.calibration().effortRatio > 1);
assert.throws(() => engine.advancePhase(project.id), /already closed/);

const demoNow = new Date("2026-07-27T12:00:00.000Z");
const demoId = seedDemo(scratch, { now: demoNow });
const demoEngine = new ProjectEngine(scratch, { clock: () => demoNow });
const status = demoEngine.status(demoId);
assert.equal(status.health.score, 80);
assert.equal(status.health.rag, "green");
assert.deepEqual(status.health.reasons.map((reason) => reason.code), ["blocked-items", "high-risk-exposure", "scope-creep"]);
assert.equal(status.evm.bac, 36);
assert.equal(status.evm.ev, 26);
assert.equal(status.evm.spi, 1.07);
assert.equal(status.evm.cpi, 0.87);
assert.deepEqual(status.velocity.samples, [8, 13]);
assert.equal(status.scopeCreep, 0.14);
assert.deepEqual(status.criticalPath.path, ["T-7"]);
assert.deepEqual(status.forecast.dates, { p50: "2026-08-24", p85: "2026-09-07", p95: "2026-09-14" });
assert.deepEqual(status.nextActions.slice(0, 2).map((action) => action.code), ["unblock-item", "mitigate-risk"]);
const demoProject = demoEngine.get(demoId);
assert.equal(totalPoints(demoProject.workItems), 41);
const demoBurndown = burndown(demoProject.sprints[0], demoProject.workItems);
assert.equal(demoBurndown.scope, 8);
assert.equal(demoBurndown.series[5].remaining, 3);
assert.equal(demoBurndown.series[demoBurndown.series.length - 1].remaining, 0);
const demoHealth = healthScore(demoProject, { asOf: demoNow.toISOString() });
assert.equal(demoHealth.score, status.health.score);
const board = demoEngine.board(demoId);
assert.deepEqual(Object.keys(board.columns), itemStatuses);
assert.equal(board.columns.blocked.length, 1);
assert.ok(demoEngine.raci(demoId).length >= 3);
assert.ok(demoEngine.digest(demoId, { sinceDays: 2 }).blocked.length === 1);

const i18n = createLocalization({ locale: "fa" });
const report = renderStatusReport(status, i18n.t.bind(i18n));
assert.match(report, /گزارش وضعیت پروژه/);
assert.match(report, /مدیریت ارزش کسب‌شده/);
assert.match(report, /پیش‌بینی تکمیل/);
assert.match(report, /بهترین اقدام‌های بعدی/);
assert.doesNotMatch(report, /delivery\.(reason|action|gate)\./);

const templatesOut = execFileSync(process.execPath, [join(root, "bin", "astack.mjs"), "project", "templates"], { encoding: "utf8" });
assert.match(templatesOut, /software-delivery/);
assert.match(templatesOut, /ai-feature/);
assert.match(templatesOut, /startup-mvp/);
assert.match(templatesOut, /marketing-campaign/);

rmSync(scratch, { recursive: true, force: true });
console.log("AStack delivery engine verification passed.");
