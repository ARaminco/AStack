#!/usr/bin/env node
/**
 * AStack guard: a PreToolUse hook for Claude Code (3.5.0; rules adapted from
 * the careful/freeze hooks of gstack, MIT, © 2026 Garry Tan).
 *
 * Reads the hook payload on stdin and answers with a permission decision:
 * - deny: catastrophic commands and the owner's production rules (recursive
 *   delete or permission change of a root, home or system folder, force-push
 *   or delete of a protected branch, `pm2 … all`, `pm2 kill`, disk
 *   formatting or erasing, a fork bomb, an agent granting an approval or
 *   writing an approval record);
 * - ask: destructive commands that are sometimes right (`git reset --hard`,
 *   `DROP TABLE`, `migrate:fresh`, data wipes, recursive deletes outside build
 *   and temp folders, reboots, turning the guard off, writing the guard's
 *   state or Claude Code's settings …);
 * - freeze: while `astack guard freeze <dir>` is on, edits outside that folder
 *   are denied, and anything it cannot place is denied (fails closed).
 *
 * Commands are parsed, not pattern-matched: quotes, chains, pipes, groups,
 * shell keywords (if/for/while/case, functions), heredocs and here-strings
 * (judged as commands when they feed a shell), command substitution ($(…) and
 * backticks), prefixes (sudo, env, timeout, setsid, flock, systemd-run,
 * busybox …) and wrappers (bash -c, su -c, ssh, eval, docker/kubectl exec,
 * wsl, PowerShell -Command/-EncodedCommand, iex, Start-Process, cmd /c, xargs,
 * find -exec, npx/pnpm/yarn exec, echo … | sh) are unwrapped and every inner
 * command is judged by its program and arguments. A dangerous phrase that is
 * only mentioned (echo, grep, a commit message, a heredoc for a program that
 * is not a shell) is not a command and passes.
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
// Roots, homes and system folders, in POSIX, Git Bash (/c/…), WSL (/mnt/c/…)
// and Windows spellings; "~\" and "$HOME\*" are PowerShell's.
const ROOT_TARGETS = /^(\/|\/\*|~|~[\\/]\*?|\$home|\$\{home\}|\$home[\\/]\*?|\/home|\/home\/\*|\/home\/[^/]+(\/\*)?|\/users\/[^/]+(\/\*)?|\/root|\/etc|\/var|\/usr|\/bin|\/boot|\/opt|\/srv|\/lib|\/lib64|\/sbin|\/var\/www|\/var\/www\/\*|\/var\/lib|(\/mnt)?\/[a-z](\/\*)?|(\/mnt)?\/[a-z]\/(users|windows|program files)(\/[^/]+)?(\/\*)?|[a-z]:\\?\*?|\$env:userprofile([\\/]\*?)?|\$env:systemroot|%userprofile%|[a-z]:\\users(\\[^\\]+)?(\\\*)?|[a-z]:\\windows|[a-z]:\\program files)$/i;
// Block devices: writing to one destroys a disk.
const DISK_DEVICE = /^\/dev\/(sd|nvme|hd|xvd|vd|disk|rdisk|mmcblk|md\d|dm-|mapper\/)/i;
// PowerShell accepts any unique prefix of a parameter, and -Name:value.
const RECURSE = /^-r(e(c(u(r(se?)?)?)?)?)?(:\$true)?$/i;
const FORK_BOMB = /([A-Za-z_:][\w:]*)\s*\(\)\s*\{\s*\1\s*\|\s*\1\s*&\s*;?\s*\}/;
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1([^\n]*)\n([\s\S]*?)\n\s*\2\s*(\n|$)/g;
const HERE_STRING = /<<<\s*(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+))/g;
const PS_VALUE_PARAMS = ["-executionpolicy", "-windowstyle", "-version", "-outputformat", "-inputformat", "-configurationname", "-psconsolefile", "-settingsfile", "-workingdirectory", "-custompipename"];
const LISTERS = new Set(["get-childitem", "gci", "ls", "dir", "get-item", "gi"]);
const REMOVERS = new Set(["remove-item", "ri", "rm", "del", "erase", "rd", "rmdir"]);
// Options that take a value, per prefix command, so the value is not taken
// for the command it runs (`sudo -u www-data rm …`, but `sudo -s rm …`).
const PREFIX_VALUES = {
  sudo: ["-u", "-g", "-C", "-p", "-h", "-D", "-r", "-t", "-U", "-T", "--user", "--group", "--prompt", "--chdir"],
  doas: ["-u", "-C"],
  env: ["-u", "-C", "--unset", "--chdir"],
  nice: ["-n", "--adjustment"],
  ionice: ["-c", "-n", "-p", "--class", "--classdata", "--pid"],
  exec: ["-a"],
  stdbuf: ["-i", "-o", "-e"],
  timeout: ["-s", "-k", "--signal", "--kill-after"],
  watch: ["-n", "--interval"],
  runuser: ["-u", "-g", "-G", "--user", "--group", "--supp-group"],
  "systemd-run": ["-u", "--unit", "-p", "--property", "-E", "--setenv", "-M", "--machine", "-H", "--host", "--description", "--slice", "--uid", "--gid", "--working-directory", "--nice", "--service-type", "--on-calendar", "--on-active"],
  nohup: [], command: [], builtin: [], chroot: [], setsid: []
};
const BUILD_LEAF = /^(node_modules|dist|build|out|\.next|\.nuxt|\.turbo|\.cache|\.parcel-cache|coverage|\.nyc_output|vendor|tmp|temp|__pycache__|\.pytest_cache|target|\.vite|\.svelte-kit|\.output)$/i;
const SAFE_PREFIX = /^(\/tmp\/|\/var\/tmp\/|\$tmpdir\/|\$\{tmpdir\}\/|%temp%\\|\$env:temp\\|~\/\.cache\/|\$\(mktemp|storage\/framework\/|\.\/storage\/framework\/|bootstrap\/cache\/)/i;
const LOCK_FILE = /(^|[\\/])(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|bun\.lockb)$/i;
const DB_CLIENTS = new Set(["mysql", "mariadb", "psql", "sqlite3", "sqlcmd", "mysqlsh", "clickhouse-client", "mongosh", "mongo"]);
const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}", "coproc", "function", "time", "esac", "in", "select"]);
const READ_ONLY = new Set(["cat", "type", "get-content", "gc", "grep", "rg", "egrep", "fgrep", "less", "more", "head", "tail", "jq", "ls", "dir", "findstr", "select-string", "sls", "test-path", "stat", "wc", "diff", "git", "code", "echo", "printf"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

// ------------------------------------------------------------------ parsing

/**
 * Heredoc bodies leave the command line: they are data for the program that
 * receives them. A body fed to a shell is judged separately (see heredocs).
 */
