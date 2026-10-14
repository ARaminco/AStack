/**
 * Daemon service (contract in documentation/V3-Plan.md): periodic incremental
 * reindex so recall stays current without anyone running `search reindex`.
 *
 * Config (all optional, under `search:`): `enabled`, `reindex_every`
 * (e.g. 15m, 1h, 90s; default 15m), `reindex_on_start` (default true).
 */
export function parseInterval(value, fallbackMs = 15 * 60 * 1000) {
  if (typeof value === "number" && value > 0) {
    return value * 1000;
  }
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(String(value ?? "").trim());
  if (!match) {
    return fallbackMs;
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  return Math.max(1000, amount * { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit]);
}

export function createService({ runtime, config = null, log = () => {} } = {}) {
  const settings = config && Object.keys(config).length ? config : runtime?.configuration?.section?.("search", {}) ?? {};
  const everyMs = parseInterval(settings.reindex_every, 15 * 60 * 1000);
  const state = { running: false, timer: null, startTimer: null, lastRun: null, lastError: null, lastReport: null, runs: 0 };

  async function tick() {
    if (state.running || !runtime?.search) {
      return;
    }
    state.running = true;
    try {
      const report = await runtime.search.index({});
      state.lastReport = {
        durationMs: report.durationMs,
        embedded: report.embedded,
        indexed: Object.values(report.sources).reduce((sum, entry) => sum + entry.indexed, 0)
      };
      state.lastError = null;
      state.runs += 1;
      log("search: reindexed in " + report.durationMs + "ms (" + state.lastReport.indexed + " changed unit(s), " + report.embedded + " embedded)");
    } catch (error) {
      state.lastError = String(error?.message ?? error);
      log("search: reindex failed: " + state.lastError);
    } finally {
      state.lastRun = new Date().toISOString();
      state.running = false;
    }
  }

  return {
    name: "search",
    async start() {
      if (settings.enabled === false || state.timer) {
        return;
      }
      state.timer = setInterval(tick, everyMs);
      state.timer.unref?.();
      if (settings.reindex_on_start !== false) {
        state.startTimer = setTimeout(tick, 2000);
        state.startTimer.unref?.();
      }
    },
    async stop() {
      clearInterval(state.timer);
      clearTimeout(state.startTimer);
      state.timer = null;
      state.startTimer = null;
    },
    status() {
      return {
        enabled: settings.enabled !== false,
        active: Boolean(state.timer),
        everyMs,
        running: state.running,
        runs: state.runs,
        lastRun: state.lastRun,
        lastError: state.lastError,
        lastReport: state.lastReport
      };
    },
    tick
  };
}
