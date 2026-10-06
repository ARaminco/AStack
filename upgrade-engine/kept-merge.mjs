import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Three-way merge for the paths an owner protects with upgrade.keep.
 *
 * A protected path is a customised copy of an upstream file. Freezing it
 * forever breaks the next release that changes the engine around it, so the
 * update pipeline merges instead: against the pristine upstream copy the
 * project last received (.astack/upstream-base), the owner's version and the
 * new release. What only the owner changed stays; what only upstream changed
 * arrives; text both changed goes through git merge-file, JSON leaf by leaf.
 * A real conflict keeps the owner's version and is reported, never guessed.
 *
 * New upstream files inside a protected path arrive only when the core needs
 * them (manifest.required) or when they are code (.mjs/.js); curated content
 * such as skills, roles or knowledge packs stays curated.
 */

export const BASE_DIRECTORY = join(".astack", "upstream-base");

function read(path) {
  return existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : null;
}

function listFiles(root, entry) {
  const start = join(root, entry);
  if (!existsSync(start)) {
    return [];
  }
  if (statSync(start).isFile()) {
    return [entry];
  }
  const files = [];
  for (const item of readdirSync(start, { withFileTypes: true })) {
    const rel = entry + "/" + item.name;
    if (item.isDirectory()) {
      files.push(...listFiles(root, rel));
    } else if (item.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Leaf-level three-way merge of parsed JSON. Returns the value and the conflicting paths. */
export function mergeJson(base, ours, theirs, path = "", conflicts = []) {
  if (isObject(ours) && isObject(theirs)) {
    const out = {};
    for (const key of new Set([...Object.keys(theirs), ...Object.keys(ours)])) {
      const baseValue = isObject(base) ? base[key] : undefined;
      if (!(key in ours)) {
        // Owner removed it: stays removed unless upstream changed it since.
        if (baseValue === undefined || !same(baseValue, theirs[key])) {
          out[key] = theirs[key];
        }
        continue;
      }
      if (!(key in theirs)) {
        if (baseValue === undefined || !same(baseValue, ours[key])) {
          out[key] = ours[key];
        }
        continue;
      }
      out[key] = mergeJson(baseValue, ours[key], theirs[key], path + "/" + key, conflicts).value;
    }
    return { value: out, conflicts };
  }
  if (same(ours, theirs) || same(theirs, base)) {
    return { value: ours, conflicts };
  }
  if (same(ours, base)) {
    return { value: theirs, conflicts };
  }
  conflicts.push(path || "/");
  return { value: ours, conflicts };
}

function mergeText(ours, base, theirs, scratch) {
  mkdirSync(scratch, { recursive: true });
  const files = ["ours", "base", "theirs"].map((name) => join(scratch, name));
  writeFileSync(files[0], ours, "utf8");
  writeFileSync(files[1], base, "utf8");
  writeFileSync(files[2], theirs, "utf8");
  const result = spawnSync("git", ["merge-file", "-p", "-L", "owner", "-L", "base", "-L", "upstream", ...files], { encoding: "utf8", windowsHide: true });
  if (result.status === null || result.status < 0 || result.error) {
    return { text: ours, conflicts: 1, unavailable: true };
  }
  return { text: result.stdout, conflicts: result.status };
}

/**
 * Merge every owner-protected path from `sourceDir` into `target`. Writes are
 * backed up under backupDir/.merged and listed in backupDir/merge-report.json
 * so the pipeline's rollback can undo them.
 */
export function mergeKept({ target, sourceDir, keep, required = [], backupDir }) {
  const baseRoot = join(target, BASE_DIRECTORY);
  const hasBase = existsSync(baseRoot);
  const requiredSet = new Set(required);
  const report = { merged: 0, updated: 0, added: 0, deleted: 0, kept: 0, conflicts: [], changes: [], hasBase };
  const backup = (rel) => {
    const current = join(target, rel);
    if (existsSync(current)) {
      const copy = join(backupDir, ".merged", rel);
      mkdirSync(dirname(copy), { recursive: true });
      cpSync(current, copy);
    }
  };
  const write = (rel, text, action) => {
    backup(rel);
    mkdirSync(dirname(join(target, rel)), { recursive: true });
    writeFileSync(join(target, rel), text, "utf8");
    report.changes.push({ path: rel, action });
  };
  for (const entry of keep) {
    const files = [...new Set([...listFiles(sourceDir, entry), ...listFiles(target, entry), ...listFiles(baseRoot, entry)])].sort();
    for (const rel of files) {
      const ours = read(join(target, rel));
      const theirs = read(join(sourceDir, rel));
      const base = hasBase ? read(join(baseRoot, rel)) : null;
      if (ours === theirs || theirs === null && base === null) {
        continue;
      }
      if (ours === null && base === null) {
        // A new upstream file inside a protected path.
        if (requiredSet.has(rel) || /\.(mjs|js)$/.test(rel)) {
          write(rel, theirs, "add");
          report.added += 1;
        }
        continue;
      }
      if (!hasBase || ours === null || theirs === null && ours !== base) {
        report.kept += 1;
        continue;
      }
      if (ours === base) {
        if (theirs === null) {
          backup(rel);
          rmSync(join(target, rel), { force: true });
          report.changes.push({ path: rel, action: "delete" });
          report.deleted += 1;
        } else {
          write(rel, theirs, "update");
          report.updated += 1;
        }
        continue;
      }
      if (theirs === base) {
        report.kept += 1;
        continue;
      }
      if (rel.endsWith(".json") && base !== null) {
        try {
          const merged = mergeJson(JSON.parse(base), JSON.parse(ours), JSON.parse(theirs));
          write(rel, JSON.stringify(merged.value, null, 2) + "\n", "update");
          report.merged += 1;
          if (merged.conflicts.length) {
            report.conflicts.push(rel + " (owner kept at " + merged.conflicts.slice(0, 3).join(", ") + ")");
          }
          continue;
        } catch {
          // Not valid JSON on one side: fall through to the text merge.
        }
      }
      if (base === null) {
        report.conflicts.push(rel + " (added on both sides; owner kept)");
        continue;
      }
      const merged = mergeText(ours, base, theirs, join(backupDir, ".merge-scratch"));
      if (merged.conflicts === 0) {
        write(rel, merged.text, "update");
        report.merged += 1;
      } else {
        report.conflicts.push(rel + (merged.unavailable ? " (git unavailable; owner kept)" : " (" + merged.conflicts + " conflicting hunk(s); owner kept)"));
      }
    }
  }
  rmSync(join(backupDir, ".merge-scratch"), { recursive: true, force: true });
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(backupDir, "merge-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  return report;
}

/** Undo what mergeKept wrote, from its report and backups. */
export function undoMerge({ target, backupDir }) {
  const reportPath = join(backupDir, "merge-report.json");
  if (!existsSync(reportPath)) {
    return 0;
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  let undone = 0;
  for (const change of report.changes ?? []) {
    const current = join(target, change.path);
    const copy = join(backupDir, ".merged", change.path);
    if (existsSync(copy)) {
      mkdirSync(dirname(current), { recursive: true });
      cpSync(copy, current);
    } else if (change.action === "add") {
      rmSync(current, { force: true });
    }
    undone += 1;
  }
  return undone;
}

/** After a verified update: the new release becomes the base for the next merge. */
export function refreshBase({ target, sourceDir, keep }) {
  const baseRoot = join(target, BASE_DIRECTORY);
  for (const entry of keep) {
    rmSync(join(baseRoot, entry), { recursive: true, force: true });
    for (const rel of listFiles(sourceDir, entry)) {
      mkdirSync(dirname(join(baseRoot, rel)), { recursive: true });
      cpSync(join(sourceDir, rel), join(baseRoot, rel));
    }
  }
  return baseRoot;
}
