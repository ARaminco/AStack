import { join } from "node:path";
import { BridgeManager } from "./bridge-manager.mjs";
import { GatewayListener } from "./listener.mjs";

/**
 * Daemon service contract (see documentation/V3-Plan.md):
 *   createService({ runtime, config, log }) -> { name, start, stop, status }
 *
 * Starts one poll loop per enabled pull channel (Telegram and the bridge long
 * poll, wapi polls on an interval), the webhook listener when a push channel
 * is enabled, the linked-device bridge when that channel is enabled, and the
 * live approval subscription. Does nothing unless `gateway.enabled: true`.
 */
export function createService({ runtime, config = null, log = console.log } = {}) {
  const engine = runtime.gateway;
  const loops = new Map();
  let listener = null;
  let bridge = null;
  let started = false;
  let controller = null;
  const errors = [];

  const settings = () => ({ ...engine.settings(), ...(config ?? {}) });

  async function loop(id) {
    const instance = engine.channel(id);
    const longPoll = instance.kind === "telegram" || id === "whatsapp-bridge";
    let failures = 0;
    while (started) {
      const result = await engine.pollOnce({ channel: id, timeoutS: longPoll ? Number(settings().long_poll_s) : 0, signal: controller.signal }).catch((error) => ({ channels: [{ channel: id, error: error.message }] }));
      const failed = result.channels?.find((entry) => entry.error);
      if (failed && started) {
        failures += 1;
        errors.push({ channel: id, at: new Date().toISOString(), error: failed.error });
        errors.splice(0, Math.max(0, errors.length - 20));
        log("[gateway] " + id + ": " + failed.error);
      } else {
        failures = 0;
      }
      const wait = failures ? Math.min(60, 2 ** failures) * 1000 : longPoll ? 200 : Number(settings().poll_interval_s) * 1000;
      await sleep(wait, controller.signal);
    }
  }

  return {
    name: "gateway",
    async start() {
      engine.bind(runtime);
      if (settings().enabled !== true) {
        log("[gateway] disabled (gateway.enabled is not true)");
        return;
      }
      started = true;
      controller = new AbortController();
      engine.live = true;
      engine.subscribe();
      const channels = engine.enabledChannels();
      if (channels.includes("whatsapp-bridge")) {
        bridge = new BridgeManager(join(engine.directory, "bridge"), { policy: runtime.automationPolicy, config: engine.channelConfig("whatsapp-bridge"), log });
        const result = await bridge.start({ allowedUsers: engine.owners("whatsapp-bridge"), allowedGroups: engine.groups("whatsapp-bridge") });
        if (!result.ok) {
          log("[gateway] whatsapp bridge not started: " + result.reason);
        }
      }
      if (channels.some((id) => engine.channel(id).mode === "webhook")) {
        const options = settings().listener;
        listener = new GatewayListener(engine, { host: options.host, port: options.port, log, allowRemote: options.allow_remote === true });
        await listener.start();
        log("[gateway] webhook listener on http://" + listener.host + ":" + listener.port);
      }
      for (const id of channels) {
        if (engine.channel(id).mode === "poll") {
          loops.set(id, loop(id));
        }
      }
      log("[gateway] started: " + channels.join(", "));
    },
    async stop() {
      started = false;
      engine.live = false;
      controller?.abort();
      await Promise.allSettled([...loops.values()]);
      loops.clear();
      if (listener) {
        await listener.drain();
        await listener.stop();
        listener = null;
      }
      // The bridge keeps running on purpose: restarting the daemon must not
      // drop the WhatsApp session. `astack gateway whatsapp stop` stops it.
    },
    status() {
      return {
        started,
        channels: [...loops.keys()],
        listener: listener ? listener.host + ":" + listener.port : null,
        errors: errors.slice(-5),
        gateway: engine.status()
      };
    }
  };
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
