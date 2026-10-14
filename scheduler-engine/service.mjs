import { SchedulerDaemon } from "./daemon.mjs";

/**
 * Daemon service: the scheduler tick loop.
 *
 * Wraps the existing SchedulerDaemon (its interval, pid file and tick) without
 * its process-level signal handling, which belongs to the daemon. While this
 * service runs, the scheduler pid file names the daemon process, so a separate
 * `astack schedule watch` refuses to start a second tick loop and
 * `astack schedule status` reports it as running.
 */
export function createService({ runtime, config = {}, log = () => {}, fail = () => {} }) {
  const interval = String(config.interval ?? runtime.configuration?.get?.("scheduler.tick_interval", "60s") ?? "60s");
  const watcher = new SchedulerDaemon(runtime.scheduler, { interval, root: runtime.workspaceRoot, log });
  let stopping = false;
  let running = false;
  let wake = null;
  let ownsPid = false;
  const state = { state: "stopped", interval, lastTickAt: null, lastResults: 0, totalRuns: 0, lastError: null };

  async function loop() {
    while (!stopping) {
      try {
        const results = await watcher.scheduler.tick();
        state.lastTickAt = new Date().toISOString();
        state.lastResults = results.length;
        state.totalRuns += results.length;
        for (const result of results) {
          log(result.id + " " + result.status + " — " + result.summary);
        }
        state.lastError = null;
      } catch (error) {
        state.lastError = error.message;
        log("tick failed: " + error.message);
      }
      if (stopping) {
        break;
      }
      await new Promise((resolve) => {
        wake = resolve;
        watcher.timer = setTimeout(resolve, watcher.intervalMs);
      });
    }
  }

  return {
    name: "scheduler",
    async start() {
      const existing = watcher.readPid();
      if (existing && existing.pid !== process.pid && watcher.alive(existing.pid)) {
        throw new Error("a standalone scheduler watcher is already running (pid " + existing.pid + "); stop it with: astack schedule stop");
      }
      watcher.writePid();
      ownsPid = true;
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
      clearTimeout(watcher.timer);
      wake?.();
      const deadline = Date.now() + 10000;
      while (running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (ownsPid && watcher.readPid()?.pid === process.pid) {
        watcher.clearPid();
      }
      ownsPid = false;
      state.state = "stopped";
    },
    status() {
      return { ...state, scheduler: runtime.scheduler.status() };
    }
  };
}
