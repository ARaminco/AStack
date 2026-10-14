/**
 * Daemon service for the board (daemon contract, see documentation/V3-Plan.md).
 *
 * Every tick runs the cards that are ready on every active board, once, up to
 * each board's parallel limit. Ticks never overlap; a board already being run
 * by another process (`astack board run`) is skipped through its lock.
 */
export function createService({ runtime, config = {}, log = () => {} } = {}) {
  const section = config?.board ?? config ?? {};
  const fromRuntime = runtime?.configuration?.section?.("board", {}) ?? {};
  const intervalMs = Math.max(1000, Number(section.tick_ms ?? fromRuntime.tick_ms ?? 15000));
  let timer = null;
  let busy = false;
  let lastTick = null;
  let lastResult = null;
  let lastError = null;
  let ticks = 0;

  async function tick() {
    if (busy || !runtime?.board) {
      return;
    }
    busy = true;
    try {
      const results = await runtime.board.tick();
      ticks += 1;
      lastTick = new Date().toISOString();
      lastResult = results.map((entry) => ({ board: entry.board, started: entry.started?.length ?? 0, skipped: entry.skipped ?? null }));
      lastError = null;
      const started = lastResult.reduce((total, entry) => total + entry.started, 0);
      if (started) {
        log("board: started " + started + " card attempt(s)");
      }
    } catch (error) {
      lastError = error.message;
      log("board: tick failed: " + error.message);
    } finally {
      busy = false;
    }
  }

  return {
    name: "board",
    async start() {
      if (timer) {
        return;
      }
      timer = setInterval(() => {
        tick();
      }, intervalMs);
      timer.unref?.();
      await tick();
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    status() {
      return { running: Boolean(timer), intervalMs, busy, ticks, lastTick, lastResult, lastError, runner: Boolean(runtime?.runner) };
    },
    tick
  };
}
