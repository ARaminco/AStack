import { parseArgs } from "../delivery-engine/cli.mjs";
import { respawnLocal, setupCore, setupLocal } from "../installer/setup.mjs";
import { runUpdateCommand } from "./update-cli.mjs";

const out = (line) => console.log(line);

export function runSetupCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const { flags } = parseArgs(tokens);
  if (flags.update) {
    // "Set up and update" is the update pipeline, which runs setup itself.
    runUpdateCommand({ runtime, i18n, tokens: tokens.filter((token) => token !== "--update") });
    return;
  }

  if (flags.stage !== "local") {
    out(t("cli.setup.title"));
    const core = setupCore({ coreRoot: runtime.root, flags });
    if (core.core) {
      out("- " + t("cli.setup.core." + core.core.action, { target: core.target, from: core.core.from ?? "-", to: core.core.to, files: core.core.files }));
      if (core.core.configSections?.length) {
        out("  " + t("cli.upgrade.configAdded", { sections: core.core.configSections.join(", ") }));
      }
      if (core.core.backup) {
        out("  " + t("cli.setup.backup", { backup: core.core.backup }));
      }
    }
    if (core.respawn) {
      // The code on disk changed under this process, so the rest runs in the
      // target with the new code.
      process.exitCode = respawnLocal(core.target, flags);
      return;
    }
  }

  const result = setupLocal({ runtime, flags });
  for (const entry of result.steps) {
    const mark = entry.ok ? "✓" : entry.optional ? "!" : "✗";
    out("- " + mark + " " + t("cli.setup.step." + entry.step) + ": " + entry.detail);
  }
  out(result.parity ? t("cli.interop.parityOk") : t("cli.interop.parityMissing"));
  out(t("cli.setup.manualTitle"));
  out("- " + t("cli.setup.manualCodex"));
  out("- " + t("cli.setup.manualClaude"));
  out(result.ok ? t("cli.setup.done", { target: result.target }) : t("cli.setup.failed"));
  if (!result.ok) {
    process.exitCode = 1;
  }
}
