#!/usr/bin/env node
/**
 * AStack guard: a PreToolUse hook for Claude Code (3.5.0; adapted from the
 * careful/freeze hooks of gstack, MIT, © 2026 Garry Tan).
 *
 * Reads the hook payload on stdin and answers with a permission decision:
 * - deny: catastrophic commands and the owner's production rules
 *   (`rm -rf /`, force-push to the default branch, `pm2 restart all`, …);
 * - ask: destructive commands that are sometimes right (`git reset --hard`,
 *   `DROP TABLE`, `migrate:fresh`, `rm -rf` outside build folders, …);
 * - freeze: while `astack guard freeze <dir>` is on, edits outside that folder
 *   are denied, and anything it cannot place is denied (fails closed).
 * Everything else passes silently. Each decision is logged to
 * .astack/guard/events.jsonl. Kept free of the AStack runtime so it adds only
 * a node start to a tool call.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecretsStrict } from "../lib/text.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = join(root, ".astack", "guard");

export const DENY = [
  [/\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*|--recursive\s+--force|--force\s+--recursive)\s+(\/|~|\/\*|~\/\*|\$HOME|\/home|\/root|\/etc|\/var|\/usr|[a-z]:[\\/]?)(\s|$|\*)/i, "recursive delete of a root, home or system folder"],
  [/\bremove-item\b[^\n]*-recurse[^\n]*\s([a-z]:\\?|\\|~|\$home|\$env:userprofile)(\s|$|\*|"|')/i, "recursive delete of a drive or home folder"],
  [/\bgit\s+push\b[^\n]*(\s--force\b|\s-f\b|\s--force-with-lease\b)[^\n]*\s(main|master|production|prod)\b/i, "force-push to a default or production branch"],
  [/\bgit\s+push\b[^\n]*\s\+(main|master|production|prod)\b/i, "force-push to a default or production branch"],
  [/\bpm2\s+(restart|reload|stop|delete)\s+all\b/i, "owner rule: never touch every pm2 process on a shared server"],
  [/\bpm2\s+kill\b/i, "owner rule: never kill pm2 on a shared server"],
  [/\bmkfs(\.\w+)?\b|\bformat\s+[a-z]:/i, "formatting a disk"],
  [/\bdd\s+[^\n]*\bof=\/dev\/(sd|nvme|hd|xvd|disk)/i, "writing raw to a disk device"],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, "fork bomb"],
  [/\bchmod\s+-R\s+0?777\s+\/(\s|$)/i, "opening the whole filesystem"]
];

export const ASK = [
  // Approvals are the owner's: an agent never grants its own (3.4.0 browser
  // commits, missions). The owner can still say yes at the prompt.
  [/\bapproval\s+(approve|decide)\b/i, "granting an approval — only when the owner said so"],
  [/\brm\s+(-[a-z]*r[a-z]*|--recursive)\b/i, "recursive delete"],
  [/\bremove-item\b[^\n]*-recurse/i, "recursive delete"],
  [/\b(rmdir|rd)\s+\/s\b|\bdel\s+\/s\b/i, "recursive delete"],
  [/\bgit\s+reset\s+--hard\b/i, "discarding uncommitted work"],
  [/\bgit\s+clean\s+-[a-z]*f/i, "deleting untracked files"],
  [/\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/i, "discarding uncommitted changes"],
  [/\bgit\s+push\b[^\n]*(\s--force\b|\s-f\b|\s--force-with-lease\b)/i, "force-push"],
  [/\bgit\s+branch\s+-D\b/i, "deleting a branch"],
  [/\bdrop\s+(table|database|schema)\b/i, "dropping database objects"],
  [/\btruncate\s+table\b|\btruncate\s+[`"]?\w+[`"]?\s*(;|$|")/i, "emptying a table"],
  [/\bdelete\s+from\s+\w+\s*(;|$|")/i, "DELETE without WHERE"],
  [/\b(migrate:fresh|migrate:reset|migrate:rollback|db:wipe|db:seed\s+--force)\b/i, "rebuilding or wiping the database"],
  [/\bprisma\s+(migrate\s+reset|db\s+push\s+--force-reset)\b/i, "resetting the database"],
  [/\bdocker\s+(system|volume|image|container)\s+prune\b|\bdocker\s+volume\s+rm\b|\bdocker[- ]compose\s+down\b[^\n]*\s-v\b/i, "deleting Docker data"],
  [/\bsystemctl\s+(stop|restart|disable)\b|\bservice\s+\S+\s+(stop|restart)\b/i, "stopping or restarting a service"],
  [/\bnginx\s+-s\s+(stop|quit)\b/i, "stopping nginx"],
  [/\b(iptables\s+-F|ufw\s+(disable|reset))\b/i, "dropping firewall rules"],
  [/\bkubectl\s+delete\b|\bterraform\s+destroy\b/i, "destroying infrastructure"],
  [/\bcrontab\s+-r\b/i, "removing every cron job"]
];

const SQL_REASONS = new Set(["dropping database objects", "emptying a table", "DELETE without WHERE"]);

// Folders that are routinely rebuilt; deleting them never needs a prompt.
const BUILD_DIRS = /^(\.\/)?(node_modules|dist|build|out|\.next|\.nuxt|\.turbo|\.cache|coverage|vendor|tmp|temp|__pycache__|\.pytest_cache|target|storage\/framework\/(cache|views|sessions))\/?$/i;

function onlyBuildDirs(command) {
  const match = /\b(?:rm\s+-[a-z]+|remove-item)\s+(.+)$/i.exec(command.split(/&&|;|\|\|/)[0] ?? "");
  if (!match) {
    return false;
  }
  const targets = match[1].split(/\s+/).filter((token) => token && !token.startsWith("-"));
  return targets.length > 0 && targets.every((target) => BUILD_DIRS.test(target.replace(/["']/g, "")));
}

/** The decision for one shell command: { decision: deny|ask|allow, reason }. */
export function judgeCommand(command) {
  const text = String(command ?? "");
  for (const [pattern, reason] of DENY) {
    if (pattern.test(text)) {
      return { decision: "deny", reason };
    }
  }
  for (const segment of text.split(/&&|\|\||;|\n/)) {
    // Shell commands are matched outside quotes (a grep for "rm -rf" is not a
    // delete); SQL lives inside quotes, so it is matched on the whole segment.
    const unquoted = segment.replace(/"[^"]*"|'[^']*'/g, "\"\"");
    for (const [pattern, reason] of ASK) {
      const subject = SQL_REASONS.has(reason) ? segment : unquoted;
      if (pattern.test(subject) && !(reason === "recursive delete" && onlyBuildDirs(segment.trim()))) {
        return { decision: "ask", reason };
      }
    }
  }
  return { decision: "allow", reason: null };
}

