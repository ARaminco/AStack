import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const MAX_CHUNK = 2400;

export function sha(text) {
  return createHash("sha1").update(String(text)).digest("hex").slice(0, 20);
}

export function fingerprintOf(path) {
  try {
    const stat = statSync(path);
    return Math.round(stat.mtimeMs) + ":" + stat.size;
  } catch {
    return null;
  }
}

export function toPosix(value) {
  return String(value).replace(/\\/g, "/");
}

/** Recursive file walk with a name filter; skips dot folders and node_modules. */
export function walk(directory, accept, { maxFiles = 20000 } = {}) {
  const files = [];
  const visit = (current) => {
    if (files.length >= maxFiles || !existsSync(current)) {
      return;
    }
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
          visit(path);
        }
      } else if (entry.isFile() && accept(entry.name, path)) {
        files.push(path);
        if (files.length >= maxFiles) {
          return;
        }
      }
    }
  };
  visit(directory);
  return files.sort();
}

/** Split long text into chunks at paragraph or line boundaries. */
export function chunkText(text, size = MAX_CHUNK) {
  const value = String(text ?? "").trim();
  if (value.length <= size) {
    return value ? [value] : [];
  }
  const chunks = [];
  let rest = value;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n\n", size);
    if (cut < size * 0.5) {
      cut = rest.lastIndexOf("\n", size);
    }
    if (cut < size * 0.5) {
      cut = rest.lastIndexOf(" ", size);
    }
    if (cut < size * 0.5) {
      cut = size;
    }
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) {
    chunks.push(rest);
  }
  return chunks;
}

export function firstLine(text, max = 120) {
  const line = String(text ?? "").split(/\r?\n/).map((entry) => entry.trim()).find(Boolean) ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}
