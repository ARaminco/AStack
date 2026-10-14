import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { sections } from "../../interop-engine/memory-sources.mjs";
import { isSecretFile, redact } from "../redact.mjs";
import { chunkText, fingerprintOf, sha, toPosix, walk } from "./util.mjs";

/**
 * Markdown documents under the configured folders (default: documentation/
 * plus memory.import_paths). One document per heading section, long sections
 * split into chunks. Credential-looking files are never opened.
 */
export const id = "reports";
// Bump when parsing changes: every unit of this source is then re-read.
export const version = 1;

const EXTENSIONS = /\.(md|markdown|txt)$/i;

export function units({ workspaceRoot, paths = [], exclude = [] }) {
  const result = [];
  const seen = new Set();
  for (const configured of paths) {
    const base = isAbsolute(configured) ? configured : resolve(workspaceRoot, configured);
    for (const path of walk(base, (name) => EXTENSIONS.test(name) && !isSecretFile(name))) {
      const rel = toPosix(relative(workspaceRoot, path));
      const key = rel.startsWith("..") || isAbsolute(rel) ? toPosix(path) : rel;
      if (seen.has(key) || exclude.some((pattern) => key === pattern || key.endsWith("/" + pattern) || key.includes("/" + pattern + "/"))) {
        continue;
      }
      seen.add(key);
      result.push({
        key,
        fingerprint: fingerprintOf(path),
        read: () => readReport(path, key)
      });
    }
  }
  return result;
}

export function readReport(path, key) {
  const text = readFileSync(path, "utf8").replace(/^\ufeff/, "").replace(/\r\n/g, "\n");
  const hash = sha(text);
  let date = null;
  try {
    date = statSync(path).mtime.toISOString();
  } catch {
    date = null;
  }
  // A date in the file name (2026-10-06-topic.md) is the report's own date.
  const named = /(\d{4}-\d{2}-\d{2})/.exec(key.split("/").pop());
  if (named) {
    date = named[1] + "T00:00:00.000Z";
  }
  const docTitle = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? key.split("/").pop();
  const docs = [];
  const counts = new Map();
  for (const part of sections(text)) {
    const label = part.heading ?? "(top)";
    const index = (counts.get(label) ?? 0) + 1;
    counts.set(label, index);
    const chunks = chunkText(part.body);
    if (!chunks.length && part.heading) {
      chunks.push(part.heading);
    }
    chunks.forEach((chunk, chunkIndex) => {
      const anchor = label + (index > 1 ? " #" + index : "") + (chunks.length > 1 ? " (" + (chunkIndex + 1) + "/" + chunks.length + ")" : "");
      docs.push({
        id: "reports:" + key + "#" + anchor,
        kind: "markdown",
        title: redact(part.heading && part.heading !== docTitle ? docTitle + " › " + part.heading : docTitle),
        path: key,
        date,
        text: redact(chunk),
        meta: { section: anchor, group: key + "#" + label + (index > 1 ? " #" + index : "") }
      });
    });
  }
  return { hash, docs };
}
