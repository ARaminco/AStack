import { extname } from "node:path";
import { normalizeText } from "../lib/text.mjs";

const LANGUAGES = {
  ".mjs": "javascript", ".cjs": "javascript", ".js": "javascript", ".jsx": "javascript",
  ".ts": "typescript", ".tsx": "typescript", ".vue": "vue", ".svelte": "svelte",
  ".php": "php", ".py": "python", ".rb": "ruby", ".go": "go", ".java": "java", ".kt": "kotlin",
  ".cs": "csharp", ".rs": "rust", ".swift": "swift", ".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp",
  ".sql": "sql", ".sh": "shell", ".bash": "shell", ".ps1": "powershell", ".dart": "dart",
  ".md": "markdown", ".mdx": "markdown", ".txt": "text", ".rst": "text", ".adoc": "text", ".csv": "csv",
  ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml", ".ini": "ini", ".xml": "xml",
  ".html": "html", ".htm": "html", ".css": "css", ".scss": "css", ".env": "env"
};

const CATEGORIES = {
  javascript: "code", typescript: "code", vue: "code", svelte: "code", php: "code", python: "code",
  ruby: "code", go: "code", java: "code", kotlin: "code", csharp: "code", rust: "code", swift: "code",
  c: "code", cpp: "code", sql: "code", shell: "code", powershell: "code", dart: "code", css: "code",
  html: "code", markdown: "doc", text: "doc", csv: "data", json: "data", yaml: "config", toml: "config",
  ini: "config", xml: "data", env: "config"
};

const SYMBOL_PATTERNS = {
  javascript: [
    ["class", /^\s*(?:export\s+(?:default\s+)?)?class\s+([A-Za-z0-9_$]+)/],
    ["function", /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/],
    ["const", /^\s*export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/],
    ["method", /^\s{2,}(?:async\s+)?([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{/]
  ],
  php: [
    ["class", /^\s*(?:final\s+|abstract\s+)?class\s+([A-Za-z0-9_]+)/],
    ["interface", /^\s*(?:interface|trait|enum)\s+([A-Za-z0-9_]+)/],
    ["function", /^\s*(?:public|protected|private|static|\s)*function\s+([A-Za-z0-9_]+)/]
  ],
  python: [
    ["class", /^\s*class\s+([A-Za-z0-9_]+)/],
    ["function", /^\s*(?:async\s+)?def\s+([A-Za-z0-9_]+)/]
  ],
  go: [
    ["function", /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)/],
    ["type", /^\s*type\s+([A-Za-z0-9_]+)/]
  ],
  java: [
    ["class", /^\s*(?:public|private|protected|\s)*(?:final\s+|abstract\s+)?(?:class|interface|enum|record)\s+([A-Za-z0-9_]+)/],
    ["method", /^\s*(?:public|private|protected)\s+[A-Za-z0-9_<>\[\]]+\s+([A-Za-z0-9_]+)\s*\(/]
  ],
  sql: [
    ["table", /^\s*CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+["`]?([A-Za-z0-9_.]+)/i],
    ["view", /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:VIEW|FUNCTION|PROCEDURE)\s+["`]?([A-Za-z0-9_.]+)/i]
  ],
  shell: [["function", /^\s*(?:function\s+)?([A-Za-z0-9_]+)\s*\(\)\s*\{/]],
  powershell: [["function", /^\s*function\s+([A-Za-z0-9_-]+)/i]]
};

SYMBOL_PATTERNS.typescript = [
  ...SYMBOL_PATTERNS.javascript,
  ["type", /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z0-9_$]+)/]
];
SYMBOL_PATTERNS.vue = SYMBOL_PATTERNS.javascript;
SYMBOL_PATTERNS.svelte = SYMBOL_PATTERNS.javascript;
SYMBOL_PATTERNS.ruby = [["class", /^\s*(?:class|module)\s+([A-Za-z0-9_:]+)/], ["function", /^\s*def\s+([A-Za-z0-9_?!]+)/]];
SYMBOL_PATTERNS.csharp = SYMBOL_PATTERNS.java;
SYMBOL_PATTERNS.kotlin = [["class", /^\s*(?:data\s+|sealed\s+)?class\s+([A-Za-z0-9_]+)/], ["function", /^\s*(?:suspend\s+)?fun\s+([A-Za-z0-9_]+)/]];
SYMBOL_PATTERNS.rust = [["type", /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z0-9_]+)/], ["function", /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/]];
SYMBOL_PATTERNS.swift = [["class", /^\s*(?:public\s+|open\s+)?(?:class|struct|enum|protocol)\s+([A-Za-z0-9_]+)/], ["function", /^\s*(?:public\s+|private\s+)?func\s+([A-Za-z0-9_]+)/]];
SYMBOL_PATTERNS.dart = [["class", /^\s*(?:abstract\s+)?class\s+([A-Za-z0-9_]+)/]];

const IMPORT_PATTERNS = [
  /^\s*import\s+[^"']*from\s+["']([^"']+)["']/,
  /^\s*import\s+["']([^"']+)["']/,
  /require\(\s*["']([^"']+)["']\s*\)/,
  /^\s*use\s+([A-Za-z0-9_\\]+);/,
  /^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+/,
  /^\s*#include\s+[<"]([^>"]+)[>"]/,
  /@import\s+["']([^"']+)["']/
];

const LINK_PATTERN = /\[[^\]]{0,80}\]\(([^)\s]{1,160})\)|\[\[([^\]]{1,80})\]\]/g;
const HEADING_PATTERN = /^(#{1,6})\s+(.{1,160}?)\s*$/;

export function detectLanguage(relPath) {
  const extension = extname(relPath).toLowerCase();
  if (LANGUAGES[extension]) {
    return LANGUAGES[extension];
  }
  const base = relPath.split("/").pop().toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile")) {
    return "config";
  }
  if (base.startsWith(".env")) {
    return "env";
  }
  if (base === "makefile") {
    return "shell";
  }
  return "unknown";
}

