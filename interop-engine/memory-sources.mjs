import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { redactSecrets } from "../lib/text.mjs";

/**
 * Markdown memory written before the structured store existed — the install's
 * own memory/ scopes and any project memory folder named in
 * memory.import_paths — imported into the shared facets, so Claude Code and
 * Codex recall it like anything else.
 *
 * One record per markdown section, with the file and heading as provenance.
 * Re-running is cheap and exact: an unchanged file is skipped, a changed
 * section supersedes its record (history kept), a removed section is retired,
 * a new one is added. Files that look like they hold credentials are never
 * read, AStack's own stock template files are skipped, and every body passes
 * through secret redaction.
 */

// Content of the template memory files AStack shipped in any release. They
// describe AStack itself, not the owner, so they are not imported.
const STOCK_MEMORY = new Set([
  "e923d5510ee4d229", "f9c8ab7adcf6d7a2", "0a0dce63cc013e51", "059221605cefa8bf", "658f4dbe7a570d72",
  "82f44e6fde77651e", "1b31e77ab733367d", "5293cd0f874a4015", "657d9a43782d8308", "9a8a415fbb125db8",
  "dd77db45b76be973", "6e6326785ba43e7d", "9243d4e9b27fb36c", "d239a6ed175adcf3", "5ac50f27361d62f5",
  "7f3f56597f5bd14f", "33486048fd1f2830", "51380aed96e562c6", "fcea50950fcd5244"
]);
const SECRET_NAME = /(credential|secret|password|passwd|token|api[-_]?key|\.env)/i;
const MAX_BODY = 2400;

function digest(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/** Which facet a memory file belongs to, from its path. */
export function facetForPath(path) {
  const value = path.toLowerCase();
  if (/(client|counterpart|people|person|contact|entit|compan)/.test(value)) return "entity";
  if (/decision/.test(value)) return "decision";
  if (/(preference|house-rules|style)/.test(value)) return "preference";
  if (/(case-log|worklog|journal|history|episod|log\.md)/.test(value)) return "episodic";
  if (/(precedent|authorit|procedure|playbook|checklist|how-to|runbook)/.test(value)) return "procedural";
  if (/(project|case|matter|register|expiry)/.test(value)) return "project";
  if (/lesson/.test(value)) return "lesson";
  return "semantic";
}

/** Split markdown into sections at headings; text before the first heading is its own section. */
export function sections(text) {
  const result = [];
  let heading = null;
  let lines = [];
  const flush = () => {
    const body = lines.join("\n").trim();
    if (heading || body) {
      result.push({ heading, body });
    }
  };
  for (const line of text.split("\n")) {
    const match = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) {
      flush();
      heading = match[2];
      lines = [];
    } else {
      lines.push(line);
    }
  }
  flush();
  return result;
}

function walk(directory) {
  if (!existsSync(directory)) {
    return [];
  }
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
        files.push(...walk(path));
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(path);
    }
  }
  return files.sort();
}

export function importLegacyMemory({ memory, workspaceRoot, paths = ["memory"], exclude = [], clock } = {}) {
  const now = () => (clock ?? (() => new Date()))().toISOString();
  const statePath = join(workspaceRoot, ".astack", "interop", "legacy-memory.json");
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { files: {} };
  const report = { files: 0, sections: 0, added: 0, updated: 0, retired: 0, unchanged: 0, skippedStock: 0, skippedSecret: 0, skippedExcluded: 0 };
  const seen = new Set();
  for (const configured of paths) {
    const base = resolve(workspaceRoot, configured);
    for (const file of walk(base)) {
      const key = relative(workspaceRoot, file).split("\\").join("/");
      const name = file.split(/[\\/]/).pop();
      if (exclude.some((pattern) => key === pattern || name === pattern || key.endsWith("/" + pattern))) {
        report.skippedExcluded += 1;
        continue;
      }
      if (SECRET_NAME.test(name)) {
        report.skippedSecret += 1;
        continue;
      }
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
      if (STOCK_MEMORY.has(digest(text.trim()))) {
        report.skippedStock += 1;
        continue;
      }
      report.files += 1;
      const fileDigest = digest(text);
      const previous = state.files[key];
      if (previous?.digest === fileDigest) {
        report.unchanged += 1;
        report.sections += Object.keys(previous.sections ?? {}).length;
        continue;
      }
      const facet = facetForPath(key);
      const known = { ...(previous?.sections ?? {}) };
      const next = {};
      const parts = sections(text);
      const counts = new Map();
      for (const part of parts) {
        const label = part.heading ?? "(top)";
        const index = (counts.get(label) ?? 0) + 1;
        counts.set(label, index);
        const chunks = [];
        for (let offset = 0; offset < Math.max(part.body.length, 1); offset += MAX_BODY) {
          chunks.push(part.body.slice(offset, offset + MAX_BODY));
        }
        chunks.forEach((chunk, chunkIndex) => {
          const sectionKey = label + (index > 1 ? " #" + index : "") + (chunks.length > 1 ? " (" + (chunkIndex + 1) + "/" + chunks.length + ")" : "");
          const body = redactSecrets(chunk.trim());
          const title = redactSecrets(key + " › " + sectionKey);
          if (!body && !part.heading) {
            return;
          }
          report.sections += 1;
          const sectionDigest = digest(title + "\n" + body);
          const prior = known[sectionKey];
          delete known[sectionKey];
          const entry = {
            title,
            body: body || "(heading only)",
            tags: ["legacy-memory", key.split("/")[0]],
            refs: ["file:" + key + "#" + sectionKey],
            source: "legacy-memory",
            importance: /firm|global|house|preference/i.test(key) ? 0.7 : 0.55,
            meta: { file: key, section: sectionKey }
          };
          if (prior && prior.digest === sectionDigest && memory.facets.get(prior.id) && !memory.facets.get(prior.id).supersededBy) {
            next[sectionKey] = prior;
            return;
          }
          let record;
          const current = prior ? memory.facets.get(prior.id) : null;
          if (current && !current.deleted && !current.supersededBy) {
            record = memory.facets.supersede(prior.id, entry).replacement;
            report.updated += 1;
          } else {
            record = memory.remember(facet, entry);
            report.added += 1;
          }
          next[sectionKey] = { id: record.id, digest: sectionDigest };
        });
      }
      for (const stale of Object.values(known)) {
        const record = memory.facets.get(stale.id);
        if (record && !record.deleted) {
          memory.facets.forget(stale.id);
          report.retired += 1;
        }
      }
      state.files[key] = { digest: fileDigest, at: now(), sections: next };
    }
  }
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  return report;
}
