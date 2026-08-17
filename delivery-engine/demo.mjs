import { ProjectEngine } from "./project-engine.mjs";

const DAY = 24 * 60 * 60 * 1000;

export function seedDemo(root, { memory = null, eventBus = null, now = new Date() } = {}) {
  const start = now.getTime() - 42 * DAY;
  let cursor = start;
  const engine = new ProjectEngine(root, { memory, eventBus, clock: () => new Date(cursor) });
  const at = (day) => {
    cursor = start + day * DAY;
  };

  at(0);
  const project = engine.create({
    name: "AStack Demo Product",
    description: "Demonstration project seeded with six weeks of delivery history",
    targetDate: new Date(start + 63 * DAY).toISOString().slice(0, 10),
    template: "software-delivery"
  });
  const id = project.id;
  engine.setCharter(id, {
    outcome: "Ship the demo product to its first paying customers",
    successCriteria: ["Core loop usable end to end", "Release passes security review"],
    constraints: ["Two-week sprints", "No external dependencies"]
  });
  engine.advancePhase(id);

  const withDeps = engine.get(id);
  const link = (itemId, deps) => {
    withDeps.workItems.find((item) => item.id === itemId).dependsOn = deps;
  };
  link("T-5", ["T-2"]);
  link("T-6", ["T-5"]);
  link("T-7", ["T-6"]);
  link("T-9", ["T-6"]);
  link("T-11", ["T-9"]);
  engine.save(withDeps);
  engine.advancePhase(id);

  engine.moveItem(id, "T-2", "ready");
  engine.moveItem(id, "T-3", "ready");
  engine.planSprint(id, { goal: "Foundations in place", days: 14, capacity: 12 });
  at(1);
  engine.moveItem(id, "T-2", "in-progress");
  at(5);
  engine.moveItem(id, "T-2", "done", { actualEffort: 6 });
  at(6);
  engine.moveItem(id, "T-3", "in-progress");
  at(9);
  engine.moveItem(id, "T-3", "done", { actualEffort: 3 });
  at(10);
  engine.completeMilestone(id, "M-1");
  at(14);
  engine.closeSprint(id, {
    notes: "Foundations landed; pipeline setup was smoother than estimated",
    actions: ["Reserve review capacity earlier in the sprint"]
  });

  engine.moveItem(id, "T-5", "ready");
  engine.moveItem(id, "T-6", "ready");
  engine.planSprint(id, { goal: "Core domain and API", days: 14, capacity: 13 });
  at(15);
  engine.moveItem(id, "T-5", "in-progress");
  at(20);
  engine.recordDecision(id, {
    title: "Store demo data as JSON files",
    context: "Considered SQLite versus flat JSON for the demo store",
    choice: "Flat JSON keeps the platform dependency-free"
  });
  engine.closeRisk(id, "R-3");
  at(22);
  engine.moveItem(id, "T-5", "done", { actualEffort: 10 });
  at(23);
  engine.moveItem(id, "T-6", "in-progress");
  at(27);
  engine.moveItem(id, "T-6", "done", { actualEffort: 5 });
  at(28);
  engine.closeSprint(id, {
    notes: "Domain model took longer than estimated",
    actions: ["Split stories above five points before planning"]
  });

  at(30);
  engine.addWorkItem(id, {
    type: "story",
    title: "Onboarding polish",
    parent: "T-4",
    department: "frontend",
    points: 5,
    moscow: "could",
    wsjf: { businessValue: 4, timeCriticality: 2, riskReduction: 1, jobSize: 5 }
  });
  engine.addRisk(id, {
    title: "Launch window conflicts with infrastructure freeze",
    probability: 4,
    impact: 4,
    owner: "devops",
    mitigation: "Confirm the release slot with infrastructure two weeks ahead"
  });

  at(31);
  engine.moveItem(id, "T-7", "ready");
  engine.moveItem(id, "T-9", "ready");
  engine.moveItem(id, "T-10", "ready");
  engine.moveItem(id, "T-12", "ready");
  engine.planSprint(id, { goal: "Verification and interface", days: 14, capacity: 14 });
  at(32);
  engine.moveItem(id, "T-9", "in-progress");
  at(38);
  engine.moveItem(id, "T-9", "done", { actualEffort: 6 });
  at(39);
  engine.moveItem(id, "T-10", "in-progress");
  at(40);
  engine.moveItem(id, "T-7", "in-progress");
  at(41);
  engine.moveItem(id, "T-7", "blocked", { reason: "Waiting for the design tokens package" });

  at(42);
  const seeded = engine.get(id);
  engine.record(seeded, "demo-seeded", {});
  engine.save(seeded);
  return id;
}
