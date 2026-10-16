#!/usr/bin/env node
/**
 * AStack guard: a PreToolUse hook for Claude Code (3.5.0; rules adapted from
 * the careful/freeze hooks of gstack, MIT, © 2026 Garry Tan).
 *
 * Reads the hook payload on stdin and answers with a permission decision:
 * - deny: catastrophic commands and the owner's production rules (recursive
 *   delete or permission change of a root, home or system folder, force-push
 *   or delete of a protected branch, `pm2 … all`, `pm2 kill`, disk
 *   formatting, an agent granting an approval);
 * - ask: destructive commands that are sometimes right (`git reset --hard`,
 *   `DROP TABLE`, `migrate:fresh`, recursive deletes outside build and temp
 *   folders, reboots, turning the guard off, writing the guard's state or
 *   Claude Code's settings …);
 * - freeze: while `astack guard freeze <dir>` is on, edits outside that folder
 *   are denied, and anything it cannot place is denied (fails closed).
 *
 * Commands are parsed, not pattern-matched: quotes, chains, groups, shell
 * keywords (if/for/while/case, functions), heredocs, command substitution
 * ($(…) and backticks), prefixes (sudo, env, timeout …) and wrappers (bash -c,
 * su -c, ssh, eval, docker/kubectl exec, PowerShell -Command/-EncodedCommand,
 * iex, Start-Process, cmd /c, xargs, find -exec, npx/pnpm/yarn exec,
 * echo … | sh) are unwrapped and every inner command is judged by its program
 * and arguments. A dangerous phrase that is only mentioned (echo, grep, a
 * commit message) is not a command and passes.
 *
 * It is a safety net against mistakes, not a sandbox: a script written to a
 * file and run later, `curl … | bash`, aliases and values hidden in variables
 * cannot be judged reliably (see documentation/Guard.md). Decisions are
 * logged, with secrets redacted, to .astack/guard/events.jsonl.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecretsStrict } from "../lib/text.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = () => process.env.ASTACK_GUARD_STATE_DIR ?? join(root, ".astack", "guard");

const PROTECTED_BRANCHES = new Set(["main", "master", "production", "prod"]);
const ROOT_TARGETS = /^(\/|\/\*|~|~\/\*|\$home|\$\{home\}|\$home\/\*|\/home|\/home\/\*|\/root|\/etc|\/var|\/usr|\/bin|\/boot|\/opt|\/srv|\/lib|\/lib64|\/sbin|\/var\/www|\/var\/www\/\*|\/var\/lib|[a-z]:\\?\*?|\$env:userprofile|\$env:systemroot|%userprofile%|[a-z]:\\users|[a-z]:\\windows|[a-z]:\\program files)$/i;
const BUILD_LEAF = /^(node_modules|dist|build|out|\.next|\.nuxt|\.turbo|\.cache|\.parcel-cache|coverage|\.nyc_output|vendor|tmp|temp|__pycache__|\.pytest_cache|target|\.vite|\.svelte-kit|\.output)$/i;
const SAFE_PREFIX = /^(\/tmp\/|\/var\/tmp\/|\$tmpdir\/|\$\{tmpdir\}\/|%temp%\\|\$env:temp\\|~\/\.cache\/|\$\(mktemp|storage\/framework\/|\.\/storage\/framework\/|bootstrap\/cache\/)/i;
const LOCK_FILE = /(^|[\\/])(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|bun\.lockb)$/i;
const DB_CLIENTS = new Set(["mysql", "mariadb", "psql", "sqlite3", "sqlcmd", "mysqlsh", "clickhouse-client", "mongosh"]);
const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}", "coproc", "function", "time", "esac", "in", "select"]);
const READ_ONLY = new Set(["cat", "type", "get-content", "gc", "grep", "rg", "egrep", "fgrep", "less", "more", "head", "tail", "jq", "ls", "dir", "findstr", "select-string", "sls", "test-path", "stat", "wc", "diff", "git", "code", "echo", "printf"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

// ------------------------------------------------------------------ parsing

/** Heredoc bodies are data, never commands. */
function stripHeredocs(text) {
  return text.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1([^\n]*)\n[\s\S]*?\n\s*\2\s*(\n|$)/g, (match, quote, tag, rest) => "<<heredoc" + rest + "\n");
}

/**
 * Bodies of $(…) and `…` anywhere except inside single quotes; each one is a
 * command line of its own.
 */