export function readGuardState(base = root) {
  try {
    const path = join(base, ".astack", "guard", "state.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  } catch {
    return { corrupt: true };
  }
}

/** Freeze: an edit must land inside the frozen folder. */
export function judgeEdit(filePath, state, projectDir) {
  if (!state?.freeze) {
    return state?.corrupt ? { decision: "deny", reason: "guard state unreadable; refusing edits until `astack guard unfreeze`" } : { decision: "allow", reason: null };
  }
  if (!filePath) {
    return { decision: "deny", reason: "edits are frozen to " + state.freeze + " and this edit names no file" };
  }
  const frozen = resolve(projectDir, state.freeze);
  const target = resolve(projectDir, String(filePath));
  const inside = relative(frozen, target);
  if (inside && (inside.startsWith("..") || isAbsolute(inside))) {
    return { decision: "deny", reason: "edits are frozen to " + state.freeze + " (`astack guard unfreeze` lifts it)" };
  }
  return { decision: "allow", reason: null };
}

export function decide(payload, { state = readGuardState(), projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd() } = {}) {
  if (state?.enabled === false) {
    return { decision: "allow", reason: null };
  }
  const tool = String(payload?.tool_name ?? "");
  const input = payload?.tool_input ?? {};
  if (/^(Bash|PowerShell|Shell)$/i.test(tool) || typeof input.command === "string") {
    return judgeCommand(input.command);
  }
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) {
    return judgeEdit(input.file_path ?? input.notebook_path ?? null, state, projectDir);
  }
  return { decision: "allow", reason: null };
}

function log(entry) {
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(join(stateDir, "events.jsonl"), JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // The log never decides anything.
  }
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  let payload = {};
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    return;
  }
  const verdict = decide(payload);
  if (verdict.decision === "allow") {
    return;
  }
  log({ at: new Date().toISOString(), tool: payload.tool_name ?? null, decision: verdict.decision, reason: verdict.reason, command: typeof payload.tool_input?.command === "string" ? redactSecretsStrict(payload.tool_input.command).slice(0, 200) : undefined, file: payload.tool_input?.file_path ?? undefined });
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: verdict.decision,
      permissionDecisionReason: "AStack guard: " + verdict.reason
    }
  }) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
