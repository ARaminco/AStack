import { ConsoleServer, resolveConsoleSettings } from "./server.mjs";

/**
 * Daemon service contract (see documentation/V3-Plan.md): the daemon loads this
 * file when it exists and `console` is enabled in `daemon.services`.
 *
 * Under the daemon the console never binds beyond loopback unless the config
 * says `console.allow_remote: true` — there is no command line to type `--host`.
 */
export function createService({ runtime, config = null, log = console.log } = {}) {
  // The daemon passes its own `daemon.console` block (usually empty); the
  // owner's `console:` section is the base and daemon keys only override it.
  const section = { ...(runtime?.configuration?.section?.("console", {}) ?? {}), ...(config ?? {}) };
  let server = null;
  let lastError = null;
  return {
    name: "console",
    async start() {
      if (section.enabled === false) {
        return;
      }
      const settings = resolveConsoleSettings(section);
      for (const warning of settings.warnings) {
        log("[console] " + warning);
      }
      server = new ConsoleServer({ runtime, ...settings, log });
      try {
        await server.start();
        log("[console] Aramin on " + server.origin + " (token: astack console token)");
        const remote = server.describe().remote;
        if (remote?.running) {
          log("[console] internet listener on " + remote.url + " for " + remote.publicUrl + " (password + TOTP" + (remote.access ? ", Cloudflare Access" : "") + ")");
        }
      } catch (error) {
        lastError = error.message;
        server = null;
        throw error;
      }
    },
    async stop() {
      if (server) {
        await server.stop();
        server = null;
      }
    },
    status() {
      return server ? server.describe() : { running: false, enabled: section.enabled !== false, error: lastError };
    }
  };
}
