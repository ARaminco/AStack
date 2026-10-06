import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { REPOSITORY_FURNITURE, UpgradeEngine, compareVersions, installRecordPath } from "../upgrade-engine/upgrade-engine.mjs";
import { runMigrations } from "../upgrade-engine/migrations.mjs";
import { userHome } from "../upgrade-engine/canonical.mjs";

export { canonicalCore, userHome } from "../upgrade-engine/canonical.mjs";

/**
 * One command for "install and set up", in a new project or an old one.
 *
 * Stage "core" puts the right core in place: a fresh install into an empty
 * directory, an embed into an existing project (without dropping AStack's own
 * CI, Dockerfile, README or package.json into it), or an upgrade of any older
 * core. Stage "local" then runs inside the target with the new code, in a new
 * process, and does everything else: data migrations, the shared contract and
 * runtime wiring for Claude Code and Codex, Codex trust, Graphify, the context
 * index and the global astack-setup skill. Every step is idempotent and a
 * failing optional step is reported without stopping the others.
 */

export const FILL_ON_INSTALL = ["knowledge-packs", "plugins"];
const ESSENTIAL_IGNORES = [".astack/cache/", ".astack/backups/", ".astack/interop/", "graphify-out/"];

export function isInstall(dir) {
  return existsSync(join(dir, "astack.config.yaml")) || existsSync(join(dir, "core", "manifest.json"));
}

function isEmptyProject(dir) {
  return !existsSync(dir) || readdirSync(dir).every((name) => name === ".git");
}

