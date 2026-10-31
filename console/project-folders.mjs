import { existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { ProjectsHub } from "./projects.mjs";

/**
 * Every project Claude Code has worked in: one folder per project under
 * `<claudeHome>/projects`, with the real working directory read from the
 * transcripts' `cwd` field. This uses the Projects hub's own folder grouping
 * and cwd reading, so the two lists can never disagree.
 *
 * Returns `[{ id, path, name }]` for the projects whose folder still exists on
 * disk, sorted by name. `cache` (a Map) remembers the cwd per project.
 */
export function discoverProjectFolders(claudeHome, cache = new Map()) {
  const lite = { projectsRoot: join(resolve(claudeHome), "projects"), projectPaths: cache };
  const found = [];
  const seen = new Set();
  for (const [key, directories] of ProjectsHub.prototype.projectGroups.call(lite)) {
    const files = ProjectsHub.prototype.transcriptFiles.call(lite, directories);
    const path = ProjectsHub.prototype.projectPath.call(lite, key, files);
    if (!path) {
      continue;
    }
    const absolute = resolve(path);
    const lowered = absolute.toLowerCase();
    if (seen.has(lowered)) {
      continue;
    }
    try {
      if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    seen.add(lowered);
    found.push({ id: key, path: absolute, name: basename(absolute) || absolute });
  }
  return found.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.path.localeCompare(b.path));
}
