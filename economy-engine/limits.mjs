import { join } from "node:path";
import { economyDirectory, readJson, updateJson } from "./storage.mjs";

const percentage = (value) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;

export class Limits {
  constructor({ directory = economyDirectory(), config = {}, clock = () => Date.now() } = {}) {
    Object.assign(this, { directory, config, clock });
    this.path = join(directory, "limits.json");
  }

  read() {
    return readJson(this.path);
  }

  capture(input) {
    return updateJson(this.path, (value) => {
      if (input.rate_limits) {
        value.claude = { rate_limits: input.rate_limits, capturedAt: this.clock() };
      }
      if (input.session_id) {
        value.sessions ??= {};
        value.sessions[input.session_id] = { context: input.context_window, model: input.model, capturedAt: this.clock() };
      }
      return value;
    });
  }

  captureCodex(codex) {
    if (codex?.rate_limits) {
      updateJson(this.path, (value) => value.codex?.capturedAt > codex.capturedAt ? value : { ...value, codex: { rate_limits: codex.rate_limits, capturedAt: codex.capturedAt } });
    }
  }

  pressure(snapshot = null) {
    const capture = this.read().claude;
    const ageMs = capture ? this.clock() - capture.capturedAt : null;
    const limits = capture?.rate_limits;
    const weekly = percentage(limits?.seven_day?.used_percentage);
    const fiveHour = percentage(limits?.five_hour?.used_percentage);
    const fresh = ageMs !== null && ageMs <= (this.config.limits_max_age_ms ?? 1800000);
    const thresholds = { seven_day: [50, 70, 85], five_hour: [70, 85, 95], ...this.config.thresholds };
    const level = (value, values) => value === null ? 0 : values.reduce((rank, threshold) => rank + Number(value >= threshold), 0);
    if (fresh && (weekly !== null || fiveHour !== null)) {
      // Pace: 40% of the week gone on its first day is a problem even though 40% is below every threshold.
      // Compare the weekly share used with the share of the week that has passed.
      const resetsAt = Number(limits?.seven_day?.resets_at) * 1000;
      const weekMs = 7 * 24 * 3600 * 1000;
      const expected = weekly !== null && resetsAt > 0 ? Math.min(100, Math.max(0, (1 - (resetsAt - this.clock()) / weekMs) * 100)) : null;
      const ahead = expected === null ? null : weekly - expected;
      const pace = { amber: 20, red: 35, ...this.config.pace };
      const paceRank = ahead === null ? 0 : ahead >= pace.red ? 2 : ahead >= pace.amber ? 1 : 0;
      const rank = Math.max(level(weekly, thresholds.seven_day), level(fiveHour, thresholds.five_hour), paceRank);
      return { pressure: ["green", "amber", "red", "critical"][rank], source: "official", weekly, fiveHour, ageMs, expected, ahead, rate_limits: limits };
    }
    const summary = snapshot ?? readJson(join(this.directory, "meter-cache.json")).summary;
    const budget = Number(this.config.weekly_budget_units);
    if (budget > 0 && summary?.windows && this.clock() - summary.capturedAt <= 1800000) {
      const estimate = summary.windows.sevenDay.units / budget * 100;
      return { pressure: ["green", "amber", "red", "critical"][level(estimate, thresholds.seven_day)], source: "estimate", weekly: estimate, fiveHour: null, ageMs };
    }
    return { pressure: "unknown", source: "unknown", weekly: null, fiveHour: null, ageMs };
  }
}
