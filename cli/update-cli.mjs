import { join, resolve } from "node:path";
import { parseArgs } from "../delivery-engine/cli.mjs";
import { UpdatePipeline } from "../upgrade-engine/update-pipeline.mjs";

const out = (line) => console.log(line);

export function runUpdateCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [first, ...rest] = tokens;
  const action = first && !first.startsWith("--") ? first : "run";
  const { flags } = parseArgs(action === "run" ? tokens : rest);
  const target = resolve(String(flags.target ?? runtime.workspaceRoot ?? runtime.root));
  const pipeline = new UpdatePipeline({
    target,
    source: flags.from ? String(flags.from) : null,
    version: flags.version ? String(flags.version) : null,
    channel: flags.channel ? String(flags.channel) : null,
    flags,
    log: (entry) => out((entry.ok ? "✓ " : "✗ ") + t("cli.update.stage." + entry.stage) + " — " + entry.detail)
  });

  if (action === "history") {
    const entries = pipeline.history({ limit: Number(flags.limit ?? 10) });
    out(t("cli.update.historyTitle", { count: entries.length }));
    for (const entry of entries) {
      out("- " + String(entry.at).slice(0, 16).replace("T", " ") + " " + entry.from + " → " + entry.to + " (" + (entry.ref ?? "-") + ") " + entry.result);
    }
    return;
  }
  if (action === "rollback") {
    const backup = flags.backup ? resolve(String(flags.backup)) : pipeline.history().find((entry) => entry.backup && entry.result === "updated")?.backup;
    if (!backup) {
      throw new Error(t("cli.update.noBackup"));
    }
    const restored = pipeline.rollback(backup);
    pipeline.record({ from: null, to: restored.version, ref: "rollback", result: "rolled-back", backup });
    out(t("cli.update.rolledBack", { ...restored, backup }));
    out(t("cli.update.rollbackSetup", { command: "node " + join(target, "bin", "astack.mjs") + " setup" }));
    return;
  }
  if (action !== "run") {
    throw new Error(t("cli.update.unknownAction", { action }));
  }

  out(t("cli.update.title", { target, source: pipeline.source, channel: flags.version ? "v" + String(flags.version).replace(/^v/, "") : pipeline.channel }));
  const result = pipeline.run();
  if (result.check) {
    out(t("cli.update.checkOnly"));
  } else if (result.rolledBack) {
    out(t("cli.update.rolledBackSummary", { from: result.from, to: result.to }));
  } else if (result.ok) {
    out(t(result.result === "current" ? "cli.update.current" : "cli.update.done", { from: result.from, to: result.to }));
  } else {
    out(t("cli.update.failed"));
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
}
