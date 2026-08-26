import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Configuration access.
 *
 * `astack.config.yaml` uses a small, predictable subset of YAML: nested maps,
 * lists of scalars and lists of maps. Parsing that subset here keeps AStack
 * dependency free while giving every engine typed access to its settings
 * instead of string matching the file.
 */
export class ConfigurationEngine {
  constructor(root) {
    this.root = root;
    this.path = join(root, "astack.config.yaml");
    this.cache = null;
    this.cacheRaw = null;
  }

  readText() {
    if (!existsSync(this.path)) {
      throw new Error("astack.config.yaml is missing");
    }
    return readFileSync(this.path, "utf8");
  }

  requireSections(sections) {
    const text = this.readText();
    const missing = sections.filter((section) => !text.includes(section + ":"));
    return { ok: missing.length === 0, missing };
  }

  read() {
    const text = this.readText();
    if (this.cacheRaw === text) {
      return this.cache;
    }
    const parsed = parseYaml(text);
    this.cache = parsed;
    this.cacheRaw = text;
    return parsed;
  }

  section(name, fallback = {}) {
    try {
      return this.read()[name] ?? fallback;
    } catch {
      return fallback;
    }
  }

  get(path, fallback = null) {
    try {
      const value = String(path)
        .split(".")
        .reduce((current, segment) => (current === null || current === undefined ? current : current[segment]), this.read());
      return value === undefined || value === null ? fallback : value;
    } catch {
      return fallback;
    }
  }
}

function parseScalar(raw) {
  const value = String(raw ?? "").trim().replace(/\s+#.*$/, "");
  if (!value.length) {
    return "";
  }
  const unquoted = value.replace(/^["'](.*)["']$/, "$1");
  if (unquoted !== value) {
    return unquoted;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (value === "null" || value === "~") {
    return null;
  }
  if (/^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  if (/^-?\d*\.\d+$/.test(value)) {
    return Number.parseFloat(value);
  }
  return value;
}

/**
 * Indentation driven parser for the YAML subset AStack uses.
 */
export function parseYaml(text) {
  const root = {};
  const stack = [{ indent: -1, node: root, key: null }];
  const lines = String(text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/.test(line)) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const content = line.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].node;
    if (content.startsWith("- ") || content === "-") {
      const item = content.slice(1).trim();
      if (!Array.isArray(parent)) {
        continue;
      }
      if (item.includes(": ")) {
        const entry = {};
        const separator = item.indexOf(":");
        entry[item.slice(0, separator).trim()] = parseScalar(item.slice(separator + 1));
        parent.push(entry);
        stack.push({ indent, node: entry, key: null });
        continue;
      }
      parent.push(parseScalar(item));
      continue;
    }
    const separator = content.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const key = content.slice(0, separator).trim();
    const rest = content.slice(separator + 1).trim();
    if (rest === "") {
      const nextMeaningful = lines.slice(index + 1).find((candidate) => candidate.trim() && !/^\s*#/.test(candidate));
      const nextIndent = nextMeaningful ? nextMeaningful.length - nextMeaningful.trimStart().length : 0;
      const isList = nextMeaningful ? nextMeaningful.trim().startsWith("-") && nextIndent > indent : false;
      const node = isList ? [] : {};
      if (Array.isArray(parent)) {
        parent.push({ [key]: node });
      } else {
        parent[key] = node;
      }
      stack.push({ indent, node, key });
      continue;
    }
    if (Array.isArray(parent)) {
      parent.push({ [key]: parseScalar(rest) });
      continue;
    }
    parent[key] = parseScalar(rest);
  }
  return root;
}
