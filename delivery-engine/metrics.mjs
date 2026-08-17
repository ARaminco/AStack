import { riskExposure } from "./risk.mjs";

const DAY = 24 * 60 * 60 * 1000;
const pointBearingTypes = ["story", "task", "bug"];

export function totalPoints(items) {
  return items
    .filter((item) => pointBearingTypes.includes(item.type) && item.status !== "descoped")
    .reduce((sum, item) => sum + Number(item.points ?? 0), 0);
}

export function completedPoints(items, asOf) {
  const limit = asOf ? new Date(asOf).getTime() : Infinity;
  return items
    .filter((item) => item.status === "done" && item.completedAt && new Date(item.completedAt).getTime() <= limit)
    .reduce((sum, item) => sum + Number(item.points ?? 0), 0);
}

export function earnedValue(project, asOf) {
  const baseline = project.baseline;
  if (!baseline?.totalPoints || !baseline.targetDate) {
    return null;
  }
  const now = new Date(asOf ?? Date.now()).getTime();
  const start = new Date(baseline.setAt).getTime();
  const target = new Date(baseline.targetDate).getTime();
  const elapsedFraction = target > start ? clamp((now - start) / (target - start), 0, 1) : 1;
  const bac = baseline.totalPoints;
  const pv = bac * elapsedFraction;
  const done = project.workItems.filter((item) => item.status === "done");
  const ev = completedPoints(project.workItems, asOf);
  const ac = done.reduce((sum, item) => sum + Number(item.actualEffort ?? item.points ?? 0), 0);
  const spi = pv > 0 ? round(ev / pv) : null;
  const cpi = ac > 0 ? round(ev / ac) : null;
  const eac = cpi ? round(bac / cpi) : null;
  return {
    bac,
    pv: round(pv),
    ev: round(ev),
    ac: round(ac),
    spi,
    cpi,
    sv: round(ev - pv),
    cv: round(ev - ac),
    eac,
    eacTypical: round(ac + (bac - ev)),
    eacWorst: cpi && spi ? round(ac + (bac - ev) / (cpi * spi)) : null,
    etc: eac === null ? null : round(eac - ac),
    vac: eac === null ? null : round(bac - eac),
    tcpi: bac - ac > 0 ? round((bac - ev) / (bac - ac)) : null
  };
}

export function estimateAccuracy(items) {
  const measured = items.filter((item) => item.status === "done" && Number(item.actualEffort) > 0 && Number(item.points) > 0);
  if (!measured.length) {
    return null;
  }
  const errors = measured.map((item) => Math.abs(item.actualEffort - item.points) / item.points);
  const ratios = measured.map((item) => item.actualEffort / item.points);
  return {
    samples: measured.length,
    mape: round(errors.reduce((sum, value) => sum + value, 0) / errors.length),
    effortRatio: round(ratios.reduce((sum, value) => sum + value, 0) / ratios.length)
  };
}

export function throughputDrift(samples, { threshold = 4 } = {}) {
  if (samples.length < 4) {
    return { alarm: false, cusum: 0, mean: null, stdDev: null };
  }
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length;
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) {
    return { alarm: false, cusum: 0, mean: round(mean), stdDev: 0 };
  }
  const slack = 0.5 * stdDev;
  let cusum = 0;
  let peak = 0;
  for (const sample of samples) {
    cusum = Math.max(0, cusum + (mean - sample - slack));
    peak = Math.max(peak, cusum);
  }
  return { alarm: cusum > threshold * stdDev, cusum: round(cusum), peak: round(peak), mean: round(mean), stdDev: round(stdDev) };
}

export function velocity(sprints) {
  const closed = sprints
    .filter((sprint) => sprint.status === "closed")
    .sort((a, b) => new Date(a.end) - new Date(b.end));
  const samples = closed.map((sprint) => Number(sprint.completedPoints ?? 0));
  const window = samples.slice(-3);
  return {
    samples,
    average: window.length ? round(window.reduce((sum, value) => sum + value, 0) / window.length) : null
  };
}

export function burndown(sprint, items) {
  const committed = items.filter((item) => item.sprint === sprint.id && pointBearingTypes.includes(item.type));
  const scope = committed.reduce((sum, item) => sum + Number(item.points ?? 0), 0);
  const start = new Date(sprint.start).getTime();
  const end = new Date(sprint.end).getTime();
  const days = Math.max(1, Math.round((end - start) / DAY));
  const series = [];
  for (let day = 0; day <= days; day += 1) {
    const at = start + day * DAY;
    const burned = committed
      .filter((item) => item.completedAt && new Date(item.completedAt).getTime() <= at)
      .reduce((sum, item) => sum + Number(item.points ?? 0), 0);
    series.push({
      day,
      date: new Date(at).toISOString().slice(0, 10),
      remaining: round(scope - burned),
      ideal: round(scope * (1 - day / days))
    });
  }
  return { scope, days, series };
}

export function flowTimes(items) {
  const done = items.filter((item) => item.status === "done" && item.completedAt);
  const cycleSamples = done
    .filter((item) => item.startedAt)
    .map((item) => (new Date(item.completedAt) - new Date(item.startedAt)) / DAY);
  const leadSamples = done
    .filter((item) => item.createdAt)
    .map((item) => (new Date(item.completedAt) - new Date(item.createdAt)) / DAY);
  return {
    completed: done.length,
    cycleTimeDays: average(cycleSamples),
    leadTimeDays: average(leadSamples)
  };
}

