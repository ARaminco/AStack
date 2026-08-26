const UNITS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000, w: 7 * 24 * 60 * 60 * 1000 };

const FIELD_RANGES = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dayOfWeek", min: 0, max: 6 }
];

const ALIASES = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *"
};

export function parseInterval(value) {
  const match = /^(\d+)\s*(s|m|h|d|w)$/.exec(String(value ?? "").trim().toLowerCase());
  if (!match) {
    throw new Error("Invalid interval: " + value + ". Use forms like 30s, 10m, 4h, 1d, 1w");
  }
  const milliseconds = Number(match[1]) * UNITS[match[2]];
  if (milliseconds <= 0) {
    throw new Error("Interval must be positive: " + value);
  }
  return milliseconds;
}

function expandField(expression, { min, max }) {
  const allowed = new Set();
  for (const part of String(expression).split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error("Invalid cron step: " + part);
    }
    let start = min;
    let end = max;
    if (range !== "*") {
      const bounds = range.split("-");
      start = Number(bounds[0]);
      end = bounds.length > 1 ? Number(bounds[1]) : bounds[0] === range && !stepText ? Number(bounds[0]) : max;
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        throw new Error("Invalid cron field: " + part);
      }
      if (start < min || end > max || start > end) {
        throw new Error("Cron field out of range: " + part);
      }
    }
    for (let value = start; value <= end; value += step) {
      allowed.add(value);
    }
  }
  return allowed;
}

export function parseCron(expression) {
  const normalized = ALIASES[String(expression).trim().toLowerCase()] ?? String(expression).trim();
  const fields = normalized.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error("Cron expression needs 5 fields (minute hour day month weekday): " + expression);
  }
  return fields.map((field, index) => expandField(field, FIELD_RANGES[index]));
}

/**
 * Next matching wall clock time for a cron expression, scanned minute by
 * minute. The scan is bounded to four years so an impossible expression fails
 * loudly instead of spinning.
 */
export function nextCron(expression, from = new Date()) {
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parseCron(expression);
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = 60 * 24 * 366 * 4;
  for (let step = 0; step < limit; step += 1) {
    if (
      minutes.has(cursor.getMinutes()) &&
      hours.has(cursor.getHours()) &&
      months.has(cursor.getMonth() + 1) &&
      matchesDay(cursor, daysOfMonth, daysOfWeek)
    ) {
      return new Date(cursor.getTime());
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  throw new Error("Cron expression never matches: " + expression);
}

function matchesDay(date, daysOfMonth, daysOfWeek) {
  const domRestricted = daysOfMonth.size !== 31;
  const dowRestricted = daysOfWeek.size !== 7;
  const domMatch = daysOfMonth.has(date.getDate());
  const dowMatch = daysOfWeek.has(date.getDay());
  if (domRestricted && dowRestricted) {
    return domMatch || dowMatch;
  }
  if (domRestricted) {
    return domMatch;
  }
  if (dowRestricted) {
    return dowMatch;
  }
  return true;
}

/**
 * Resolve the next run for any supported schedule shape.
 */
export function nextRun(schedule, { from = new Date(), lastRun = null } = {}) {
  const reference = new Date(from);
  if (schedule?.cron) {
    return nextCron(schedule.cron, reference).toISOString();
  }
  if (schedule?.every) {
    const step = parseInterval(schedule.every);
    const base = lastRun ? new Date(lastRun).getTime() : reference.getTime();
    let next = base + step;
    if (next <= reference.getTime()) {
      const missed = Math.ceil((reference.getTime() - base) / step);
      next = base + missed * step;
      if (next <= reference.getTime()) {
        next += step;
      }
    }
    return new Date(next).toISOString();
  }
  if (schedule?.at) {
    const at = new Date(schedule.at);
    if (Number.isNaN(at.getTime())) {
      throw new Error("Invalid schedule time: " + schedule.at);
    }
    return at.toISOString();
  }
  throw new Error("A schedule needs one of: every, cron, at");
}

export function describeSchedule(schedule) {
  if (schedule?.cron) {
    return "cron " + schedule.cron;
  }
  if (schedule?.every) {
    return "every " + schedule.every;
  }
  if (schedule?.at) {
    return "once at " + schedule.at;
  }
  return "unscheduled";
}

export { UNITS };