export function categoryOf(relPath, { opaqueExtensions = [] } = {}) {
  const extension = extname(relPath).toLowerCase();
  if (opaqueExtensions.includes(extension)) {
    return "opaque";
  }
  const language = detectLanguage(relPath);
  return CATEGORIES[language] ?? (language === "unknown" ? "doc" : "config");
}

function extractSymbols(language, lines) {
  const patterns = SYMBOL_PATTERNS[language];
  if (!patterns) {
    return [];
  }
  const symbols = [];
  const seen = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > 400) {
      continue;
    }
    for (const [kind, pattern] of patterns) {
      const match = pattern.exec(line);
      if (match && match[1]) {
        const key = kind + ":" + match[1];
        if (seen.has(key) || RESERVED.has(match[1])) {
          continue;
        }
        seen.add(key);
        symbols.push({ name: match[1], kind, line: index + 1 });
        break;
      }
    }
  }
  return symbols;
}

const RESERVED = new Set(["if", "for", "while", "switch", "catch", "function", "return", "constructor", "get", "set"]);

function extractHeadings(lines) {
  const headings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = HEADING_PATTERN.exec(lines[index]);
    if (match) {
      headings.push({ text: match[2].trim(), level: match[1].length, line: index + 1 });
    }
  }
  return headings;
}

function extractImports(lines) {
  const imports = new Set();
  for (const line of lines) {
    if (line.length > 400) {
      continue;
    }
    for (const pattern of IMPORT_PATTERNS) {
      const match = pattern.exec(line);
      if (match) {
        imports.add(match[1]);
        break;
      }
    }
  }
  return [...imports];
}

function extractLinks(text) {
  const links = new Set();
  let match = LINK_PATTERN.exec(text);
  while (match) {
    const value = match[1] ?? match[2];
    if (value && !value.startsWith("http")) {
      links.add(value.split("#")[0]);
    }
    match = LINK_PATTERN.exec(text);
  }
  LINK_PATTERN.lastIndex = 0;
  return [...links];
}