export function weeklyThroughput(items, asOf) {
  const limit = asOf ? new Date(asOf).getTime() : Infinity;
  const done = items
    .filter((item) => item.status === "done" && item.completedAt && pointBearingTypes.includes(item.type))
    .filter((item) => new Date(item.completedAt).getTime() <= limit)
    .sort((a, b) => new Date(a.completedAt) - new Date(b.completedAt));
  if (!done.length) {
    return [];
  }
  const first = new Date(done[0].completedAt).getTime();
  const last = Math.max(first, new Date(asOf ?? done[done.length - 1].completedAt).getTime());
  const weeks = Math.max(1, Math.ceil((last - first + 1) / (7 * DAY)));
  const samples = new Array(weeks).fill(0);
  for (const item of done) {
    const week = Math.min(weeks - 1, Math.floor((new Date(item.completedAt).getTime() - first) / (7 * DAY)));
    samples[week] += Number(item.points ?? 0);
  }
  return samples;
}

export function cumulativeFlow(project, { days = 14, asOf } = {}) {
  const end = startOfDay(asOf ?? Date.now());
  const series = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const at = end - offset * DAY + DAY - 1;
    const counts = {};
    for (const item of project.workItems) {
      const status = statusAt(item, project.events ?? [], at);
      if (status) {
        counts[status] = (counts[status] ?? 0) + 1;
      }
    }
    series.push({ date: new Date(at).toISOString().slice(0, 10), counts });
  }
  return series;
}

export function scopeCreep(project) {
  if (!project.baseline?.totalPoints) {
    return null;
  }
  const current = totalPoints(project.workItems);
  return round((current - project.baseline.totalPoints) / project.baseline.totalPoints);
}

export function wipViolations(project) {
  const limits = project.board?.wipLimits ?? {};
  const violations = [];
  for (const [status, limit] of Object.entries(limits)) {
    const count = project.workItems.filter((item) => item.status === status).length;
    if (count > limit) {
      violations.push({ status, count, limit });
    }
  }
  return violations;
}

export function healthScore(project, { asOf, staleDays = 14 } = {}) {
  const now = new Date(asOf ?? Date.now()).getTime();
  const items = project.workItems;
  const active = items.filter((item) => !["done", "descoped"].includes(item.status));
  const reasons = [];

  const evm = earnedValue(project, asOf);
  let schedule = 70;
  if (evm?.spi !== null && evm?.spi !== undefined) {
    schedule = clamp(evm.spi * 100, 0, 100);
    if (evm.spi < 0.9) {
      reasons.push({ code: "schedule-behind", params: { spi: evm.spi } });
    }
  } else if (project.phase === "execution") {
    reasons.push({ code: "no-baseline", params: {} });
  }

  let flow = 100;
  const blocked = active.filter((item) => item.status === "blocked");
  if (blocked.length && active.length) {
    flow -= clamp((blocked.length / active.length) * 200, 0, 50);
    reasons.push({ code: "blocked-items", params: { count: blocked.length } });
  }
  const violations = wipViolations(project);
  for (const violation of violations) {
    flow -= 15;
    reasons.push({ code: "wip-exceeded", params: violation });
  }
  const stale = active.filter((item) => item.startedAt && ["in-progress", "in-review"].includes(item.status) && now - new Date(item.startedAt).getTime() > staleDays * DAY);
  if (stale.length) {
    flow -= clamp(stale.length * 10, 0, 30);
    reasons.push({ code: "stale-items", params: { count: stale.length, days: staleDays } });
  }
  flow = clamp(flow, 0, 100);

  const exposure = riskExposure(project.risks ?? []);
  const risk = clamp(100 - exposure.exposure * 100, 0, 100);
  if (exposure.worst && ["high", "critical"].includes(exposure.worst.band)) {
    reasons.push({ code: "high-risk-exposure", params: { band: exposure.worst.band, title: exposure.worst.title } });
  }

  let scope = 100;
  const creep = scopeCreep(project);
  if (creep !== null && creep > 0.1) {
    scope = clamp(100 - (creep - 0.1) * 200, 0, 100);
    reasons.push({ code: "scope-creep", params: { percent: Math.round(creep * 100) } });
  }

  if (project.phase === "execution" && !(project.sprints ?? []).some((sprint) => sprint.status === "active")) {
    reasons.push({ code: "no-active-sprint", params: {} });
  }

  const score = Math.round(schedule * 0.35 + flow * 0.3 + risk * 0.2 + scope * 0.15);
  const rag = score >= 75 ? "green" : score >= 50 ? "amber" : "red";
  return { score, rag, components: { schedule: Math.round(schedule), flow: Math.round(flow), risk: Math.round(risk), scope: Math.round(scope) }, reasons };
}

function statusAt(item, events, at) {
  if (new Date(item.createdAt).getTime() > at) {
    return null;
  }
  let status = item.initialStatus ?? "backlog";
  for (const event of events) {
    if (event.type === "status" && event.itemId === item.id && new Date(event.at).getTime() <= at) {
      status = event.to;
    }
  }
  return status;
}

function startOfDay(at) {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function average(samples) {
  return samples.length ? round(samples.reduce((sum, value) => sum + value, 0) / samples.length) : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value) {
  return Math.round(value * 100) / 100;
}
