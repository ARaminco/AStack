import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_SOURCE = "https://github.com/ARaminco/AStack.git";

export function findInstallRoot(startDir) {
  let current = startDir;
  for (let depth = 0; depth < 24; depth += 1) {
    if (existsSync(join(current, "astack.config.yaml")) || existsSync(join(current, "core", "manifest.json"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
  return null;
}

export function fetchSource(root, source) {
  if (existsSync(source) && statSync(source).isDirectory()) {
    return { dir: resolve(source), kind: "local" };
  }
  const cache = join(root, ".astack", "cache", "upstream");
  rmSync(cache, { recursive: true, force: true });
  mkdirSync(dirname(cache), { recursive: true });
  execFileSync("git", ["clone", "--depth", "1", source, cache], { stdio: "pipe" });
  return { dir: cache, kind: "git" };
}

export function readVersion(root) {
  const manifestPath = join(root, "core", "manifest.json");
  if (existsSync(manifestPath)) {
    const version = JSON.parse(readFileSync(manifestPath, "utf8")).version;
    if (version) {
      return version;
    }
  }
  const packagePath = join(root, "package.json");
  if (existsSync(packagePath)) {
    const version = JSON.parse(readFileSync(packagePath, "utf8")).version;
    if (version) {
      return version;
    }
  }
  return "0.0.0";
}

export function compareVersions(a, b) {
  const left = String(a).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b).split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) {
      return Math.sign(delta);
    }
  }
  return 0;
}

export function readKeepList(root) {
  const path = join(root, "astack.config.yaml");
  if (!existsSync(path)) {
    return [];
  }
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const keep = [];
  let inUpgrade = false;
  let inKeep = false;
  for (const line of lines) {
    if (/^\S/.test(line)) {
      inUpgrade = line.startsWith("upgrade:");
      inKeep = false;
      continue;
    }
    if (!inUpgrade) {
      continue;
    }
    if (/^\s+keep:\s*$/.test(line)) {
      inKeep = true;
      continue;
    }
    if (inKeep) {
      const match = /^\s+-\s+(.+)\s*$/.exec(line);
      if (match) {
        keep.push(match[1].trim());
      } else if (line.trim()) {
        inKeep = false;
      }
    }
  }
  return keep;
}

export function topLevelBlocks(yamlText) {
  const blocks = new Map();
  let currentKey = null;
  let current = [];
  for (const line of String(yamlText).split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):/.exec(line);
    if (match) {
      if (currentKey) {
        blocks.set(currentKey, current.join("\n"));
      }
      currentKey = match[1];
      current = [line];
    } else if (currentKey) {
      current.push(line);
    }
  }
  if (currentKey) {
    blocks.set(currentKey, current.join("\n"));
  }
  return blocks;
}

export class UpgradeEngine {
  constructor(targetRoot, { sourceDir, keep = [] } = {}) {
    if (!sourceDir) {
      throw new Error("UpgradeEngine requires a sourceDir with the new AStack version");
    }
    this.target = resolve(targetRoot);
    this.source = resolve(sourceDir);
    const manifestPath = join(this.source, "upgrade-engine", "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new Error("Upgrade manifest missing in source: " + manifestPath);
    }
    this.manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    this.keep = [...new Set([...(this.manifest.preserve ?? []), ...readKeepList(targetRoot), ...keep])];
  }

  isProtected(rel) {
    return this.keep.some((entry) => rel === entry || rel.startsWith(entry + "/"));
  }

  plan() {
    const currentVersion = readVersion(this.target);
    const sourceVersion = readVersion(this.source);
    const changes = [];
    let unchanged = 0;
    for (const entry of this.manifest.managed ?? []) {
      const sourcePath = join(this.source, entry);
      if (!existsSync(sourcePath)) {
        continue;
      }
      const explicitFile = statSync(sourcePath).isFile();
      for (const rel of listFiles(this.source, entry)) {
        if (!explicitFile && this.isProtected(rel)) {
          changes.push({ path: rel, action: "preserved" });
          continue;
        }
        const targetPath = join(this.target, rel);
        if (!existsSync(targetPath)) {
          changes.push({ path: rel, action: "add" });
        } else if (hashFile(targetPath) !== hashFile(join(this.source, rel))) {
          changes.push({ path: rel, action: "update" });
        } else {
          unchanged += 1;
        }
      }
    }
    for (const entry of this.manifest.seed ?? []) {
      if (existsSync(join(this.source, entry)) && !existsSync(join(this.target, entry))) {
        changes.push({ path: entry, action: "seed" });
      }
    }
    const pending = changes.filter((change) => change.action !== "preserved");
    const newConfigSections = this.missingConfigSections();
    return {
      currentVersion,
      sourceVersion,
      upToDate: compareVersions(sourceVersion, currentVersion) <= 0 && pending.length === 0 && newConfigSections.length === 0,
      newConfigSections,
      changes,
      counts: {
        add: changes.filter((change) => change.action === "add").length,
        update: changes.filter((change) => change.action === "update").length,
        seed: changes.filter((change) => change.action === "seed").length,
        preserved: changes.filter((change) => change.action === "preserved").length,
        unchanged
      }
    };
  }

