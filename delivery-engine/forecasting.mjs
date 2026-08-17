const DAY = 24 * 60 * 60 * 1000;

export function createRandom(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function monteCarloForecast({ remainingPoints, throughputSamples, runs = 5000, seed = 42, maxPeriods = 520 }) {
  const samples = (throughputSamples ?? []).filter((sample) => Number.isFinite(sample) && sample >= 0);
  if (remainingPoints <= 0) {
    return { periods: { p50: 0, p85: 0, p95: 0 }, runs, basedOnSamples: samples.length };
  }
  if (!samples.some((sample) => sample > 0)) {
    return null;
  }
  const random = createRandom(seed);
  const outcomes = [];
  for (let run = 0; run < runs; run += 1) {
    let remaining = remainingPoints;
    let periods = 0;
    while (remaining > 0 && periods < maxPeriods) {
      remaining -= samples[Math.floor(random() * samples.length)];
      periods += 1;
    }
    outcomes.push(periods);
  }
  outcomes.sort((a, b) => a - b);
  return {
    periods: { p50: percentile(outcomes, 0.5), p85: percentile(outcomes, 0.85), p95: percentile(outcomes, 0.95) },
    runs,
    basedOnSamples: samples.length
  };
}

export function forecastDates({ forecast, from, periodDays = 7 }) {
  if (!forecast) {
    return null;
  }
  const start = new Date(from).getTime();
  const toDate = (periods) => new Date(start + periods * periodDays * DAY).toISOString().slice(0, 10);
  return {
    p50: toDate(forecast.periods.p50),
    p85: toDate(forecast.periods.p85),
    p95: toDate(forecast.periods.p95)
  };
}

function percentile(sorted, fraction) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}