function extractDataKeys(language, text, lines) {
  const keys = [];
  if (language === "json") {
    try {
      const parsed = JSON.parse(text);
      collectKeys(parsed, "", keys, 0);
    } catch {
      for (let index = 0; index < Math.min(lines.length, 400); index += 1) {
        const match = /^\s{0,2}"([A-Za-z0-9_.-]{2,40})"\s*:/.exec(lines[index]);
        if (match) {
          keys.push({ name: match[1], kind: "key", line: index + 1 });
        }
      }
    }
    return keys.slice(0, 120);
  }
  if (language === "yaml" || language === "toml" || language === "ini") {
    for (let index = 0; index < lines.length; index += 1) {
      const match = /^([A-Za-z0-9_.-]{2,40}):\s*$|^\[([A-Za-z0-9_.-]{2,40})\]/.exec(lines[index]);
      if (match) {
        keys.push({ name: match[1] ?? match[2], kind: "section", line: index + 1 });
      }
    }
    return keys.slice(0, 120);
  }
  if (language === "csv" && lines.length) {
    const header = lines[0].split(/[,;\t]/).map((cell) => cell.trim().replace(/^"|"$/g, "")).filter(Boolean);
    return header.slice(0, 40).map((name, position) => ({ name, kind: "column", line: 1, position }));
  }
  return keys;
}

function collectKeys(node, prefix, out, depth) {
  if (depth > 2 || out.length > 120 || node === null || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node.slice(0, 30)) {
      if (item && typeof item === "object" && typeof item.id === "string") {
        out.push({ name: item.id, kind: "record", line: 1, path: prefix });
      } else {
        collectKeys(item, prefix, out, depth + 1);
      }
    }
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    out.push({ name: prefix ? prefix + "." + key : key, kind: "key", line: 1 });
    collectKeys(value, prefix ? prefix + "." + key : key, out, depth + 1);
  }
}

/**
 * Domain signals turn plain documents into linkable records: a case number, an
 * invoice, an IBAN or a fiscal period found in two files links those files in
 * the map graph exactly the way an import links two source files.
 */
export function extractSignals(text, signalDefinitions, { maxPerSignal = 6 } = {}) {
  const found = [];
  const normalized = normalizeText(text);
  for (const definition of signalDefinitions) {
    let pattern = null;
    try {
      pattern = new RegExp(definition.pattern, "gu");
    } catch {
      continue;
    }
    let match = pattern.exec(normalized);
    let count = 0;
    while (match && count < maxPerSignal) {
      const value = (match[1] ?? match[0]).trim().slice(0, 80);
      if (value) {
        found.push({
          type: definition.id,
          label: definition.label,
          labelFa: definition.labelFa,
          value,
          weight: definition.weight ?? 1,
          linking: Boolean(definition.linking),
          offset: match.index
        });
        count += 1;
      }
      if (pattern.lastIndex === match.index) {
        pattern.lastIndex += 1;
      }
      match = pattern.exec(normalized);
    }
  }
  return dedupeSignals(found);
}

function dedupeSignals(signals) {
  const seen = new Set();
  const out = [];
  for (const signal of signals) {
    const key = signal.type + "=" + signal.value;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(signal);
  }
  return out;
}

export function extractFile({ relPath, text, language, category, signalDefinitions = [], maxScanLines = 4000 }) {
  const lines = text.split(/\r?\n/).slice(0, maxScanLines);
  const result = {
    symbols: [],
    headings: [],
    imports: [],
    links: [],
    signals: extractSignals(text.slice(0, 400000), signalDefinitions),
    lines: lines.length
  };
  if (category === "code") {
    result.symbols = extractSymbols(language, lines).slice(0, 200);
    result.imports = extractImports(lines).slice(0, 80);
  }
  if (category === "doc") {
    result.headings = extractHeadings(lines).slice(0, 120);
    result.links = extractLinks(text.slice(0, 200000)).slice(0, 80);
  }
  if (category === "data" || category === "config") {
    result.symbols = extractDataKeys(language, text, lines);
  }
  return result;
}

export { LANGUAGES, CATEGORIES };
