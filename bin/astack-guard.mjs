#!/usr/bin/env node
/**
 * AStack guard: a PreToolUse hook for Claude Code (3.5.0; rules adapted from
 * the careful/freeze hooks of gstack, MIT, © 2026 Garry Tan).
 *
 * Reads the hook payload on stdin and answers with a permission decision:
 * - deny: catastrophic commands and the owner's production rules (recursive
 *   delete of a root, home or system folder, force-push or delete of a
 *   protected branch, `pm2 … all`, `pm2 kill`, disk formatting, an agent
 *   granting an approval);
 * - ask: destructive commands that are sometimes right (`git reset --hard`,
 *   `DROP TABLE`, `migrate:fresh`, recursive deletes outside build and temp
 *   folders, turning the guard off, editing the guard's state or settings …);
 * - freeze: while `astack guard freeze <dir>` is on, edits outside that folder
 *   are denied, and anything it cannot place is denied (fails closed).
 *
 * Commands are parsed, not pattern-matched: quotes, `;`, `&&`, `|`, heredocs,
 * `sudo`/`env` prefixes and wrappers (`bash -c`, `ssh host "…"`, `eval`,
 * `docker exec`, `kubectl exec`, `powershell -Command`, `cmd /c`, `xargs`)
 * are unwrapped and every inner command is judged by its program and
 * arguments. A dangerous phrase that is only mentioned (`echo`, `grep`, a
 * commit message) is not a command and passes. Decisions are logged, with
 * secrets redacted, to .astack/guard/events.jsonl. Kept free of the AStack
 * runtime so it adds only a node start to a tool call. Freeze covers the edit
 * tools only; shell writes are judged as commands.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecretsStrict } from "../lib/text.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = () => process.env.ASTACK_GUARD_STATE_DIR ?? join(root, ".astack", "guard");

const PROTECTED_BRANCHES = new Set(["main", "master", "production", "prod"]);
const ROOT_TARGETS = /^(\/|\/\*|~|~\/|~\/\*|\$home\/?|\$\{home\}\/?|\$home\/\*|\/home\/?|\/home\/\*|\/root\/?|\/etc\/?|\/var\/?|\/usr\/?|\/bin\/?|\/boot\/?|\/opt\/?|\/srv\/?|\/lib\/?|\/sbin\/?|\/var\/www\/?|\/var\/www\/\*|[a-z]:[\\/]?\*?|[a-z]:\\\\|\$env:userprofile\\?|\$env:systemroot\\?|%userprofile%\\?|c:\\users\\?|c:\\windows\\?)$/i;
const BUILD_LEAF = /^(node_modules|dist|build|out|\.next|\.nuxt|\.turbo|\.cache|\.parcel-cache|coverage|vendor|tmp|temp|__pycache__|\.pytest_cache|target|\.vite|storage\/framework\/(cache|views|sessions)|bootstrap\/cache)$/i;
const LOCK_FILE = /(^|[\\/])(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|bun\.lockb)$/i;
const TEMP_PREFIX = /^(\/tmp\/|\/var\/tmp\/|\$tmpdir\/|\$\{tmpdir\}\/|%temp%\\|\$env:temp\\)/i;
const DB_CLIENTS = new Set(["mysql", "mariadb", "psql", "sqlite3", "sqlcmd", "mysqlsh", "clickhouse-client", "mongosh"]);

// ------------------------------------------------------------------ parsing

/** Heredoc bodies are data, never commands. */
function stripHeredocs(text) {
  return text.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(\n|$)/g, "<<heredoc\n");
}