export function substitutions(text) {
  const bodies = [];
  let single = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'" && !single) {
      // A single quote outside double quotes starts a literal.
      const before = text.slice(0, index);
      const doubles = (before.match(/(?<!\\)"/g) ?? []).length;
      if (doubles % 2 === 0) {
        single = true;
        continue;
      }
    } else if (char === "'" && single) {
      single = false;
      continue;
    }
    if (single) {
      continue;
    }
    if (char === "$" && text[index + 1] === "(" && text[index + 2] !== "(") {
      let depth = 0;
      for (let end = index + 1; end < text.length; end += 1) {
        if (text[end] === "(") {
          depth += 1;
        } else if (text[end] === ")") {
          depth -= 1;
          if (depth === 0) {
            bodies.push(text.slice(index + 2, end));
            index = end;
            break;
          }
        }
      }
    } else if (char === "`") {
      const end = text.indexOf("`", index + 1);
      if (end > index) {
        bodies.push(text.slice(index + 1, end));
        index = end;
      }
    }
  }
  return bodies;
}

/** "C:\" ends a Windows path: the backslash is literal and the quote closes. */
function closesWindowsPath(text, index) {
  return text[index] === "\\" && text[index + 1] === "\"" && (index + 2 >= text.length || /[\s;|&)]/.test(text[index + 2]));
}

