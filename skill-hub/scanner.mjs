import { existsSync, lstatSync, openSync, readFileSync, readSync, closeSync, readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

/**
 * Static security scanner for third-party skills.
 *
 * Conservative by design: it reads files as bytes and text, matches patterns,
 * and reports. It never executes, imports, requires or evaluates anything it
 * scans. A skill that ships scripts always needs a human review, whatever the
 * patterns say, because a pattern scanner cannot prove code is safe.
 *
 * Severity of a finding: info < low < medium < high < critical.
 * Risk of a skill: the worst finding — low | medium | high | blocked
 * (critical findings block the skill from ever being selected).
 */

export const RISK_LEVELS = ["low", "medium", "high", "blocked"];
export const SEVERITIES = ["info", "low", "medium", "high", "critical"];
export const FINDING_CLASSES = [
  "injection",
  "hidden-text",
  "pipe-to-shell",
  "credential-access",
  "exfiltration",
  "destructive",
  "obfuscation",
  "binary",
  "script"
];

export const MAX_FILE_BYTES = 2 * 1024 * 1024;

const SCRIPT_EXTENSIONS = new Set([
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".psm1", ".psd1", ".bat", ".cmd", ".vbs", ".py", ".pyw", ".js", ".mjs", ".cjs",
  ".ts", ".mts", ".cts", ".rb", ".pl", ".php", ".lua", ".go", ".rs", ".swift", ".applescript", ".scpt", ".jxa", ".r"
]);

const EXECUTABLE_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".com", ".msi", ".scr", ".sys", ".elf", ".o", ".a", ".class", ".jar", ".pyc", ".pyo", ".wasm", ".node", ".app", ".deb", ".rpm", ".apk", ".dmg", ".pkg"
]);

const KNOWN_BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tif", ".tiff", ".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz",
  ".7z", ".rar", ".tar", ".mp3", ".mp4", ".wav", ".ogg", ".mov", ".avi", ".webm", ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".sqlite", ".db", ".psd", ".xlsx", ".docx", ".pptx", ".xls", ".doc", ".ppt"
]);

