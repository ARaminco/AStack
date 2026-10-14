import { parseArgs } from "../delivery-engine/cli.mjs";
import { A2A_TOKEN_REFERENCE } from "../interop-engine/a2a-server.mjs";

const out = (line) => console.log(line);

/**
 * astack a2a serve [--host h] [--port p] | card | status
 */
export async function runA2ACommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "status", ...rest] = tokens;
  const { flags } = parseArgs(rest);
  const a2a = runtime.a2a;

  if (action === "card") {
    out(JSON.stringify(a2a.card(), null, 2));
    return;
  }
  if (action === "status") {
    const status = a2a.status();
    out(t("cli.a2a.statusTitle", { host: status.host, port: status.port, path: status.path, mode: status.mode, ceiling: status.ceiling }));
    out("- " + t(status.tokenConfigured ? "cli.a2a.tokenReady" : "cli.a2a.tokenMissing", { reference: A2A_TOKEN_REFERENCE }));
    out("- tasks: " + status.tasks + (status.tasks ? " (" + Object.entries(status.byState).map(([state, count]) => state + " " + count).join(", ") + ")" : ""));
    return;
  }
  if (action === "serve") {
    if (!a2a.status().tokenConfigured) {
      throw new Error(t("cli.a2a.tokenMissing", { reference: A2A_TOKEN_REFERENCE }));
    }
    const address = await a2a.listen({ host: flags.host ? String(flags.host) : null, port: flags.port ? Number(flags.port) : null });
    out(t("cli.a2a.listening", { url: address.url, mode: a2a.status().mode, ceiling: a2a.ceiling() }));
    await new Promise((resolve) => {
      const stop = () => resolve();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    await a2a.close();
    return;
  }
  throw new Error(t("cli.a2a.unknownAction", { action }));
}