function stripHeredocs(text) {
  return text.replace(HEREDOC, (match, quote, tag, rest) => "<<heredoc" + rest + "\n");
}

/**
 * Every heredoc with the simple command it feeds: the last one on the
 * opening line before "<<", and, for `cat <<EOF | sh`, the command piped to.
 */
function heredocs(text) {
  const found = [];
  for (const match of text.matchAll(HEREDOC)) {
    const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
    const receiver = splitParts(text.slice(lineStart, match.index)).pop();
    const rest = match[3];
    const piped = /^\s*\|(?!\|)/.test(rest) ? splitParts(rest)[0] : null;
    found.push({ receiver: receiver ? words(receiver.text) : [], piped: piped ? words(piped.text) : null, body: match[4] });
  }
  return found;
}

/** A here-string (`<<< 'text'`) and the command line without it. */
function hereString(simple) {
  let body = null;
  const rest = simple.replace(HERE_STRING, (match, single, double, bare) => {
    body = single ?? (double !== undefined ? double.replace(/\\(["\\$`])/g, "$1") : bare);
    return " ";
  });
  return { body, rest };
}

/**
 * Whether a command runs its standard input as commands: a shell without -c
 * or a script file (`bash`, `sh -s`, `bash -ex`), ssh without a remote
 * command, or any wrapper whose inner command is such a shell
 * (`ssh srv bash -s`, `docker exec -i app sh`, `sudo bash`).
 */
function readsCommands(list, depth = 0) {
  const unwrapped = unwrap(list);
  if (unwrapped.inner) {
    return depth < 4 && unwrapped.inner.some((line) => splitCommands(line).some((simple) => readsCommands(words(simple), depth + 1)));
  }
  const rest = unwrapped.words;
  const name = program(rest[0]);
  if (name === "ssh") {
    return true;
  }
  if (SHELLS.has(name) || name === "fish") {
    // `bash -s a b` reads stdin; `bash deploy.sh` reads the file.
    const first = rest.findIndex((word, index) => index > 0 && !word.startsWith("-"));
    return first === -1 || rest.slice(1, first).some((word) => /^-[a-z]*s[a-z]*$/i.test(word));
  }
  return false;
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
  return splitParts(text).map((part) => part.text);
}

/**
 * The simple commands with the separators before each one; `piped` is true
 * when the previous command's output is this one's input (`a | b`, not
 * `a || b`).
 */
function splitParts(text) {
  const parts = [];
  let pending = "";
  const push = (raw) => {
    const trimmed = raw.trim();
    if (trimmed) {
      parts.push({ text: trimmed, piped: /^\|&?$/.test(pending.replace(/\n/g, "")) });
      pending = "";
    }
  };
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
      push(current);
      pending += char;
      current = "";
      continue;
    }
    current += char;
  }
  push(current);
  return parts;
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
    return Buffer.from(String(encoded ?? ""), "base64").toString("utf16le");
  } catch {
    return "";
  }
}

/**
 * PowerShell script blocks glue braces to words (`& {Remove-Item … C:\}`):
 * standing them apart lets the splitter see the commands inside.
 */
function powerShellScript(text) {
  return text.replace(/[{}]/g, (brace) => " " + brace + " ");
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
    if (Object.hasOwn(PREFIX_VALUES, name)) {
      const takesValue = PREFIX_VALUES[name];
      rest = rest.slice(1);
      while (rest.length && (rest[0].startsWith("-") || /^\d+[smhd]?$/.test(rest[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]))) {
        const option = rest.shift();
        if (takesValue.includes(option) && rest.length && !rest[0].startsWith("-")) {
          rest.shift();
        }
      }
      continue;
    }
    if (name === "busybox") {
      rest = rest.slice(1);
      continue;
    }
    if (name === "flock") {
      // flock [options] <lock file> <command…> | -c '<command>'
      let index = 1;
      while (index < rest.length && rest[index].startsWith("-")) {
        if (rest[index] === "-c" || rest[index] === "--command") {
          return { inner: [rest[index + 1] ?? ""] };
        }
        index += /^(-w|--timeout|-E|--conflict-exit-code)$/.test(rest[index]) ? 2 : 1;
      }
      const after = rest.slice(index + 1);
      if (after[0] === "-c" || after[0] === "--command") {
        return { inner: [after[1] ?? ""] };
      }
      rest = after;
      continue;
    }
    if (name === "wsl") {
      // wsl [-d distro] [-u user] [--cd dir] [-e|--exec|--] <command…>
      let index = 1;
      while (index < rest.length && rest[index].startsWith("-")) {
        if (["-e", "--exec", "--"].includes(rest[index])) {
          index += 1;
          break;
        }
        index += /^(-d|--distribution|-u|--user|--cd|--shell-type)$/.test(rest[index]) ? 2 : 1;
      }
      rest = rest.slice(index);
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
      // PowerShell takes any unique prefix of a parameter (-enco, -Comm) and
      // the -Name:value form.
      let index = 1;
      while (index < rest.length && rest[index].startsWith("-")) {
        const [option, ...valueParts] = rest[index].toLowerCase().split(":");
        const glued = valueParts.length ? rest[index].slice(option.length + 1) : null;
        const value = (offset) => (glued !== null ? glued : rest[index + offset]);
        if (option === "-e" || option === "-ec" || (option.length >= 3 && "-encodedcommand".startsWith(option))) {
          return { inner: [powerShellScript(decodePowerShell(value(1)))] };
        }
        if (option === "-c" || option === "-cwa" || (option.length >= 3 && ("-command".startsWith(option) || "-commandwithargs".startsWith(option)))) {
          const script = glued !== null ? [glued, ...rest.slice(index + 1)] : rest.slice(index + 1);
          return { inner: [powerShellScript(script.join(" "))] };
        }
        if (option === "-f" || (option.length >= 3 && "-file".startsWith(option))) {
          return { words: ["powershell-file", ...(glued !== null ? [glued] : []), ...rest.slice(index + 1)] };
        }
        // Skipping a value hides a word from judgement, so only known
        // value-taking parameters (or prefixes of 3+ characters) skip one.
        const withValue = ["-ep", "-ex", "-w", "-v", "-o", "-of", "-if", "-wd"].includes(option)
          || (option.length >= 4 && PS_VALUE_PARAMS.some((param) => param.startsWith(option)));
        index += withValue && glued === null ? 2 : 1;
      }
      return index < rest.length ? { inner: [powerShellScript(rest.slice(index).join(" "))] } : { words: rest };
    }
    if (name === "iex" || name === "invoke-expression") {
      return { inner: [powerShellScript(rest.slice(1).filter((word) => !/^-command$/i.test(word)).join(" "))] };
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
      // OpenSSH also takes switches after the host: `ssh srv -t 'cmd'`.
      let command = rest.slice(index + 1);
      while (command.length && command[0].startsWith("-") && command[0] !== "--") {
        command = command.slice(/^-[bcDEeFIiJLlmOopQRSWw]$/.test(command[0]) ? 2 : 1);
      }
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
  // In PowerShell rmdir, rd, del and erase are all Remove-Item, so -Recurse
  // counts for them too; /s is cmd's spelling.
  const recursive = lower.some((word) => RECURSE.test(word)) || (!powershell && lower.includes("/s"));
  const targets = [];
  for (let index = 1; index < list.length; index += 1) {
    const word = list[index];
    const glued = /^-(path|literalpath|lp|pspath):(.+)$/i.exec(word);
    if (glued) {
      targets.push(glued[2]);
    } else if (/^-(path|literalpath|lp|pspath)$/i.test(word)) {
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

/**
 * `Get-ChildItem C:\ -Recurse | Remove-Item`: what is deleted is what the
 * listing names. A recursive listing or delete is judged as a recursive
 * delete of the listed path; a flat one is refused only for a root.
 */
function judgePipedDelete(lister, remover) {
  const targets = [];
  for (let index = 1; index < lister.length; index += 1) {
    const word = lister[index];
    if (/^-(path|literalpath|lp|pspath)$/i.test(word)) {
      targets.push(lister[index + 1] ?? "");
      index += 1;
    } else if (/^-(filter|include|exclude|depth|attributes)$/i.test(word)) {
      index += 1;
    } else if (!word.startsWith("-")) {
      targets.push(word);
    }
  }
  if (!targets.length) {
    targets.push(".");
  }
  if ([...lister, ...remover].some((word) => RECURSE.test(word))) {
    return deleteVerdict(targets, { recursive: true });
  }
  if (targets.some((target) => ROOT_TARGETS.test(normaliseTarget(target)))) {
    return verdict("deny", "deleting the contents of a root, home or system folder");
  }
  return ALLOW;
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
  // `git restore --staged .` only unstages; the working tree is untouched.
  const unstageOnly = sub === "restore" && args.some((word) => word === "--staged" || /^-[a-z]*S[a-z]*$/.test(word)) && !args.some((word) => word === "--worktree" || /^-[a-zA-Z]*W[a-zA-Z]*$/.test(word));
  if ((sub === "checkout" || sub === "restore") && !unstageOnly && (args.includes(".") || args.includes(":/"))) {
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
  // MongoDB shell: dropping a database or collection, deleting every document.
  if (/\.dropDatabase\s*\(|\.drop\s*\(\s*\)|\.(deleteMany|remove)\s*\(\s*\{\s*\}\s*\)/.test(text)) {
    return verdict("ask", "dropping or emptying MongoDB data");
  }
  return ALLOW;
}

/**
 * Approval records are written only by AStack's own code and the owner: an
 * agent forging one is the threat, so any shell write there is refused.
 */
const APPROVALS = /\.astack[\\/]approvals([\\/]|$)/i;

/** Writing the guard's own state or Claude Code's settings asks. */
function guardFilesVerdict(name, raw) {
  if (redirectTargets(raw).some((target) => APPROVALS.test(target)) || (!READ_ONLY.has(name) && APPROVALS.test(raw))) {
    return verdict("deny", "approvals are written only by AStack and the owner");
  }
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
  // `cat /dev/zero > /dev/sda`, `… | tee /dev/nvme0n1`: whatever the program.
  const disk = redirectTargets(raw).some((target) => DISK_DEVICE.test(target)) || (name === "tee" && list.slice(1).some((word) => DISK_DEVICE.test(word)))
    ? verdict("deny", "writing raw to a disk device")
    : ALLOW;
  const own = judgeProgram(name, list, lower, raw);
  return strongest([files, disk, own]);
}

function judgeProgram(name, list, lower, raw) {
  if (name === "rm" && lower.some((word) => /^-recurse$/.test(word))) {
    return judgeWindowsDelete("rm", list);
  }
  if (name === "rm") {
    return judgeRm(list);
  }
  if (["remove-item", "ri", "del", "erase", "rd", "rmdir"].includes(name)) {
    if ((name === "rmdir" || name === "rd") && !lower.includes("/s") && !lower.some((word) => RECURSE.test(word))) {
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
    // "all" and a /regex/ name both reach other people's processes.
    if (["restart", "reload", "stop", "delete", "sendsignal"].includes(action) && lower.slice(2).some((word) => word === "all" || /^\/.+\/$/.test(word))) {
      return verdict("deny", "owner rule: never touch every pm2 process on a shared server");
    }
    if (action === "update") {
      return verdict("ask", "pm2 update restarts the daemon and every process on the server");
    }
    return ALLOW;
  }
  if (/^mkfs(\.\w+)?$/.test(name) || (name === "format" && /^[a-z]:$/i.test(list[1] ?? "")) || ["format-volume", "clear-disk", "remove-partition", "blkdiscard"].includes(name)) {
    return verdict("deny", "formatting or erasing a disk");
  }
  if (name === "wipefs" && !lower.some((word) => word === "-n" || word === "--no-act") && lower.some((word) => /^-[a-z]*a/.test(word) || ["--all", "-o", "--offset"].includes(word) || word.startsWith("--offset="))) {
    return verdict("deny", "erasing disk signatures");
  }
  if (name === "sgdisk") {
    if (list.some((word) => /^(-[zZo]|--zap|--zap-all|--clear|-d|--delete)(=|$)/.test(word))) {
      return verdict("deny", "erasing a partition table");
    }
    return list.slice(1).every((word) => /^(-p|--print|-v|--verify|-i|--info(=.*)?|\d+|\/dev\/\S+)$/.test(word)) ? ALLOW : verdict("ask", "partitioning disks");
  }
  if (name === "parted") {
    if (lower.some((word) => ["rm", "mklabel", "mktable"].includes(word))) {
      return verdict("deny", "erasing a partition table");
    }
    return lower.slice(1).every((word) => /^(-l|--list|print|-s|--script|-m|--machine|\/dev\/\S+)$/.test(word)) && lower.length > 1 ? ALLOW : verdict("ask", "partitioning disks");
  }
  if (name === "shred" && list.slice(1).some((word) => DISK_DEVICE.test(word))) {
    return verdict("deny", "erasing a disk");
  }
  if (name === "dd" && list.some((word) => /^of=/i.test(word) && DISK_DEVICE.test(word.slice(3)))) {
    return verdict("deny", "writing raw to a disk device");
  }
  if (["diskpart", "fdisk", "sfdisk", "gdisk", "cfdisk"].includes(name) && !lower.some((word) => word === "-l" || word === "--list")) {
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
  if (name === "php" && lower[1] === "artisan" && /^(migrate:fresh|migrate:refresh|migrate:reset|migrate:rollback|db:wipe)$/.test(lower[2] ?? "")) {
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
  if ((name === "redis-cli" && lower.some((word) => word === "flushall" || word === "flushdb")) || (name === "mysqladmin" && lower.includes("drop")) || name === "dropdb") {
    return verdict("ask", "wiping a database");
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
    return strongest(unwrapped.inner.map((line) => nested(line, depth)));
  }
  return judgeWords(unwrapped.words);
}

/** Judge text that will run as commands one level deeper. */
function nested(line, depth) {
  return depth < 4 ? judgeCommand(line, depth + 1) : verdict("ask", "deeply nested command");
}

/** The decision for one shell command line: { decision: deny|ask|allow, reason }. */
export function judgeCommand(command, depth = 0) {
  const original = String(command ?? "");
  const results = [];
  if (FORK_BOMB.test(original)) {
    results.push(verdict("deny", "fork bomb"));
  }
  // A heredoc body is data, unless the command receiving it is a shell
  // (`ssh srv <<EOF`, `bash -s <<EOF`, `cat <<EOF | sh`): then it is commands.
  for (const doc of heredocs(original)) {
    if (readsCommands(doc.receiver) || (doc.piped && program(doc.receiver[0]) === "cat" && readsCommands(doc.piped))) {
      results.push(nested(doc.body, depth));
    }
  }
  const text = stripHeredocs(original);
  for (const body of substitutions(text)) {
    results.push(nested(body, depth));
  }
  let previous = null;
  for (const part of splitParts(text)) {
    const simple = part.text;
    // A here-string is standard input, not an argument.
    const here = hereString(simple);
    const list = words(here.rest);
    if (here.body !== null && readsCommands(list)) {
      results.push(nested(here.body, depth));
    }
    const unwrapped = unwrap(list);
    const from = part.piped ? previous : null;
    previous = null;
    if (unwrapped.inner) {
      results.push(...unwrapped.inner.map((line) => nested(line, depth)));
      continue;
    }
    results.push(judgeWords(unwrapped.words, simple));
    const name = program(unwrapped.words[0]);
    if (from) {
      const source = program(from[0]);
      // echo/printf "…" | sh: what the shell runs is the echoed text.
      if (["echo", "printf"].includes(source) && readsCommands(unwrapped.words)) {
        results.push(nested(from.slice(1).join(" "), depth));
      }
      // Get-ChildItem C:\ -Recurse | Remove-Item: the listing is the target.
      if (LISTERS.has(source) && REMOVERS.has(name)) {
        results.push(judgePipedDelete(from, unwrapped.words));
      }
    }
    // SQL piped or heredoc'd into a database client.
    if (DB_CLIENTS.has(name)) {
      results.push(judgeSql(original));
    }
    previous = unwrapped.words;
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
  if (target && /[\\/]\.astack[\\/]approvals([\\/]|$)/i.test(target)) {
    return verdict("deny", "approvals are written only by AStack and the owner");
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