function isGitRepo(dir) {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, stdio: "pipe", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** Install or upgrade the core in `target` from the core at `sourceDir`. */
export function installCore({ sourceDir, target }) {
  mkdirSync(target, { recursive: true });
  const fresh = !isInstall(target);
  const embedded = fresh && !isEmptyProject(target);
  const engine = new UpgradeEngine(target, {
    sourceDir,
    skipSeeds: embedded ? REPOSITORY_FURNITURE : [],
    fillPreserved: fresh ? FILL_ON_INSTALL : []
  });
  const plan = engine.plan();
  if (!fresh && compareVersions(plan.sourceVersion, plan.currentVersion) < 0) {
    return { action: "newer", from: plan.currentVersion, to: plan.sourceVersion, files: 0 };
  }
  if (plan.upToDate) {
    return { action: "current", from: plan.currentVersion, to: plan.sourceVersion, files: 0 };
  }
  const result = engine.apply();
  if (fresh) {
    // Later upgrades read this to keep treating the project as embedded.
    mkdirSync(dirname(installRecordPath(target)), { recursive: true });
    const record = { mode: embedded ? "embedded" : "standalone", installedAt: new Date().toISOString(), version: plan.sourceVersion };
    writeFileSync(installRecordPath(target), JSON.stringify(record, null, 2) + "\n", "utf8");
  }
  return {
    action: fresh ? (embedded ? "embedded" : "installed") : "upgraded",
    from: fresh ? null : plan.currentVersion,
    to: plan.sourceVersion,
    files: result.appliedCount ?? 0,
    configSections: result.configSectionsAdded ?? [],
    backup: fresh ? null : result.backupDir
  };
}

function ensureIgnores(target) {
  const path = join(target, ".gitignore");
  if (!existsSync(path)) {
    return [];
  }
  const current = readFileSync(path, "utf8");
  const missing = ESSENTIAL_IGNORES.filter((rule) => !current.includes(rule));
  if (missing.length) {
    writeFileSync(path, current.replace(/\s*$/, "\n") + missing.join("\n") + "\n", "utf8");
  }
  return missing;
}

/** The global skill that makes "install / set up" work in any project, in both runtimes. */
export function installGlobalSkill(coreRoot, home) {
  const source = join(coreRoot, "installer", "skills", "astack-setup", "SKILL.md");
  if (!existsSync(source)) {
    return [];
  }
  const content = readFileSync(source, "utf8");
  const written = [];
  for (const base of [join(home, ".claude", "skills"), join(home, ".agents", "skills")]) {
    const path = join(base, "astack-setup", "SKILL.md");
    if (existsSync(path) && readFileSync(path, "utf8") === content) {
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    written.push(path);
  }
  return written;
}

const passThrough = ["no-graphify", "no-trust-codex", "no-global-skill", "no-hooks", "no-index"];

/**
 * Stage "core". Returns the result and whether the local stage must run in a
 * fresh process because the code on disk changed under this one.
 */
export function setupCore({ coreRoot, flags }) {
  const target = resolve(String(flags.target ?? coreRoot));
  if (target !== resolve(coreRoot)) {
    return { target, core: installCore({ sourceDir: coreRoot, target }), respawn: true };
  }
  return { target, core: null, respawn: false };
}

export function respawnLocal(target, flags) {
  const args = [join(target, "bin", "astack.mjs"), "setup", "--stage", "local"];
  for (const flag of passThrough) {
    const camel = flag.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    if (flags[flag] || flags[camel]) {
      args.push("--" + flag);
    }
  }
  const result = spawnSync(process.execPath, args, { cwd: target, stdio: "inherit", windowsHide: true, env: process.env });
  return result.status ?? 1;
}

/**
 * Stage "local": everything that runs inside the target with its own code.
 * Returns one entry per step: { step, ok, detail, optional }.
 */
export function setupLocal({ runtime, flags, home = userHome() }) {
  const target = runtime.workspaceRoot;
  const steps = [];
  const step = (name, optional, action) => {
    try {
      const detail = action();
      if (detail !== undefined) {
        steps.push({ step: name, ok: true, detail: detail ?? "", optional });
      }
    } catch (error) {
      steps.push({ step: name, ok: false, detail: String(error.message ?? error).split(/\r?\n/)[0], optional });
    }
  };
  const has = (flag) => Boolean(flags[flag] || flags[flag.replace(/-([a-z])/g, (_, character) => character.toUpperCase())]);

  step("migrations", false, () => {
    const results = runMigrations(target);
    const failed = results.filter((entry) => entry.status === "failed");
    if (failed.length) {
      throw new Error(failed.map((entry) => entry.id + ": " + entry.detail).join("; "));
    }
    const applied = results.filter((entry) => entry.status === "applied");
    return applied.length ? applied.map((entry) => entry.id).join(", ") : "up to date";
  });
  step("gitignore", true, () => {
    const added = ensureIgnores(target);
    return added.length ? "added " + added.join(" ") : "up to date";
  });
  step("interop", false, () => {
    runtime.interop.home = home;
    const changed = runtime.interop.sync().filter((entry) => entry.action !== "ok");
    const invalid = changed.filter((entry) => entry.action === "invalid");
    if (invalid.length) {
      throw new Error("malformed, left untouched: " + invalid.map((entry) => entry.path).join(", "));
    }
    return changed.length ? changed.map((entry) => entry.path + " " + entry.action).join(", ") : "in parity";
  });
  step("memory-import", false, () => {
    const legacy = runtime.interop.importLegacy();
    const claude = runtime.interop.importClaudeMemory();
    return (legacy ? legacy.files + " memory files, " + legacy.sections + " sections (" + legacy.added + " new, " + legacy.updated + " updated)" : "no legacy memory") +
      (claude.directory ? "; Claude Code auto-memory " + (claude.imported + claude.updated + claude.unchanged) + " facts" : "");
  });
  if (!has("no-trust-codex")) {
    step("codex-trust", true, () => {
      if (!existsSync(join(home, ".codex"))) {
        return "Codex not installed for this user";
      }
      const trust = runtime.interop.trustCodex();
      return trust.changed ? "trusted " + trust.key : "already trusted";
    });
  }
  const graphifyConfig = runtime.configuration.section("graphify", {});
  if (!has("no-graphify") && graphifyConfig.enabled !== false) {
    step("graphify", true, () => {
      const result = runtime.graphify.setup({ hooks: !has("no-hooks") && graphifyConfig.git_hooks !== false && isGitRepo(target), build: true });
      if (!result.ok) {
        throw new Error(result.steps.filter((entry) => !entry.ok && !entry.fallback).map((entry) => entry.step + ": " + entry.detail).join("; ") || "install failed");
      }
      const graph = runtime.graphify.graph();
      return "graphify " + result.version + (graph.built ? ", " + graph.nodes + " nodes" : "");
    });
  }
  if (!has("no-index")) {
    step("context-index", true, () => {
      const index = runtime.context.build();
      return (index.stats?.files ?? "?") + " files indexed";
    });
  }
  if (!has("no-global-skill")) {
    step("global-skill", true, () => {
      const written = installGlobalSkill(runtime.root, home);
      return written.length ? "installed for Claude Code and Codex" : "up to date";
    });
  }
  const status = runtime.interop.status();
  return { target, steps, parity: status.parity, ok: steps.every((entry) => entry.ok || entry.optional) };
}
