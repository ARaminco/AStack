import { join, resolve } from "node:path";
import { parseArgs } from "../delivery-engine/cli.mjs";
import { EconomyEngine, renderStatus } from "../economy-engine/economy-engine.mjs";
import { delegate } from "../economy-engine/delegate.mjs";
import { readEconomyConfig, updateJson } from "../economy-engine/storage.mjs";

export async function runEconomyCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "status", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const root = runtime.workspaceRoot ?? runtime.root;
  const engine = new EconomyEngine({ root });
  if (["status", "report"].includes(action)) {
    if (flags.since && !Number.isFinite(Date.parse(flags.since))) {
      throw new Error(t("cli.economy.invalidSince"));
    }
    const report = await engine.status({ since: flags.since ?? null, probes: action === "status" });
    console.log(flags.json ? JSON.stringify(report, null, 2) : renderStatus(report, i18n));
    return;
  }
  if (action === "route") {
    const type = typeof flags.test === "string" ? flags.test : positionals.shift();
    console.log(JSON.stringify(engine.decision({ subagent_type: type, description: positionals.join(" "), prompt: positionals.join(" ") }), null, 2));
    return;
  }
  if (["on", "off", "set"].includes(action)) {
    const key = action === "set" ? positionals[0]?.replace(/^economy\./, "") : "enabled";
    let value = action === "set" ? positionals[1] : action === "on";
    if (!key || action === "set" && value === undefined || key.split(".").some((part) => !/^[a-z][a-z0-9_-]*$/i.test(part) || ["__proto__", "constructor", "prototype"].includes(part))) {
      throw new Error(t("cli.economy.invalidSetting"));
    }
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        // Model aliases and URLs are ordinary string values.
      }
    }
    updateJson(join(root, ".astack", "economy", "state.json"), (state) => {
      const parts = key.split(".");
      let target = state;
      for (const part of parts.slice(0, -1)) {
        target[part] = target[part] && typeof target[part] === "object" ? target[part] : {};
        target = target[part];
      }
      target[parts.at(-1)] = value;
      return state;
    });
    if (runtime.interop) {
      runtime.interop.economyConfig = readEconomyConfig(root);
      runtime.interop.sync();
    }
    console.log(t("cli.economy.saved", { key, value: JSON.stringify(value) }));
    return;
  }
  throw new Error(t("cli.economy.unknownAction", { action }));
}

export async function runDelegateCommand({ runtime, i18n, tokens }) {
  const images = [];
  const remaining = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === "--image" && tokens[index + 1]) {
      images.push(tokens[++index]);
    } else if (tokens[index].startsWith("--image=")) {
      images.push(tokens[index].slice(8));
    } else {
      remaining.push(tokens[index]);
    }
  }
  const { positionals, flags } = parseArgs(remaining);
  const root = runtime.workspaceRoot ?? runtime.root;
  const result = await delegate({ task: positionals.join(" "), to: flags.to ?? "auto", mode: flags.mode ?? "read", effort: flags.effort ?? "medium", cwd: resolve(flags.cwd ?? root), schema: flags.schema, schema_json: flags.schemaJson, images, config: readEconomyConfig(root) });
  if (!result.ok) {
    console.log(i18n.t("cli.economy.delegateFailed", { reason: result.reason }));
    process.exitCode = 1;
    return;
  }
  console.log(result.output);
  console.log(i18n.t("cli.economy.delegated", { engine: result.engine, usage: JSON.stringify(result.usage) }));
}
