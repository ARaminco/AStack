export function pertEstimate({ optimistic, likely, pessimistic }) {
  const values = [optimistic, likely, pessimistic].map(Number);
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("PERT estimate requires non-negative optimistic, likely, and pessimistic values");
  }
  const [o, m, p] = values;
  if (o > m || m > p) {
    throw new Error("PERT estimate requires optimistic <= likely <= pessimistic");
  }
  const expected = (o + 4 * m + p) / 6;
  const stdDev = (p - o) / 6;
  return { expected, stdDev, variance: stdDev * stdDev };
}

export function itemDuration(item) {
  if (item.estimate && item.estimate.likely !== undefined) {
    return pertEstimate(item.estimate).expected;
  }
  return Number(item.duration ?? item.points ?? 1);
}

export function topologicalOrder(items) {
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const item of items) {
    for (const dep of item.dependsOn ?? []) {
      if (!byId.has(dep)) {
        throw new Error("Unknown dependency " + dep + " on item " + item.id);
      }
    }
  }
  const visited = new Map();
  const order = [];
  const visit = (id, trail) => {
    const state = visited.get(id);
    if (state === "done") {
      return;
    }
    if (state === "visiting") {
      const cycle = trail.slice(trail.indexOf(id)).concat(id);
      throw new Error("Dependency cycle detected: " + cycle.join(" -> "));
    }
    visited.set(id, "visiting");
    for (const dep of byId.get(id).dependsOn ?? []) {
      visit(dep, trail.concat(id));
    }
    visited.set(id, "done");
    order.push(id);
  };
  for (const item of items) {
    visit(item.id, []);
  }
  return order;
}

export function criticalPath(items) {
  if (!items.length) {
    return { duration: 0, tasks: [], path: [] };
  }
  const order = topologicalOrder(items);
  const byId = new Map(items.map((item) => [item.id, item]));
  const durations = new Map(items.map((item) => [item.id, itemDuration(item)]));
  const schedule = new Map();

  for (const id of order) {
    const deps = byId.get(id).dependsOn ?? [];
    const earliestStart = deps.length ? Math.max(...deps.map((dep) => schedule.get(dep).earliestFinish)) : 0;
    schedule.set(id, { earliestStart, earliestFinish: earliestStart + durations.get(id) });
  }
  const duration = Math.max(...[...schedule.values()].map((task) => task.earliestFinish));

  const dependents = new Map(items.map((item) => [item.id, []]));
  for (const item of items) {
    for (const dep of item.dependsOn ?? []) {
      dependents.get(dep).push(item.id);
    }
  }
  for (const id of [...order].reverse()) {
    const task = schedule.get(id);
    const successors = dependents.get(id);
    task.latestFinish = successors.length ? Math.min(...successors.map((successor) => schedule.get(successor).latestStart)) : duration;
    task.latestStart = task.latestFinish - durations.get(id);
    task.slack = round(task.latestStart - task.earliestStart);
    task.critical = task.slack === 0;
  }

  const tasks = order.map((id) => ({ id, duration: round(durations.get(id)), ...roundTask(schedule.get(id)) }));
  const path = tasks.filter((task) => task.critical).sort((a, b) => a.earliestStart - b.earliestStart).map((task) => task.id);
  return { duration: round(duration), tasks, path };
}

export function scheduleConfidence(items, pathIds) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const onPath = pathIds.map((id) => byId.get(id)).filter((item) => item?.estimate);
  if (!onPath.length) {
    return null;
  }
  const variance = onPath.reduce((sum, item) => sum + pertEstimate(item.estimate).variance, 0);
  return { pathStdDev: round(Math.sqrt(variance)), pathVariance: round(variance) };
}

export function completionProbability(items, targetDuration) {
  const plan = criticalPath(items);
  const confidence = scheduleConfidence(items, plan.path);
  if (!confidence || confidence.pathStdDev === 0) {
    return { probability: plan.duration <= targetDuration ? 1 : 0, z: null, pathDuration: plan.duration };
  }
  const z = (targetDuration - plan.duration) / confidence.pathStdDev;
  return { probability: round(normalCdf(z)), z: round(z), pathDuration: plan.duration };
}

function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const density = Math.exp(-(z * z) / 2) / Math.sqrt(2 * Math.PI);
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const tail = density * poly;
  return z >= 0 ? 1 - tail : tail;
}

function roundTask(task) {
  return {
    earliestStart: round(task.earliestStart),
    earliestFinish: round(task.earliestFinish),
    latestStart: round(task.latestStart),
    latestFinish: round(task.latestFinish),
    slack: round(task.slack),
    critical: task.critical
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}
