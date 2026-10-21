import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MARKER = "astack-economy-hook.mjs";
const STEPS = [
  ["PreToolUse", "Agent|Task", "route"],
  ["PreToolUse", "*", "tool"],
  ["SubagentStart", null, "subagent-start"],
  ["SubagentStop", null, "subagent-stop"],
  ["UserPromptSubmit", null, "prompt"]
];

const quote = (path) => "\"" + path.replace(/\\/g, "/") + "\"";

/**
 * Account-wide economy hooks in ~/.claude/settings.json.
 *
 * Usage limits belong to the account, not to a project, and the costliest chats often run in folders whose AStack
 * core sits in a sub-folder (the lawyer practice) or that have no AStack at all. The global hooks point at the
 * canonical core (~/.astack/core) and step aside wherever a project wires its own economy hooks, so no call is
 * counted twice. The default sub-agent model is set only when the owner has not chosen one.
 */
export function planGlobalSettings(current, { hookPath, enable = true, defaultModel = "sonnet" } = {}) {
  const next = JSON.parse(JSON.stringify(current ?? {}));
  const hooks = { ...(next.hooks ?? {}) };
  for (const event of new Set(STEPS.map(([event]) => event))) {
    const kept = (hooks[event] ?? [])
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !String(hook.command ?? "").includes(MARKER)) }))
      .filter((group) => group.hooks.length);
    if (kept.length) {
      hooks[event] = kept;
    } else {
      delete hooks[event];
    }
  }
  const env = { ...(next.env ?? {}) };
  const owned = next.astackEconomy?.ownsSubagentModel === true;
  if (enable) {
    for (const [event, matcher, step] of STEPS) {
      hooks[event] = [...(hooks[event] ?? []), {
        ...(matcher ? { matcher } : {}),
        hooks: [{ type: "command", command: "node " + quote(hookPath) + " " + step + " --global", timeout: 5 }]
      }];
    }
    if (!env.CLAUDE_CODE_SUBAGENT_MODEL) {
      env.CLAUDE_CODE_SUBAGENT_MODEL = defaultModel;
      next.astackEconomy = { ownsSubagentModel: true };
    }
  } else {
    if (owned) {
      delete env.CLAUDE_CODE_SUBAGENT_MODEL;
    }
    delete next.astackEconomy;
  }
  next.hooks = hooks;
  if (Object.keys(hooks).length === 0) {
    delete next.hooks;
  }
  next.env = env;
  if (Object.keys(env).length === 0) {
    delete next.env;
  }
  return next;
}

export function userSettingsPath(home = homedir()) {
  return join(home, ".claude", "settings.json");
}

/** Writes the plan atomically after a dated backup of the owner's file. */
export function applyGlobalSettings({ home = homedir(), hookPath, enable = true, defaultModel = "sonnet", clock = () => new Date() } = {}) {
  const path = userSettingsPath(home);
  const current = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const next = planGlobalSettings(current, { hookPath, enable, defaultModel });
  mkdirSync(dirname(path), { recursive: true });
  let backup = null;
  if (existsSync(path)) {
    backup = path + ".astack-backup-" + clock().toISOString().replace(/[:.]/g, "-");
    copyFileSync(path, backup);
  }
  const temp = path + ".tmp-" + process.pid;
  writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", "utf8");
  renameSync(temp, path);
  return { path, backup, enabled: enable, subagentModel: next.env?.CLAUDE_CODE_SUBAGENT_MODEL ?? null };
}

/** True when the project wires its own economy hooks, so the global copy must not run as well. */
export function projectHasOwnHooks(root) {
  for (const name of ["settings.json", "settings.local.json"]) {
    const path = join(root ?? "", ".claude", name);
    try {
      const settings = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
      const commands = Object.values(settings.hooks ?? {}).flat().flatMap((group) => group?.hooks ?? []).map((hook) => String(hook.command ?? ""));
      if (commands.some((command) => command.includes(MARKER) && !/\s--global\s*$/.test(command))) {
        return true;
      }
    } catch {
      // An unreadable project file never disables the global hooks.
    }
  }
  return false;
}
