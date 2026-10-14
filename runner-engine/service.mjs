import { parseInterval } from "../scheduler-engine/cron.mjs";

/**
 * Daemon service: drain the runner queue on a fixed cadence.
 *
 * Scheduled `agent` jobs and `run-agent` signal reactions only enqueue; this
 * loop is what executes them while no session is open.
 */
export function createService({ runtime, config = {}, log = () => {}, fail = () => {} }) {
  const intervalMs = toMs(config.interval ?? runtime.configuration?.get?.("runner.poll_interval", null), 15000);
  let timer = null;
  let running = false;
  let stopping = false;
  let wake = null;
  const state = { state: "stopped", lastDrainAt: null, executed: 0, lastError: null, intervalMs };

  async function loop() {
    while (!stopping) {
      try {
        const results = await runtime.runner.drain();
        state.lastDrainAt = new Date().toISOString();
        for (const result of results) {
          state.executed += 1;
          log(result.id + " " + result.status + " — " + String(result.summary ?? "").slice(0, 160));
        }
        state.lastError = null;
      } catch (error) {
        state.lastError = error.message;
        log("drain failed: " + error.message);
      }
      if (stopping) {
        break;
      }
      await new Promise((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, intervalMs);
      });
    }
  }

  return {
    name: "runner",
    async start() {
      if (!runtime.runner) {
        throw new Error("runtime.runner is not available");
      }
      stopping = false;
      running = true;
      state.state = "running";
      loop()
        .catch((error) => {
          state.state = "crashed";
          state.lastError = error.message;
          fail(error);
        })
        .finally(() => {
          running = false;
          if (state.state !== "crashed") {
            state.state = "stopped";
          }
        });
    },
    async stop() {
      stopping = true;
      clearTimeout(timer);
      wake?.();
      const deadline = Date.now() + 5000;
      while (running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      state.state = "stopped";
    },
    status() {
      const runner = runtime.runner?.status() ?? {};
      return { ...state, queued: runner.queued ?? 0, active: runner.active ?? [], spentTodayUsd: runner.spentTodayUsd ?? 0 };
    }
  };
}

function toMs(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "number") {
    return value;
  }
  try {
    return parseInterval(value);
  } catch {
    return fallback;
  }
}
