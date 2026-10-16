import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "../delivery-engine/cli.mjs";
import { judgeCommand, readGuardState } from "../bin/astack-guard.mjs";

const out = (line) => console.log(line);

/**
 * astack guard status|on|off|freeze <dir>|unfreeze|check "<command>"|log
 *
 * The guard is the PreToolUse hook that `astack interop sync` installs for
 * Claude Code. Its switch and freeze live in .astack/guard/state.json, so a
 * change takes effect on the next tool call without re-wiring anything.
 */
export function runGuardCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "status", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const root = runtime.workspaceRoot ?? runtime.root;
  const dir = join(root, ".astack", "guard");
  const path = join(dir, "state.json");
  const state = readGuardState(root);
  const save = (next) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify({ ...next, updatedAt: new Date().toISOString() }, null, 2) + "\n", "utf8");
  };

  if (action === "status") {
    out(t("cli.guard.status", {
      state: state.enabled === false ? "off" : "on",
      freeze: state.freeze ?? "-",
      events: existsSync(join(dir, "events.jsonl")) ? readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).length : 0
    }));
    return;
  }
  if (action === "on" || action === "off") {
    save({ ...state, corrupt: undefined, enabled: action === "on" });
    out(t(action === "on" ? "cli.guard.on" : "cli.guard.off"));
    return;
  }
  if (action === "freeze") {
    const target = positionals[0];
    if (!target) {
      throw new Error(t("cli.guard.freezeNeedsDir"));
    }
    const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const absolute = resolve(projectDir, target);
    if (!existsSync(absolute)) {
      throw new Error(t("cli.guard.freezeMissing", { dir: target }));
    }
    save({ ...state, corrupt: undefined, freeze: relative(projectDir, absolute).split("\\").join("/") || "." });
    out(t("cli.guard.frozen", { dir: target }));
    return;
  }
  if (action === "unfreeze") {
    const { freeze, corrupt, ...restState } = state;
    save(restState);
    out(t("cli.guard.unfrozen"));
    return;
  }
  if (action === "check") {
    const verdict = judgeCommand(positionals.join(" "));
    out(verdict.decision + (verdict.reason ? " — " + verdict.reason : ""));
    return;
  }
  if (action === "log") {
    const file = join(dir, "events.jsonl");
    const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
    for (const line of lines.slice(-Number(flags.limit ?? 20))) {
      out(line);
    }
    return;
  }
  throw new Error(t("cli.guard.unknownAction", { action }));
}