  apply({ force = false } = {}) {
    const plan = this.plan();
    if (plan.upToDate && !force) {
      return { ...plan, applied: false, backupDir: null };
    }
    if (compareVersions(plan.sourceVersion, plan.currentVersion) < 0 && !force) {
      throw new Error("Source version " + plan.sourceVersion + " is older than installed " + plan.currentVersion + ". Use force to downgrade.");
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = join(this.target, ".astack", "backups", "upgrade-" + stamp);
    let applied = 0;
    for (const change of plan.changes) {
      const sourcePath = join(this.source, change.path);
      const targetPath = join(this.target, change.path);
      if (change.action === "update") {
        const backupPath = join(backupDir, change.path);
        mkdirSync(dirname(backupPath), { recursive: true });
        cpSync(targetPath, backupPath, { recursive: true });
      }
      if (["add", "update", "seed"].includes(change.action)) {
        mkdirSync(dirname(targetPath), { recursive: true });
        cpSync(sourcePath, targetPath, { recursive: true });
        applied += 1;
      }
    }
    const configSectionsAdded = this.mergeConfigSections(backupDir);
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(
      join(backupDir, "upgrade-report.json"),
      JSON.stringify({ at: new Date().toISOString(), from: plan.currentVersion, to: plan.sourceVersion, source: this.source, configSectionsAdded, changes: plan.changes }, null, 2) + "\n",
      "utf8"
    );
    return { ...plan, applied: applied > 0 || configSectionsAdded.length > 0, appliedCount: applied, configSectionsAdded, backupDir };
  }

  missingConfigSections() {
    const sourcePath = join(this.source, "astack.config.yaml");
    const targetPath = join(this.target, "astack.config.yaml");
    if (!existsSync(sourcePath) || !existsSync(targetPath)) {
      return [];
    }
    const sourceBlocks = topLevelBlocks(readFileSync(sourcePath, "utf8"));
    const targetBlocks = topLevelBlocks(readFileSync(targetPath, "utf8"));
    return [...sourceBlocks.keys()].filter((key) => !targetBlocks.has(key));
  }

  mergeConfigSections(backupDir) {
    const sourcePath = join(this.source, "astack.config.yaml");
    const targetPath = join(this.target, "astack.config.yaml");
    if (!existsSync(sourcePath) || !existsSync(targetPath)) {
      return [];
    }
    const sourceBlocks = topLevelBlocks(readFileSync(sourcePath, "utf8"));
    const targetText = readFileSync(targetPath, "utf8");
    const targetBlocks = topLevelBlocks(targetText);
    const added = [];
    let text = targetText.replace(/\s*$/, "\n");
    for (const [key, block] of sourceBlocks) {
      if (!targetBlocks.has(key)) {
        text += "\n" + block.replace(/\s*$/, "") + "\n";
        added.push(key);
      }
    }
    if (added.length) {
      const backupPath = join(backupDir, "astack.config.yaml");
      mkdirSync(dirname(backupPath), { recursive: true });
      cpSync(targetPath, backupPath);
      writeFileSync(targetPath, text, "utf8");
    }
    return added;
  }
}

function listFiles(root, entry) {
  const start = join(root, entry);
  const stats = statSync(start);
  if (stats.isFile()) {
    return [normalize(entry)];
  }
  const results = [];
  const stack = [start];
  while (stack.length) {
    const dir = stack.pop();
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isDirectory()) {
        stack.push(path);
      } else if (item.isFile()) {
        results.push(normalize(path.slice(root.length + 1)));
      }
    }
  }
  return results.sort();
}

function normalize(path) {
  return String(path).replace(/\\/g, "/");
}

function hashFile(path) {
  const content = readFileSync(path);
  const text = content.toString("utf8").replace(/\r\n/g, "\n");
  return createHash("sha1").update(text).digest("hex");
}
