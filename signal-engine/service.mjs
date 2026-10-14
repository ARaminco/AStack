import { SignalServer } from "./http-server.mjs";

/**
 * Daemon service: the inbound webhook listener.
 *
 * Wraps the existing SignalServer with the host and port from
 * `signals.server` in astack.config.yaml (loopback by default).
 */
export function createService({ runtime, config = {}, log = () => {} }) {
  const server = runtime.configuration?.get?.("signals.server", {}) ?? {};
  const host = String(config.host ?? server.host ?? "127.0.0.1");
  const port = Number(config.port ?? server.port ?? 8787);
  const listener = new SignalServer(runtime.signals, {
    host,
    port,
    log,
    processImmediately: config.process_immediately ?? true,
    allowRemote: (config.allow_remote ?? server.allow_remote) === true,
    rateLimit: Number(config.rate_limit ?? server.rate_limit_per_minute ?? 60)
  });
  const state = { state: "stopped", host, port, startedAt: null };
  return {
    name: "signals",
    async start() {
      await listener.start();
      listener.server.on("error", (error) => {
        state.state = "crashed";
        state.lastError = error.message;
      });
      state.state = "running";
      state.startedAt = new Date().toISOString();
    },
    async stop() {
      await listener.stop();
      state.state = "stopped";
    },
    status() {
      return { ...state, url: "http://" + host + ":" + port, signals: runtime.signals.status() };
    }
  };
}