const NEGATED = /\b(never|don'?t|do not|must not|avoid|dangerous|warning|forbidden|blocked|deny|refuse|example of (an? )?attack|malicious|grep|detect(s|ed|ion)?|guard)\b/i;
// An injection phrase quoted as an example ("reject phrases like 'ignore
// previous instructions'") is discussion, not instruction.
const QUOTED = (line, match) => {
  const before = line.slice(0, match.index).trimEnd().slice(-1);
  const after = line.slice(match.index + match[0].length).trimStart().slice(0, 1);
  return /["'`“‘«]/.test(before) || /["'`”’»]/.test(after);
};

// ---------------------------------------------------------------- rules
// Each rule: { id, class, severity, pattern, appliesTo?: "text"|"code"|"markdown", negatable?: bool }
const LINE_RULES = [
  // Prompt injection phrases.
  { id: "injection.ignore-instructions", class: "injection", severity: "high", pattern: /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier|preceding|system|original)\s+(instructions?|prompts?|messages?|rules|directives)/i },
  { id: "injection.you-are-now", class: "injection", severity: "high", pattern: /\byou are now\b(?!\s+(ready|done|able|in\s+(the\s+)?\w+\s+(mode|directory|folder)))/i },
  { id: "injection.new-system-prompt", class: "injection", severity: "high", pattern: /\b(new|updated|real|actual)\s+system\s+prompt\b|\bsystem prompt override\b/i },
  { id: "injection.conceal-from-user", class: "injection", severity: "high", pattern: /\b(do not|don'?t|never)\s+(tell|inform|notify|reveal to|mention (this|it) to)\s+the\s+(user|owner|human)\b(?!\s+(to|that you can'?t|you cannot|they)\b)|\bwithout (telling|informing|notifying) the (user|owner|human)\b/i },
  { id: "injection.reveal-secrets", class: "injection", severity: "high", pattern: /\breveal\s+(your\s+)?(system prompt|hidden instructions|credentials|api keys?|secrets?)\b/i },
  { id: "injection.jailbreak", class: "injection", severity: "high", pattern: /\b(jailbreak(en)?|DAN mode|developer mode enabled|unrestricted mode|no longer bound by)\b/i },

  // Remote content piped into an interpreter.
  { id: "pipe.curl-sh", class: "pipe-to-shell", severity: "high", negatable: true, pattern: /\b(curl|wget|fetch)\b[^\n|]*\|\s*(sudo\s+(-\S+\s+)*)?(ba|z|da|k|fi)?sh\b|\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(python[0-9.]*|node|perl|ruby|php)(\s+-)?\s*($|[;&|)'"\x60])/i },
  { id: "pipe.process-substitution", class: "pipe-to-shell", severity: "high", negatable: true, pattern: /\b(ba|z)?sh\s+(-c\s+)?["']?(<\(|\$\()\s*(curl|wget)\b/i },
  { id: "pipe.iwr-iex", class: "pipe-to-shell", severity: "high", negatable: true, pattern: /\b(iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring)\b[^\n]*\|\s*(iex|invoke-expression)\b|\b(iex|invoke-expression)\b\s*[(\s]+[^\n]*\b(iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring|net\.webclient)\b/i },
  { id: "pipe.encoded-powershell", class: "pipe-to-shell", severity: "high", pattern: /\b(powershell|pwsh)(\.exe)?\b[^\n]*\s-(e|enc|encodedcommand)\s+[A-Za-z0-9+/=]{16,}/i },

  // Credential stores and secrets on disk.
  { id: "credential.ssh", class: "credential-access", severity: "medium", pattern: /~\/\.ssh\b|\$HOME\/\.ssh\b|%USERPROFILE%\\\.ssh|\bid_(rsa|ed25519|ecdsa|dsa)\b(?!\.pub)/i },
  { id: "credential.cloud-files", class: "credential-access", severity: "medium", pattern: /~\/\.(aws\/credentials|netrc|pgpass|docker\/config\.json|kube\/config|git-credentials|npmrc|pypirc)\b|\.config\/gcloud\/(credentials|application_default)/i },
  { id: "credential.dotenv-read", class: "credential-access", severity: "medium", pattern: /\b(cat|type|less|more|head|tail|source|Get-Content|gc)\s+[^\n|;]*\.env\b|open\(\s*["'][^"']*\.env["']/i },
  { id: "credential.keychain", class: "credential-access", severity: "medium", pattern: /\bsecurity\s+(find|dump)-(generic|internet)-password\b|\bdump-keychain\b|\bcmdkey\s+\/list\b|\bCredential Manager\b|\bvaultcmd\b|\bsecret-tool\s+lookup\b|\bkeyring\.get_password\b/i },
  { id: "credential.browser-profile", class: "credential-access", severity: "high", pattern: /\b(Login Data|Local State|Cookies\.sqlite|cookies\.sqlite|key4\.db|logins\.json)\b|Google[\\/]Chrome[\\/]User Data|Application Support\/Google\/Chrome|\.mozilla\/firefox|BraveSoftware[\\/]Brave-Browser[\\/]User Data/ },
  { id: "credential.astack-reference", class: "credential-access", severity: "high", pattern: /\bcredential:\/\/[a-z0-9_-]+/i },

  // Exfiltration channels.
  { id: "exfil.capture-service", class: "exfiltration", severity: "high", pattern: /\b(webhook\.site|requestbin\.(com|net)|pipedream\.net|beeceptor\.com|hookbin\.com|interact\.sh|oast\.(fun|pro|live|site|online|me)|burpcollaborator\.net|canarytokens\.com|ngrok(-free)?\.(io|app))\b/i },
  { id: "exfil.pastebin", class: "exfiltration", severity: "medium", pattern: /\b(pastebin\.com|paste\.ee|hastebin\.com|ghostbin\.\w+|termbin\.com|transfer\.sh|0x0\.st|file\.io|dpaste\.(com|org)|ix\.io)\b/i },
  { id: "exfil.chat-webhook", class: "exfiltration", severity: "medium", pattern: /discord(app)?\.com\/api\/webhooks\/|hooks\.slack\.com\/services\/[A-Z0-9]|api\.telegram\.org\/bot[0-9]/i },
  { id: "exfil.raw-ip-url", class: "exfiltration", severity: "medium", pattern: /\b(https?|ftp|wss?):\/\/(?!(127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|localhost))\d{1,3}(\.\d{1,3}){3}\b/i },

  // Destructive commands.
  { id: "destructive.rm-root", class: "destructive", severity: "critical", negatable: true, pattern: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*|--recursive\s+(--force\s+)?)(\/(\*)?|~\/?|\$HOME\/?|\/\*|\/(etc|usr|bin|boot|var|home|root|System|Users))(\s|$|["'`;|&])/ },
  { id: "destructive.rm-glob", class: "destructive", severity: "medium", negatable: true, pattern: /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*f?[a-zA-Z]*\s+(\.\/)?\*(\s|$)/ },
  { id: "destructive.windows-wipe", class: "destructive", severity: "critical", negatable: true, pattern: /\bformat(\.com)?\s+[a-z]:(\s|$|\/)|\bdel\s+(\/[a-z]\s+)*\/s\b[^\n]*[a-z]:\\(\s|$|\*)|\brd\s+\/s\s+\/q\s+[a-z]:\\(\s|$)|Remove-Item\b[^\n]*-Recurse[^\n]*\s[A-Za-z]:\\?(\s|$|\*)/i },
  { id: "destructive.disk", class: "destructive", severity: "critical", negatable: true, pattern: /\bmkfs(\.\w+)?\s+\/dev\/|\bdd\s+[^\n]*of=\/dev\/(sd|nvme|hd|disk)|>\s*\/dev\/sd[a-z]\b|\bdiskpart\b[^\n]*\bclean\b/i },
  { id: "destructive.fork-bomb", class: "destructive", severity: "critical", negatable: true, pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  { id: "destructive.del-s", class: "destructive", severity: "high", negatable: true, pattern: /\bdel\s+(\/[a-z]\s+)*\/s\b|\brmdir\s+\/s\s+\/q\b/i },

  // Obfuscation and decoded execution.
  { id: "obfuscation.eval-decoded", class: "obfuscation", severity: "critical", pattern: /\b(eval|exec|Function|execSync|spawnSync|system|popen|Invoke-Expression|iex)\s*\(\s*[^\n]{0,40}\b(atob|b64decode|base64\.b64decode|Buffer\.from\([^)]*["']base64["']|FromBase64String|decodebytes|unhexlify|codecs\.decode)/i },
  { id: "obfuscation.decode-to-shell", class: "obfuscation", severity: "critical", pattern: /\bbase64\s+(-d|--decode|-D)\b[^\n]*\|\s*(sudo\s+)?(ba|z)?sh\b|\bxxd\s+-r\b[^\n]*\|\s*(ba|z)?sh\b|FromBase64String[^\n]*\|\s*(iex|Invoke-Expression)\b/i },
  { id: "obfuscation.base64-blob", class: "obfuscation", severity: "medium", pattern: /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{240,}={0,2}(?![A-Za-z0-9+/])/ },
  { id: "obfuscation.hex-blob", class: "obfuscation", severity: "medium", pattern: /(?:\\x[0-9a-fA-F]{2}){60,}|(?<![0-9a-fA-F])[0-9a-fA-F]{240,}(?![0-9a-fA-F])/ }
];

const BIDI = /[‪-‮⁦-⁩]/;
const ZERO_WIDTH = /[​⁠᠎⁡-⁤]|(?<=[A-Za-z])[‌‍](?=[A-Za-z])|(?<!^)﻿/;
// A comment that addresses the agent rather than the human reader.
const HTML_COMMENT_DIRECTIVE = /\b(ignore|disregard)\b[^.]{0,40}\b(instructions?|rules|above|previous)\b|\b(assistant|the (ai|model|agent|llm)|claude|gpt|chatgpt)\b[^.]{0,60}\b(must|should|will|always|never|do not|don'?t)\b|\bsystem prompt\b|\bdo not (tell|show|reveal)\b|\bexfiltrat|\bsecretly\b/i;

function lineOf(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index && cursor < text.length; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) {
      line += 1;
    }
  }
  return line;
}

function visible(text, max = 140) {
  return String(text)
    .replace(/[​-‏‪-‮⁠-⁩᠎﻿]/g, (char) => "\\u{" + char.codePointAt(0).toString(16) + "}")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function lowered(severity) {
  const index = SEVERITIES.indexOf(severity);
  return SEVERITIES[Math.max(1, index - 1)];
}

export function isScriptFile(rel, head = "") {
  const extension = extname(rel).toLowerCase();
  const parts = rel.split(/[\\/]/);
  if (SCRIPT_EXTENSIONS.has(extension)) {
    return true;
  }
  if (head.startsWith("#!")) {
    return true;
  }
  return parts.length > 1 && parts[0] === "scripts" && !/\.(md|txt|json|ya?ml)$/i.test(rel);
}

/**
 * Inspect the first bytes of a file. Returns { binary, executable, kind }.
 */
export function sniff(path, rel = path) {
  const extension = extname(rel).toLowerCase();
  let buffer = Buffer.alloc(0);
  try {
    const fd = openSync(path, "r");
    const chunk = Buffer.alloc(8192);
    const size = readSync(fd, chunk, 0, chunk.length, 0);
    closeSync(fd);
    buffer = chunk.subarray(0, size);
  } catch {
    return { binary: false, executable: false, kind: "unreadable" };
  }
  const magic = buffer.subarray(0, 4).toString("hex");
  const executableMagic =
    magic === "7f454c46" || // ELF
    buffer.subarray(0, 2).toString("latin1") === "MZ" || // PE
    ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"].includes(magic) || // Mach-O / fat / class
    magic === "0061736d"; // wasm
  const hasNul = buffer.includes(0);
  const executable = executableMagic || EXECUTABLE_EXTENSIONS.has(extension);
  const binary = executable || hasNul || KNOWN_BINARY_EXTENSIONS.has(extension);
  return { binary, executable, kind: executable ? "executable" : binary ? "binary" : "text" };
}

/**
 * Scan one text file. `rel` is the path reported in findings.
 */
export function scanText(text, rel) {
  const findings = [];
  const markdown = /\.(md|markdown|mdx|txt)$/i.test(rel);
  const code = isScriptFile(rel, text.slice(0, 2));
  const lines = String(text).split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }
    for (const rule of LINE_RULES) {
      const match = rule.pattern.exec(line);
      if (!match) {
        continue;
      }
      let severity = rule.severity;
      if (rule.negatable && NEGATED.test(line)) {
        severity = lowered(severity);
      }
      if (rule.class === "injection" && QUOTED(line, match)) {
        severity = "medium";
      }
      findings.push({ rule: rule.id, class: rule.class, severity, file: rel, line: index + 1, excerpt: visible(line) });
    }
    if (BIDI.test(line)) {
      findings.push({
        rule: "hidden.bidi-control",
        class: "hidden-text",
        severity: code ? "critical" : "high",
        file: rel,
        line: index + 1,
        excerpt: visible(line)
      });
    }
    if (ZERO_WIDTH.test(index === 0 ? line.replace(/^﻿/, "") : line)) {
      findings.push({ rule: "hidden.zero-width", class: "hidden-text", severity: "medium", file: rel, line: index + 1, excerpt: visible(line) });
    }
  }

  // Hidden instructions inside HTML comments of markdown files.
  if (markdown) {
    const comment = /<!--([\s\S]*?)-->/g;
    let match;
    while ((match = comment.exec(text))) {
      const inner = match[1];
      const line = lineOf(text, match.index);
      const injected = LINE_RULES.some((rule) => rule.class === "injection" && rule.pattern.test(inner));
      if (injected || (BIDI.test(inner) || /[​⁠]/.test(inner))) {
        findings.push({ rule: "injection.html-comment", class: "injection", severity: "critical", file: rel, line, excerpt: visible(inner) });
      } else if (HTML_COMMENT_DIRECTIVE.test(inner)) {
        findings.push({ rule: "injection.html-comment-directive", class: "injection", severity: "high", file: rel, line, excerpt: visible(inner) });
      }
    }
  }

  // Credential read and exfiltration in the same file of code is the classic
  // stealer shape: escalate both to critical.
  if (code) {
    const credential = findings.filter((finding) => finding.class === "credential-access");
    const exfil = findings.filter((finding) => finding.class === "exfiltration");
    if (credential.length && exfil.length) {
      findings.push({
        rule: "exfil.credential-to-network",
        class: "exfiltration",
        severity: "critical",
        file: rel,
        line: exfil[0].line,
        excerpt: "credential access (line " + credential[0].line + ") and an exfiltration channel (line " + exfil[0].line + ") in one script"
      });
    }
  }
  return findings;
}

/**
 * Git metadata in any spelling Windows or git treats as the same name:
 * `.git`, `.GIT`, `.Git.` (NTFS drops trailing dots and spaces), the 8.3
 * short name `git~1`, every `.git*` file (`.gitattributes`, `.gitmodules`,
 * `.gitignore`, …) and `.lfsconfig`. None of it belongs in a skill, and a
 * planted `.git` folder or filter file makes git run attacker config.
 */
export function isGitMetadataName(name) {
  const normal = String(name ?? "").toLowerCase().replace(/[. ]+$/, "");
  return normal.startsWith(".git") || normal === "git~1" || normal === ".lfsconfig";
}

/**
 * List files of a skill folder without following symbolic links. Git
 * metadata (see isGitMetadataName) is never listed, so it is never scanned
 * as part of the skill nor copied by an import.
 */
export function listSkillFiles(directory) {
  const files = [];
  const walk = (current) => {
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(current, entry.name);
      const rel = relative(directory, absolute).split(sep).join("/");
      if (entry.name === ".git" || isGitMetadataName(entry.name)) {
        continue;
      }
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        files.push({ rel, absolute, size: 0, symlink: true });
        continue;
      }
      if (stat.isDirectory()) {
        walk(absolute);
      } else if (stat.isFile()) {
        files.push({ rel, absolute, size: stat.size, symlink: false });
      }
    }
  };
  walk(directory);
  return files;
}

export function riskOf(findings) {
  const worst = findings.reduce((max, finding) => Math.max(max, SEVERITIES.indexOf(finding.severity)), 0);
  if (worst >= 4) {
    return "blocked";
  }
  if (worst === 3) {
    return "high";
  }
  if (worst === 2) {
    return "medium";
  }
  return "low";
}

/**
 * Scan a skill folder. Returns the risk label, every finding with file:line,
 * whether the skill ships scripts, and the files that are binary or too large.
 */
export function scanSkill(directory, { maxBytes = MAX_FILE_BYTES } = {}) {
  if (!existsSync(directory)) {
    throw new Error("Skill folder not found: " + directory);
  }
  const findings = [];
  const scripts = [];
  const binaries = [];
  const oversized = [];
  let bytes = 0;
  const files = listSkillFiles(directory);
  for (const file of files) {
    if (file.symlink) {
      findings.push({ rule: "binary.symlink", class: "binary", severity: "high", file: file.rel, line: 0, excerpt: "symbolic link (not followed)" });
      continue;
    }
    bytes += file.size;
    if (file.size > maxBytes) {
      oversized.push(file.rel);
      findings.push({ rule: "binary.oversized", class: "binary", severity: "medium", file: file.rel, line: 0, excerpt: "file larger than " + maxBytes + " bytes (not scanned)" });
      continue;
    }
    const kind = sniff(file.absolute, file.rel);
    if (kind.binary) {
      binaries.push(file.rel);
      findings.push({
        rule: kind.executable ? "binary.executable" : "binary.data",
        class: "binary",
        severity: kind.executable ? "critical" : "low",
        file: file.rel,
        line: 0,
        excerpt: kind.executable ? "executable binary" : "binary file (not scanned)"
      });
      continue;
    }
    const text = readFileSync(file.absolute, "utf8");
    if (isScriptFile(file.rel, text.slice(0, 2))) {
      scripts.push(file.rel);
    }
    findings.push(...scanText(text, file.rel));
  }
  if (scripts.length) {
    findings.push({ rule: "script.present", class: "script", severity: "info", file: scripts[0], line: 0, excerpt: scripts.length + " script file(s): never executed by import or selection" });
  }
  const risk = riskOf(findings);
  return {
    risk,
    findings,
    counts: countBySeverity(findings),
    hasScripts: scripts.length > 0,
    scripts,
    binaries,
    oversized,
    files: files.length,
    bytes,
    requiresReview: scripts.length > 0 || risk === "high" || risk === "blocked"
  };
}

export function countBySeverity(findings) {
  const counts = {};
  for (const severity of SEVERITIES) {
    counts[severity] = 0;
  }
  for (const finding of findings) {
    counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
  }
  return counts;
}

/**
 * Findings that matter for a human summary (info findings are noise).
 */
export function significant(findings) {
  return findings.filter((finding) => finding.severity !== "info");
}
