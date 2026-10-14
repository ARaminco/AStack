/**
 * A tolerant parser for the YAML front matter of an agentskills.io /
 * Anthropic style SKILL.md.
 *
 * Skill files are third-party data, so this never throws and never evaluates
 * anything: it understands the small YAML subset skills actually use — nested
 * maps, inline lists `[a, b]`, block lists `- x`, quoted scalars and folded or
 * literal block scalars (`>` / `|`) — and keeps whatever else it finds as a
 * plain string.
 */
export function parseFrontMatter(text) {
  const source = String(text ?? "").replace(/^﻿/, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!match) {
    return { ok: false, data: {}, body: source, error: "no front matter" };
  }
  const body = source.slice(match[0].length);
  try {
    return { ok: true, data: parseBlock(match[1].split(/\r?\n/)), body, lines: match[1].split(/\r?\n/).length + 2 };
  } catch (error) {
    return { ok: false, data: {}, body, error: String(error?.message ?? error) };
  }
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function isBlank(line) {
  const trimmed = line.trim();
  return !trimmed || trimmed.startsWith("#");
}

function parseBlock(lines) {
  const root = {};
  // Stack of { indent, container, key? } frames.
  const stack = [{ indent: -1, container: root }];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (isBlank(raw)) {
      continue;
    }
    const indent = indentOf(raw);
    const line = raw.trim();
    const top = stack[stack.length - 1];
    const sameIndentList = (line.startsWith("- ") || line === "-") && top.indent === indent && top.parent && !Array.isArray(top.container) && !Object.keys(top.container).length;
    if (sameIndentList) {
      // `key:` followed by `- item` at the same indentation.
      top.indent = indent - 1;
    }
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const frame = stack[stack.length - 1];

    if (line.startsWith("- ") || line === "-") {
      const value = line === "-" ? "" : line.slice(2).trim();
      let list = frame.container;
      if (!Array.isArray(list)) {
        // A list under a key that was opened as an empty map.
        if (frame.parent && frame.key !== undefined) {
          list = [];
          frame.parent[frame.key] = list;
          frame.container = list;
        } else {
          continue;
        }
      }
      const pair = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(value);
      if (pair && !/^["']/.test(value)) {
        const item = {};
        item[pair[1]] = pair[2] ? scalar(pair[2]) : {};
        list.push(item);
        stack.push({ indent, container: item, parent: list, key: list.length - 1 });
      } else {
        list.push(scalar(value));
      }
      continue;
    }

    const pair = /^("[^"]*"|'[^']*'|[^:]+?):(?:\s+(.*))?$/.exec(line);
    if (!pair || Array.isArray(frame.container)) {
      continue;
    }
    const key = pair[1].replace(/^["']|["']$/g, "").trim();
    const rest = (pair[2] ?? "").trim();
    if (rest === "|" || rest === ">" || /^[|>][+-]?$/.test(rest)) {
      const collected = [];
      let next = index + 1;
      while (next < lines.length && (lines[next].trim() === "" || indentOf(lines[next]) > indent)) {
        collected.push(lines[next]);
        next += 1;
      }
      index = next - 1;
      const minimum = Math.min(...collected.filter((entry) => entry.trim()).map(indentOf), Infinity);
      const stripped = collected.map((entry) => entry.slice(Number.isFinite(minimum) ? minimum : 0));
      frame.container[key] = rest.startsWith("|")
        ? stripped.join("\n").replace(/\s+$/, "")
        : stripped.map((entry) => entry.trim()).join(" ").replace(/\s+/g, " ").trim();
      continue;
    }
    if (!rest) {
      const child = {};
      frame.container[key] = child;
      stack.push({ indent, container: child, parent: frame.container, key });
      continue;
    }
    // A plain scalar that continues on more-indented lines.
    let value = rest;
    if (!/^["'[{]/.test(rest)) {
      let next = index + 1;
      while (next < lines.length && lines[next].trim() && indentOf(lines[next]) > indent && !/^\s*-\s/.test(lines[next]) && !/^\s*[A-Za-z0-9_.-]+:(\s|$)/.test(lines[next])) {
        value += " " + lines[next].trim();
        next += 1;
      }
      index = next - 1;
    } else if (/^["']/.test(rest) && !closesQuote(rest)) {
      let next = index + 1;
      while (next < lines.length) {
        value += " " + lines[next].trim();
        next += 1;
        if (closesQuote(value)) {
          break;
        }
      }
      index = next - 1;
    }
    frame.container[key] = scalar(value);
  }
  return root;
}

function closesQuote(value) {
  const quote = value[0];
  return value.length > 1 && value.trimEnd().endsWith(quote) && !value.trimEnd().endsWith("\\" + quote);
}

function splitInline(inner) {
  const parts = [];
  let current = "";
  let quote = null;
  let depth = 0;
  for (const char of inner) {
    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "[" || char === "{") {
      depth += 1;
    } else if (char === "]" || char === "}") {
      depth -= 1;
    }
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) {
    parts.push(current);
  }
  return parts.map((part) => part.trim()).filter((part) => part.length);
}

export function scalar(raw) {
  const value = String(raw ?? "").trim().replace(/\s+#\s.*$/, "");
  if (!value) {
    return "";
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitInline(value.slice(1, -1)).map(scalar);
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    const object = {};
    for (const part of splitInline(value.slice(1, -1))) {
      const pair = /^([^:]+):\s*(.*)$/.exec(part);
      if (pair) {
        object[pair[1].trim().replace(/^["']|["']$/g, "")] = scalar(pair[2]);
      }
    }
    return object;
  }
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    return value.slice(1, -1).replace(/\\"/g, "\"").replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value === "true" || value === "false") {
    return value === "true";
  }
  if (value === "null" || value === "~") {
    return null;
  }
  if (/^-?\d+(\.\d+)?$/.test(value) && !/^0\d/.test(value)) {
    return Number(value);
  }
  return value;
}