/** Split into simple commands on ; & | newline ( ) { } outside quotes. */
export function splitCommands(text) {
  const parts = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      current += char;
      if (char === "\\" && quote === "\"" && index + 1 < text.length && !closesWindowsPath(text, index)) {
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
    // A redirect such as 2>&1 keeps its "&".
    if (char === "&" && (current.endsWith(">") || text[index + 1] === ">")) {
      current += char;
      continue;
    }
    if (";\n|&(){}".includes(char)) {
      // "{" and "}" are group braces only as words of their own.
      if (char === "{" || char === "}") {
        const before = current === "" || /[\s;]$/.test(current);
        const after = index + 1 >= text.length || /[\s;]/.test(text[index + 1]);
        if (!(before && after)) {
          current += char;
          continue;
        }
      }
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Words of one simple command, quotes removed, redirections dropped. */
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
      } else if (char === "\\" && quote === "\"" && index + 1 < text.length && /["\\$`]/.test(text[index + 1]) && !closesWindowsPath(text, index)) {
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
  // Redirections are not arguments: "2>/dev/null", "> out.txt", "2>&1".
  const cleaned = [];
  for (let index = 0; index < out.length; index += 1) {
    const word = out[index];
    if (/^(\d*|&)(>>?|<)(&\d+)?$/.test(word)) {
      index += /&\d+$/.test(word) ? 0 : 1;
      continue;
    }
    if (/^(\d*|&)(>>?|<)/.test(word)) {
      continue;
    }
    cleaned.push(word);
  }
  return cleaned;
}

/** Targets of redirections in a simple command ("> file", "2>>log"). */
function redirectTargets(text) {
  return [...text.matchAll(/(?:^|\s)\d*>>?\s*([^\s&|;]+)/g)].map((match) => match[1].replace(/^["']|["']$/g, ""));
}

const program = (word) => String(word ?? "").split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");

function decodePowerShell(encoded) {
  try {
    return Buffer.from(String(encoded), "base64").toString("utf16le");
  } catch {
    return "";
  }
}

/**
 * Peel keywords, prefixes and wrappers. Returns { words } for a plain
 * command, or { inner: [command lines] } when it runs other command lines.
 */
function unwrap(list) {
  let rest = [...list];
  for (let guard = 0; guard < 12 && rest.length; guard += 1) {
    const name = program(rest[0]);
    if (KEYWORDS.has(rest[0]) || /^[A-Za-z_][A-Za-z0-9_]*\(\)$/.test(rest[0])) {
      rest = rest.slice(1);
      continue;
    }
    if (rest[0] === "case") {
      const at = rest.indexOf("in");
      rest = at === -1 ? [] : rest.slice(at + 2);
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) {
      rest = rest.slice(1);
      continue;
    }
    if (name === "env") {
      const split = rest.findIndex((word) => word === "-S" || word === "--split-string" || word.startsWith("--split-string="));
      if (split > 0) {
        return { inner: [rest[split].includes("=") ? rest[split].split("=").slice(1).join("=") : rest.slice(split + 1).join(" ")] };
      }
    }
    if (["sudo", "doas", "env", "nohup", "nice", "ionice", "exec", "command", "builtin", "stdbuf", "timeout", "watch", "chroot", "runuser"].includes(name)) {
      rest = rest.slice(1);
      while (rest.length && (rest[0].startsWith("-") || /^\d+[smhd]?$/.test(rest[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]))) {
        const option = rest.shift();
        if (["-u", "-g", "-C", "-p", "-n", "-s", "-k"].includes(option) && rest.length && !rest[0].startsWith("-")) {
          rest.shift();
        }
      }
      continue;
    }
    if (name === "su") {
      const flag = rest.findIndex((word, index) => index > 0 && (word === "-c" || word === "--command"));
      return flag > 0 && rest[flag + 1] !== undefined ? { inner: [rest[flag + 1]] } : { words: rest };
    }
    if (SHELLS.has(name) || name === "fish") {
      const flag = rest.findIndex((word, index) => index > 0 && /^-[a-z]*c[a-z]*$/i.test(word));
      return flag > 0 && rest[flag + 1] !== undefined ? { inner: [rest[flag + 1]] } : { words: rest };
    }
    if (["powershell", "pwsh"].includes(name)) {
      let index = 1;
      while (index < rest.length && rest[index].startsWith("-")) {
        const option = rest[index].toLowerCase();
        if (/^-(e|ec|enc|encodedcommand)$/.test(option)) {
          return { inner: [decodePowerShell(rest[index + 1])] };
        }
        if (/^-(c|command)$/.test(option)) {
          return { inner: [rest.slice(index + 1).join(" ")] };
        }
        if (/^-(f|file)$/.test(option)) {
          return { words: ["powershell-file", ...rest.slice(index + 1)] };
        }
        index += /^-(executionpolicy|ep|windowstyle|w|version|outputformat|inputformat|configurationname)$/.test(option) ? 2 : 1;
      }
      return index < rest.length ? { inner: [rest.slice(index).join(" ")] } : { words: rest };
    }
    if (name === "iex" || name === "invoke-expression") {
      return { inner: [rest.slice(1).filter((word) => !/^-command$/i.test(word)).join(" ")] };
    }
    if (name === "start-process" || name === "saps" || name === "start") {
      const file = rest.find((word, index) => index > 0 && !word.startsWith("-") && !/^-/.test(rest[index - 1] ?? ""));
      const argIndex = rest.findIndex((word) => /^-(argumentlist|args)$/i.test(word));
      if (file && argIndex !== -1) {
        return { inner: [file + " " + rest.slice(argIndex + 1).join(" ")] };
      }
      return { words: rest.slice(1) };
    }
    if (name === "cmd") {
      const flag = rest.findIndex((word, index) => index > 0 && /^\/[ck]$/i.test(word));
      return flag > 0 ? { inner: [rest.slice(flag + 1).join(" ")] } : { words: rest };
    }
    if (name === "eval") {
      return { inner: [rest.slice(1).join(" ")] };
    }
    if (name === "ssh") {
      let index = 1;
      while (index < rest.length && rest[index].startsWith("-")) {
        index += /^-[bcDEeFIiJLlmOopQRSWw]$/.test(rest[index]) ? 2 : 1;
      }
      let command = rest.slice(index + 1);
      if (command[0] === "--") {
        command = command.slice(1);
      }
      return command.length ? { inner: [command.join(" ")] } : { words: rest };
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
    if (["npx", "bunx", "pnpx"].includes(name)) {
      let index = 1;
      while (index < rest.length && rest[index].startsWith("-")) {
        index += /^(-p|--package)$/.test(rest[index]) ? 2 : 1;
      }
      rest = rest.slice(index);
      continue;
    }
    if (["pnpm", "yarn", "bun"].includes(name) && ["exec", "dlx", "x"].includes(rest[1])) {
      rest = rest.slice(2);
      continue;
    }
    if (name === "npm" && ["exec", "x"].includes(rest[1])) {
      const dash = rest.indexOf("--");
      rest = dash !== -1 ? rest.slice(dash + 1) : rest.slice(2).filter((word) => !word.startsWith("-"));
      continue;
    }
    if ((name === "npm" || name === "pnpm" || name === "yarn") && rest[1] === "run" && rest[2]) {
      // A package script named like a tool runs that tool with the arguments.
      const dash = rest.indexOf("--");
      rest = [rest[2], ...(dash !== -1 ? rest.slice(dash + 1) : rest.slice(3))];
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

/** The path a target really names: /tmp/.. is /, C:\x\.. is C:\. */
function normaliseTarget(target) {
  const raw = String(target).trim().replace(/^["']|["']$/g, "");
  if (/^[a-z]:/i.test(raw) || raw.includes("\\")) {
    const normal = win32.normalize(raw);
    return normal.length > 3 ? normal.replace(/\\+$/, "") : normal;
  }
  if (raw.startsWith("/") || raw.startsWith("~") || raw.startsWith("$")) {
    const normal = posix.normalize(raw);
    return normal.length > 1 ? normal.replace(/\/+$/, "") : normal;
  }
  return raw;
}

function deleteVerdict(targets, { recursive, noPreserveRoot = false }) {
  if (!recursive) {
    return ALLOW;
  }
  if (noPreserveRoot) {
    return verdict("deny", "recursive delete with --no-preserve-root");
  }
  const raw = targets.flatMap((target) => String(target).split(",")).map((target) => target.trim()).filter(Boolean);
  if (raw.some((target) => ROOT_TARGETS.test(normaliseTarget(target)))) {
    return verdict("deny", "recursive delete of a root, home or system folder");
  }
  const safe = (target) => {
    const clean = target.replace(/^["']|["']$/g, "");
    if (clean.includes("..")) {
      return false;
    }
    const plain = clean.replace(/[\\/]+\*?$/, "").replace(/^\.[\\/]/, "");
    const leaf = plain.split(/[\\/]/).pop();
    return BUILD_LEAF.test(leaf) || SAFE_PREFIX.test(clean) || LOCK_FILE.test(plain);
  };
  if (raw.length && raw.every(safe)) {
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
  const powershell = name === "remove-item" || name === "ri" || name === "rm";
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

function judgeFind(list) {
  const starts = [];
  let index = 1;
  while (index < list.length && !list[index].startsWith("-") && !["(", "!"].includes(list[index])) {
    starts.push(list[index]);
    index += 1;
  }
  const results = [];
  if (list.includes("-delete")) {
    results.push(deleteVerdict(starts.length ? starts : ["."], { recursive: true }));
  }
  for (let at = 0; at < list.length; at += 1) {
    if (list[at] === "-exec" || list[at] === "-execdir" || list[at] === "-ok") {
      const body = [];
      for (let end = at + 1; end < list.length && ![";", "\\;", "+"].includes(list[end]); end += 1) {
        body.push(list[end] === "{}" ? (starts[0] ?? ".") : list[end]);
      }
      results.push(judgeCommandWords(body));
    }
  }
  return strongest(results);
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
    if (flags.includes("--mirror")) {
      return verdict("ask", "mirror push (overwrites every remote branch)");
    }
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

export function judgeSql(text) {
  if (/\bdrop\s+(table|database|schema)\b/i.test(text)) {
    return verdict("ask", "dropping database objects");
  }
  if (/\btruncate\s+table\b|\btruncate\s+[`"]?\w+[`"]?\s*(;|$|")/im.test(text)) {
    return verdict("ask", "emptying a table");
  }
  if (/\bdelete\s+from\s+[`"]?\w+[`"]?\s*(;|$|"|')/im.test(text)) {
    return verdict("ask", "DELETE without WHERE");
  }
  return ALLOW;
}

/** Writing the guard's own state or Claude Code's settings asks. */
function guardFilesVerdict(name, raw) {
  const sensitive = /(\.astack[\\/]guard[\\/]|\.claude[\\/]settings(\.local)?\.json)/i;
  if (redirectTargets(raw).some((target) => sensitive.test(target))) {
    return verdict("ask", "writing the guard's state or Claude Code's settings");
  }
  if (!READ_ONLY.has(name) && sensitive.test(raw)) {
    return verdict("ask", "changing the guard's state or Claude Code's settings");
  }
  return ALLOW;
}

function judgeWords(list, raw = list.join(" ")) {
  if (!list.length) {
    return ALLOW;
  }
  const name = program(list[0]);
  const lower = list.map((word) => word.toLowerCase());
  const files = guardFilesVerdict(name, raw);
  const own = judgeProgram(name, list, lower, raw);
  return strongest([files, own]);
}

function judgeProgram(name, list, lower, raw) {
  if (name === "rm" && lower.some((word) => /^-recurse$/.test(word))) {
    return judgeWindowsDelete("rm", list);
  }
  if (name === "rm") {
    return judgeRm(list);
  }
  if (["remove-item", "ri", "del", "erase", "rd", "rmdir"].includes(name)) {
    if ((name === "rmdir" || name === "rd") && !lower.includes("/s") && !lower.some((word) => /^-r(ecurse)?$/.test(word))) {
      return ALLOW;
    }
    return judgeWindowsDelete(name, list);
  }
  if (name === "find") {
    return judgeFind(list);
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
  if (["chmod", "chown", "chgrp"].includes(name) && lower.some((word) => /^-[a-z]*r/i.test(word) || word === "--recursive")) {
    const targets = list.slice(1).filter((word) => !word.startsWith("-"));
    if (targets.some((target) => ROOT_TARGETS.test(normaliseTarget(target)))) {
      return verdict("deny", "changing permissions of a root, home or system folder");
    }
    return ALLOW;
  }
  if (["reboot", "poweroff", "halt", "shutdown", "restart-computer", "stop-computer"].includes(name) || (name === "systemctl" && ["reboot", "poweroff", "halt", "kexec"].includes(lower[1]))) {
    return verdict("ask", "rebooting or shutting down the machine");
  }
  if (name === "php" && lower[1] === "artisan" && /^(migrate:fresh|migrate:reset|migrate:rollback|db:wipe)$/.test(lower[2] ?? "")) {
    return verdict("ask", "rebuilding or wiping the database");
  }
  if (name === "php" && lower[1] === "artisan" && lower[2] === "db:seed" && lower.includes("--force")) {
    return verdict("ask", "seeding a production database");
  }
  if (name === "prisma" && (lower.includes("reset") || lower.includes("--force-reset"))) {
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

/** A command given as words (find -exec bodies). */
function judgeCommandWords(list, depth = 0) {
  const unwrapped = unwrap(list);
  if (unwrapped.inner) {
    return strongest(unwrapped.inner.map((line) => (depth < 4 ? judgeCommand(line, depth + 1) : verdict("ask", "deeply nested command"))));
  }
  return judgeWords(unwrapped.words);
}

/** The decision for one shell command line: { decision: deny|ask|allow, reason }. */
export function judgeCommand(command, depth = 0) {
  const original = String(command ?? "");
  const text = stripHeredocs(original);
  const results = [];
  for (const body of substitutions(text)) {
    results.push(depth < 4 ? judgeCommand(body, depth + 1) : verdict("ask", "deeply nested command"));
  }
  const simples = splitCommands(text);
  let previous = null;
  for (const simple of simples) {
    const list = words(simple);
    const unwrapped = unwrap(list);
    if (unwrapped.inner) {
      results.push(...unwrapped.inner.map((line) => (depth < 4 ? judgeCommand(line, depth + 1) : verdict("ask", "deeply nested command"))));
    } else {
      results.push(judgeWords(unwrapped.words, simple));
      const name = program(unwrapped.words[0]);
      // echo/printf "…" | sh: what the shell runs is the echoed text.
      if (SHELLS.has(name) && previous && ["echo", "printf"].includes(program(previous[0]))) {
        results.push(depth < 4 ? judgeCommand(previous.slice(1).join(" "), depth + 1) : verdict("ask", "deeply nested command"));
      }
      // SQL piped or heredoc'd into a database client.
      if (DB_CLIENTS.has(name)) {
        results.push(judgeSql(original));
      }
      previous = unwrapped.words;
    }
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

/** Freeze first (it denies), then the guard's own files (they ask). */
export function judgeEdit(filePath, state, projectDir) {
  const target = filePath ? resolve(projectDir, String(filePath)) : null;
  if (state?.corrupt) {
    return verdict("deny", "guard state unreadable; refusing edits until `astack guard unfreeze`");
  }
  if (state?.freeze) {
    if (!target) {
      return verdict("deny", "edits are frozen to " + state.freeze + " and this edit names no file");
    }
    const inside = relative(resolve(projectDir, state.freeze), target);
    if (inside && (inside.startsWith("..") || isAbsolute(inside))) {
      return verdict("deny", "edits are frozen to " + state.freeze + " (`astack guard unfreeze` lifts it)");
    }
  }
  if (target && /[\\/]\.astack[\\/]guard[\\/]/i.test(target)) {
    return verdict("ask", "editing the guard's own state");
  }
  if (target && /[\\/]\.claude[\\/]settings(\.local)?\.json$/i.test(target)) {
    return verdict("ask", "editing Claude Code settings (hooks and permissions)");
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
    .replace(/(\/\/[^\s/:@]+:)([^\s/@]+)(@)/g, "$1[redacted]$3")
    .replace(/(-(?:e|ec|enc|encodedcommand)\s+)([A-Za-z0-9+/=]{40,})/gi, "$1[encoded]");
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