/** Split into simple commands on ; && || | & and newlines, outside quotes. */
export function splitCommands(text) {
  const parts = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      current += char;
      if (char === "\\" && quote === "\"" && index + 1 < text.length) {
        current += text[index + 1];
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";" || char === "\n" || char === "|" || char === "&") {
      parts.push(current);
      current = "";
      continue;
    }
    if (char === "(" || char === ")") {
      current += " ";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Words of one simple command, quotes removed. */
export function words(text) {
  const out = [];
  let current = "";
  let quote = null;
  let started = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && quote === "\"" && index + 1 < text.length && /["\\$`]/.test(text[index + 1])) {
        current += text[index + 1];
        index += 1;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current) {
        out.push(current);
      }
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started || current) {
    out.push(current);
  }
  return out;
}

const program = (word) => String(word ?? "").split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");

/**
 * Peel prefixes and wrappers. Returns { words } for a plain command, or
 * { inner: "<text>" } when the command runs another command line.
 */
function unwrap(list) {
  let rest = [...list];
  for (let guard = 0; guard < 8 && rest.length; guard += 1) {
    const name = program(rest[0]);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) {
      rest = rest.slice(1);
      continue;
    }
    if (["sudo", "doas", "env", "nohup", "time", "nice", "ionice", "exec", "command", "builtin", "stdbuf", "timeout", "watch"].includes(name)) {
      rest = rest.slice(1);
      // Options of the prefix (sudo -u x, timeout 10, env -i).
      while (rest.length && (rest[0].startsWith("-") || /^\d+[smhd]?$/.test(rest[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]))) {
        const option = rest.shift();
        if (["-u", "-g", "-C", "-p", "-n"].includes(option) && rest.length) {
          rest.shift();
        }
      }
      continue;
    }
    if (["bash", "sh", "zsh", "dash", "ksh", "fish"].includes(name)) {
      const flag = rest.findIndex((word, index) => index > 0 && /^-[a-z]*c[a-z]*$/i.test(word));
      return flag > 0 && rest[flag + 1] !== undefined ? { inner: rest[flag + 1] } : { words: rest };
    }
    if (["powershell", "pwsh"].includes(name)) {
      const flag = rest.findIndex((word, index) => index > 0 && /^-(c|command)$/i.test(word));
      return flag > 0 ? { inner: rest.slice(flag + 1).join(" ") } : { words: rest };
    }
    if (name === "cmd") {
      const flag = rest.findIndex((word, index) => index > 0 && /^\/[ck]$/i.test(word));
      return flag > 0 ? { inner: rest.slice(flag + 1).join(" ") } : { words: rest };
    }
    if (name === "eval") {
      return { inner: rest.slice(1).join(" ") };
    }
    if (name === "ssh") {
      // ssh [options] host [command…]
      let index = 1;
      while (index < rest.length && rest[index].startsWith("-")) {
        index += /^-[bcDEeFIiJLlmOopQRSWw]$/.test(rest[index]) ? 2 : 1;
      }
      return index + 1 < rest.length ? { inner: rest.slice(index + 1).join(" ") } : { words: rest };
    }
    if (name === "xargs") {
      let index = 1;
      while (index < rest.length && rest[index].startsWith("-")) {
        index += /^-[IinLPsEd]$/.test(rest[index]) ? 2 : 1;
      }
      rest = rest.slice(index);
      continue;
    }
    if ((name === "docker" || name === "podman") && rest[1] === "exec") {
      let index = 2;
      while (index < rest.length && rest[index].startsWith("-")) {
        index += /^-(e|u|w|-env|-user|-workdir)$/.test(rest[index]) ? 2 : 1;
      }
      rest = rest.slice(index + 1);
      continue;
    }
    if (name === "kubectl" && rest.includes("exec") && rest.includes("--")) {
      rest = rest.slice(rest.indexOf("--") + 1);
      continue;
    }
    break;
  }
  return { words: rest };
}

// ------------------------------------------------------------------ judging

const verdict = (decision, reason) => ({ decision, reason });
const ALLOW = verdict("allow", null);
const RANK = { allow: 0, ask: 1, deny: 2 };

function strongest(list) {
  return list.reduce((best, entry) => (RANK[entry.decision] > RANK[best.decision] ? entry : best), ALLOW);
}

function normaliseTarget(target) {
  return String(target).trim().replace(/^["']|["']$/g, "");
}

function deleteVerdict(targets, { recursive, noPreserveRoot = false }) {
  if (!recursive) {
    return ALLOW;
  }
  if (noPreserveRoot) {
    return verdict("deny", "recursive delete with --no-preserve-root");
  }
  const cleaned = targets.map(normaliseTarget).filter(Boolean);
  if (cleaned.some((target) => ROOT_TARGETS.test(target))) {
    return verdict("deny", "recursive delete of a root, home or system folder");
  }
  const safe = (target) => {
    const plain = target.replace(/[\\/]+\*?$/, "").replace(/^\.\//, "");
    const parts = plain.split(/[\\/]/);
    const leaf = parts.pop();
    const lastTwo = parts.slice(-1).concat(leaf).join("/");
    return BUILD_LEAF.test(leaf) || BUILD_LEAF.test(lastTwo) || (/^\*\.php$/i.test(leaf) && /bootstrap[\\/]cache/i.test(plain)) || LOCK_FILE.test(plain) || TEMP_PREFIX.test(target);
  };
  if (cleaned.length && cleaned.every(safe)) {
    return ALLOW;
  }
  return verdict("ask", "recursive delete");
}

function judgeRm(list) {
  const flags = list.slice(1).filter((word) => word.startsWith("-"));
  const targets = list.slice(1).filter((word) => !word.startsWith("-"));
  const short = flags.filter((flag) => !flag.startsWith("--")).join("");
  const recursive = /[rR]/.test(short) || flags.includes("--recursive");
  return deleteVerdict(targets, { recursive, noPreserveRoot: flags.includes("--no-preserve-root") });
}

function judgeWindowsDelete(name, list) {
  const powershell = name === "remove-item" || name === "ri";
  const lower = list.map((word) => word.toLowerCase());
  const recursive = powershell ? lower.some((word) => /^-r(ecurse)?$/.test(word)) : lower.includes("/s");
  const targets = [];
  for (let index = 1; index < list.length; index += 1) {
    const word = list[index];
    if (/^-(path|literalpath)$/i.test(word)) {
      targets.push(list[index + 1] ?? "");
      index += 1;
    } else if (word.startsWith("-")) {
      continue;
    } else if (!powershell && /^\/[a-z]$/i.test(word)) {
      continue;
    } else {
      targets.push(word);
    }
  }
  return deleteVerdict(targets, { recursive });
}

function judgeGit(list) {
  let index = 1;
  while (index < list.length && list[index].startsWith("-")) {
    index += ["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(list[index]) ? 2 : 1;
  }
  const sub = list[index];
  const args = list.slice(index + 1);
  if (sub === "push") {
    const flags = args.filter((word) => word.startsWith("-"));
    const positional = args.filter((word) => !word.startsWith("-"));
    const force = flags.some((flag) => /^(--force|--force-with-lease(=.*)?|--force-if-includes)$/.test(flag) || (/^-[a-z]+$/.test(flag) && flag.includes("f")));
    const deleting = flags.some((flag) => flag === "--delete" || flag === "-d");
    const refspecs = positional.slice(1);
    const destinations = refspecs.map((spec) => {
      const plus = spec.startsWith("+");
      const body = spec.replace(/^\+/, "");
      const destination = body.includes(":") ? body.split(":").pop() : body;
      return { plus, removes: body.startsWith(":"), branch: destination.replace(/^refs\/heads\//, "") };
    });
    const forced = force || destinations.some((entry) => entry.plus);
    const removes = deleting || destinations.some((entry) => entry.removes);
    const protectedHit = destinations.some((entry) => PROTECTED_BRANCHES.has(entry.branch));
    if ((forced || removes) && protectedHit) {
      return verdict("deny", (removes ? "deleting" : "force-pushing") + " a protected branch (" + destinations.map((entry) => entry.branch).join(", ") + ")");
    }
    if (forced || removes) {
      return verdict("ask", removes ? "deleting a remote branch" : "force-push");
    }
    return ALLOW;
  }
  if (sub === "reset" && args.includes("--hard")) {
    return verdict("ask", "discarding uncommitted work");
  }
  if (sub === "clean" && args.some((word) => (/^-[a-z]+$/i.test(word) && word.includes("f")) || word === "--force")) {
    return verdict("ask", "deleting untracked files");
  }
  if ((sub === "checkout" || sub === "restore") && (args.includes(".") || args.includes(":/"))) {
    return verdict("ask", "discarding uncommitted changes");
  }
  if (sub === "branch" && (args.includes("-D") || (args.includes("--delete") && args.includes("--force")))) {
    return verdict("ask", "deleting an unmerged branch");
  }
  if (sub === "stash" && ["clear", "drop"].includes(args[0])) {
    return verdict("ask", "discarding stashed work");
  }
  return ALLOW;
}

function judgeAstack(list) {
  const lower = list.map((word) => word.toLowerCase());
  const at = lower.indexOf("approval");
  if (at !== -1 && ["approve", "decide"].includes(lower[at + 1])) {
    return verdict("deny", "only the owner grants approvals (console, gateway or the owner's own terminal)");
  }
  const guard = lower.indexOf("guard");
  if (guard !== -1 && ["off", "unfreeze"].includes(lower[guard + 1])) {
    return verdict("ask", "turning the guard off");
  }
  return ALLOW;
}

function judgeSql(text) {
  if (/\bdrop\s+(table|database|schema)\b/i.test(text)) {
    return verdict("ask", "dropping database objects");
  }
  if (/\btruncate\s+table\b|\btruncate\s+[`"]?\w+[`"]?\s*(;|$|")/i.test(text)) {
    return verdict("ask", "emptying a table");
  }
  if (/\bdelete\s+from\s+[`"]?\w+[`"]?\s*(;|$|"|')/i.test(text)) {
    return verdict("ask", "DELETE without WHERE");
  }
  return ALLOW;
}

function judgeWords(list, raw) {
  if (!list.length) {
    return ALLOW;
  }
  const name = program(list[0]);
  const lower = list.map((word) => word.toLowerCase());
  if (name === "rm") {
    return judgeRm(list);
  }
  if (["remove-item", "ri", "del", "erase", "rd", "rmdir"].includes(name)) {
    if ((name === "rmdir" || name === "rd") && !lower.includes("/s") && !lower.some((word) => /^-r(ecurse)?$/.test(word))) {
      return ALLOW;
    }
    return judgeWindowsDelete(name, list);
  }
  if (name === "git") {
    return judgeGit(list);
  }
  if (name === "pm2") {
    const action = lower[1];
    if (action === "kill") {
      return verdict("deny", "owner rule: never kill pm2 on a shared server");
    }
    if (["restart", "reload", "stop", "delete"].includes(action) && lower.slice(2).includes("all")) {
      return verdict("deny", "owner rule: never touch every pm2 process on a shared server");
    }
    return ALLOW;
  }
  if (/^mkfs(\.\w+)?$/.test(name) || (name === "format" && /^[a-z]:$/i.test(list[1] ?? ""))) {
    return verdict("deny", "formatting a disk");
  }
  if (name === "dd" && list.some((word) => /^of=\/dev\/(sd|nvme|hd|xvd|disk|mmcblk)/i.test(word))) {
    return verdict("deny", "writing raw to a disk device");
  }
  if (name === "diskpart") {
    return verdict("ask", "partitioning disks");
  }
  if (name === "chmod" && lower.includes("-r") && list.some((word) => /^0?777$/.test(word)) && list.some((word) => word === "/")) {
    return verdict("deny", "opening the whole filesystem");
  }
  if (name === "php" && lower[1] === "artisan" && /^(migrate:fresh|migrate:reset|migrate:rollback|db:wipe)$/.test(lower[2] ?? "")) {
    return verdict("ask", "rebuilding or wiping the database");
  }
  if (name === "php" && lower[1] === "artisan" && lower[2] === "db:seed" && lower.includes("--force")) {
    return verdict("ask", "seeding a production database");
  }
  if ((name === "prisma" || (name === "npx" && lower[1] === "prisma")) && (lower.includes("reset") || lower.includes("--force-reset"))) {
    return verdict("ask", "resetting the database");
  }
  if (name === "docker" || name === "podman") {
    if (lower.includes("prune") || (lower[1] === "volume" && ["rm", "remove"].includes(lower[2])) || (lower.includes("down") && lower.some((word) => word === "-v" || word === "--volumes"))) {
      return verdict("ask", "deleting Docker data");
    }
    return ALLOW;
  }
  if (name === "docker-compose" && lower.includes("down") && lower.some((word) => word === "-v" || word === "--volumes")) {
    return verdict("ask", "deleting Docker data");
  }
  if (name === "systemctl" && ["stop", "restart", "disable", "mask"].includes(lower[1])) {
    return verdict("ask", "stopping or restarting a service");
  }
  if (name === "service" && ["stop", "restart"].includes(lower[2])) {
    return verdict("ask", "stopping or restarting a service");
  }
  if (name === "nginx" && lower[1] === "-s" && ["stop", "quit"].includes(lower[2])) {
    return verdict("ask", "stopping nginx");
  }
  if ((name === "iptables" && lower.includes("-f")) || (name === "ufw" && ["disable", "reset"].includes(lower[1]))) {
    return verdict("ask", "dropping firewall rules");
  }
  if ((name === "kubectl" && lower[1] === "delete") || (name === "terraform" && lower[1] === "destroy")) {
    return verdict("ask", "destroying infrastructure");
  }
  if (name === "crontab" && lower.includes("-r")) {
    return verdict("ask", "removing every cron job");
  }
  if (DB_CLIENTS.has(name)) {
    return judgeSql(raw);
  }
  if (name === "astack" || ((name === "node" || name === "bun") && /astack(\.mjs)?$/i.test(list[1] ?? ""))) {
    return judgeAstack(list);
  }
  return ALLOW;
}

/** The decision for one shell command line: { decision: deny|ask|allow, reason }. */
export function judgeCommand(command, depth = 0) {
  const text = stripHeredocs(String(command ?? ""));
  const results = [];
  for (const simple of splitCommands(text)) {
    const list = words(simple);
    const unwrapped = unwrap(list);
    if (unwrapped.inner !== undefined) {
      results.push(depth < 4 ? judgeCommand(unwrapped.inner, depth + 1) : verdict("ask", "deeply nested command"));
      continue;
    }
    results.push(judgeWords(unwrapped.words, simple));
  }
  return strongest(results);
}

export function readGuardState(base = null) {
  try {
    const path = base ? join(base, ".astack", "guard", "state.json") : join(stateDir(), "state.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  } catch {
    return { corrupt: true };
  }
}

/** Freeze: an edit must land inside the frozen folder (an absolute path). */
export function judgeEdit(filePath, state, projectDir) {
  const target = filePath ? resolve(projectDir, String(filePath)) : null;
  if (target && /[\\/]\.astack[\\/]guard[\\/]/i.test(target)) {
    return verdict("ask", "editing the guard's own state");
  }
  if (target && /[\\/]\.claude[\\/]settings(\.local)?\.json$/i.test(target)) {
    return verdict("ask", "editing Claude Code settings (hooks and permissions)");
  }
  if (!state?.freeze) {
    return state?.corrupt ? verdict("deny", "guard state unreadable; refusing edits until `astack guard unfreeze`") : ALLOW;
  }
  if (!target) {
    return verdict("deny", "edits are frozen to " + state.freeze + " and this edit names no file");
  }
  const frozen = resolve(projectDir, state.freeze);
  const inside = relative(frozen, target);
  if (inside && (inside.startsWith("..") || isAbsolute(inside))) {
    return verdict("deny", "edits are frozen to " + state.freeze + " (`astack guard unfreeze` lifts it)");
  }
  return ALLOW;
}

export function decide(payload, { state = readGuardState(), projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd() } = {}) {
  if (state?.enabled === false) {
    return ALLOW;
  }
  const tool = String(payload?.tool_name ?? "");
  const input = payload?.tool_input ?? {};
  if (/^(Bash|PowerShell|Shell)$/i.test(tool) || typeof input.command === "string") {
    return judgeCommand(input.command);
  }
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) {
    return judgeEdit(input.file_path ?? input.notebook_path ?? null, state, projectDir);
  }
  return ALLOW;
}

/** Secrets never reach the log: the strict redactor plus CLI password forms. */
export function redactCommand(command) {
  return redactSecretsStrict(String(command ?? ""))
    .replace(/(\b(?:mysql|mysqldump|mariadb|mysqladmin)\b[^\n]*?\s-p)(\S+)/gi, "$1[redacted]")
    .replace(/(\bsshpass\s+-p\s*)(\S+)/gi, "$1[redacted]")
    .replace(/(\s(?:-u|--user)\s+[^\s:]+:)(\S+)/gi, "$1[redacted]")
    .replace(/(--password(?:=|\s+))(\S+)/gi, "$1[redacted]")
    .replace(/(\/\/[^\s/:@]+:)([^\s/@]+)(@)/g, "$1[redacted]$3");
}

function log(entry) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    appendFileSync(join(stateDir(), "events.jsonl"), JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // The log never decides anything.
  }
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  let payload = null;
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    payload = null;
  }
  const state = readGuardState();
  let result;
  if (!payload) {
    // Unreadable payload: harmless unless a freeze is on, which fails closed.
    result = state?.freeze ? verdict("deny", "unreadable hook payload while edits are frozen") : ALLOW;
  } else {
    result = decide(payload, { state });
  }
  if (result.decision === "allow") {
    return;
  }
  log({
    at: new Date().toISOString(),
    tool: payload?.tool_name ?? null,
    decision: result.decision,
    reason: result.reason,
    command: typeof payload?.tool_input?.command === "string" ? redactCommand(payload.tool_input.command).slice(0, 200) : undefined,
    file: payload?.tool_input?.file_path ?? undefined
  });
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: result.decision,
      permissionDecisionReason: "AStack guard: " + result.reason
    }
  }) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
