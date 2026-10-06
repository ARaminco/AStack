import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_SOURCE, canonicalCore, resolveRef, syncCanonical } from "./canonical.mjs";
import { UpgradeEngine, compareVersions, readKeepList, readVersion } from "./upgrade-engine.mjs";
import { mergeKept, refreshBase, undoMerge } from "./kept-merge.mjs";

/**
 * The update pipeline: what "update AStack" means, every time, everywhere.
 *
 *   preflight → fetch → plan → apply → setup → verify → (rollback) → record
 *
 * The new core always comes from the AStack git repository (upgrade.source,
 * by default github.com/ARaminco/AStack) through the canonical clone, at the
 * newest release tag unless a version or the main channel is asked for. Every
 * replaced file is backed up first; if verification fails the project is put
 * back exactly as it was. Each run is recorded in .astack/update-history.jsonl
 * and in the shared journal, so Claude Code and Codex both know it happened.
 */

export const STAGES = ["preflight", "fetch", "plan", "apply", "merge", "setup", "verify", "record"];
const LOCK_STALE_MS = 30 * 60 * 1000;
const SETUP_FLAGS = ["no-graphify", "no-trust-codex", "no-global-skill", "no-hooks", "no-index"];
// Files and directories the setup stage writes outside the managed core. They
// are snapshotted before setup so a rollback restores the project exactly.
export const WIRING = ["AGENTS.md", "CLAUDE.md", ".mcp.json", ".claude/settings.json", ".codex/config.toml", ".codex/hooks.json", ".gitignore", "graphify-out"];

function readConfigValue(root, section, key) {
  const path = join(root, "astack.config.yaml");
  if (!existsSync(path)) {
    return null;
  }
  let inSection = false;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inSection = line.startsWith(section + ":");
      continue;
    }
    const match = inSection && new RegExp("^\\s+" + key + ":\\s*(.+?)\\s*$").exec(line);
    if (match) {
      return match[1].replace(/^["']|["']$/g, "");
    }
  }
  return null;
}

/** The CHANGELOG headings between two versions, newest first. */
export function changelogBetween(text, from, to) {
  const entries = [];
  for (const match of String(text).matchAll(/^## (\d+\.\d+\.\d+)(?:\s+—\s+(.*))?$/gm)) {
    if (compareVersions(match[1], from) > 0 && compareVersions(match[1], to) <= 0) {
      entries.push({ version: match[1], title: (match[2] ?? "").trim() });
    }
  }
  return entries;
}

/** owner/repo of a git URL, so https and ssh forms of one repository compare equal. */
export function repositoryId(url) {
  const match = /([^/:]+)\/([^/:]+?)(?:\.git)?\/?$/.exec(String(url ?? "").trim());
  return match ? (match[1] + "/" + match[2]).toLowerCase() : null;
}

function node(script, args, cwd, { capture = false } = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: process.env
  });
  return { ok: result.status === 0, output: ((result.stdout ?? "") + (result.stderr ?? "")).trim() };
}

export class UpdatePipeline {
  constructor({ target, source = null, version = null, channel = null, flags = {}, clock, log = () => {}, hooks = {} } = {}) {
    this.target = resolve(target);
    this.source = source ?? process.env.ASTACK_SOURCE ?? readConfigValue(this.target, "upgrade", "source") ?? DEFAULT_SOURCE;
    this.version = version;
    this.channel = channel ?? readConfigValue(this.target, "upgrade", "channel") ?? "stable";
    this.flags = flags;
    this.clock = clock ?? (() => new Date());
    this.log = log;
    // Test seams: replace the subprocess steps without touching the logic.
    this.hooks = hooks;
    this.stages = [];
    this.lockPath = join(this.target, ".astack", "update.lock");
    this.historyPath = join(this.target, ".astack", "update-history.jsonl");
  }

  stage(name, ok, detail) {
    const entry = { stage: name, ok, detail };
    this.stages.push(entry);
    this.log(entry);
    return entry;
  }

  acquireLock() {
    mkdirSync(dirname(this.lockPath), { recursive: true });
    if (existsSync(this.lockPath)) {
      const age = Date.now() - statSync(this.lockPath).mtimeMs;
      if (age < LOCK_STALE_MS) {
        throw new Error("another update is running (" + this.lockPath + "); remove it if that update died");
      }
    }
    writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, at: this.clock().toISOString() }) + "\n", "utf8");
  }

  releaseLock() {
    if (existsSync(this.lockPath)) {
      unlinkSync(this.lockPath);
    }
  }

  dirtyManagedFiles(managed) {
    const result = spawnSync("git", ["status", "--porcelain"], { cwd: this.target, encoding: "utf8", windowsHide: true });
    if (result.status !== 0) {
      return null;
    }
    return result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3).trim().replace(/^"|"$/g, ""))
      .filter((path) => managed.some((entry) => path === entry || path.startsWith(entry + "/")));
  }

  /**
   * Put the project back as the backup found it: replaced files restored,
   * added and seeded files removed, the configuration restored. Data
   * migrations are not reversed; they are additive by design.
   */
  rollback(backupDir) {
    const reportPath = join(backupDir, "upgrade-report.json");
    if (!existsSync(reportPath)) {
      throw new Error("no upgrade report in " + backupDir);
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    let restored = 0;
    let removed = 0;
    for (const change of report.changes ?? []) {
      const targetPath = join(this.target, change.path);
      if (change.action === "update") {
        const saved = join(backupDir, change.path);
        if (existsSync(saved)) {
          mkdirSync(dirname(targetPath), { recursive: true });
          cpSync(saved, targetPath, { recursive: true });
          restored += 1;
        }
      } else if (change.action === "add" || change.action === "seed") {
        if (existsSync(targetPath)) {
          rmSync(targetPath, { recursive: true, force: true });
          removed += 1;
          // Directories the update created go too, so the tree matches the backup.
          let parent = dirname(targetPath);
          while (parent.startsWith(this.target) && parent !== this.target && existsSync(parent) && readdirSync(parent).length === 0) {
            rmSync(parent, { recursive: true, force: true });
            parent = dirname(parent);
          }
        }
      }
    }
    restored += undoMerge({ target: this.target, backupDir });
    restored += this.restoreWiring(backupDir);
    if (existsSync(join(backupDir, "astack.config.yaml"))) {
      cpSync(join(backupDir, "astack.config.yaml"), join(this.target, "astack.config.yaml"));
      restored += 1;
    }
    return { restored, removed, version: readVersion(this.target) };
  }

  snapshotWiring(backupDir) {
    const state = {};
    for (const path of WIRING) {
      const source = join(this.target, path);
      state[path] = existsSync(source);
      if (state[path] && path !== "graphify-out") {
        const copy = join(backupDir, ".wiring", path);
        mkdirSync(dirname(copy), { recursive: true });
        cpSync(source, copy);
      }
    }
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, "wiring.json"), JSON.stringify(state, null, 2) + "\n", "utf8");
    return state;
  }

  restoreWiring(backupDir) {
    const statePath = join(backupDir, "wiring.json");
    if (!existsSync(statePath)) {
      return 0;
    }
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    let changed = 0;
    for (const [path, existed] of Object.entries(state)) {
      const target = join(this.target, path);
      if (existed) {
        const copy = join(backupDir, ".wiring", path);
        if (existsSync(copy)) {
          cpSync(copy, target);
          changed += 1;
        }
      } else if (existsSync(target)) {
        rmSync(target, { recursive: true, force: true });
        changed += 1;
        const parent = dirname(target);
        if (parent !== this.target && existsSync(parent) && readdirSync(parent).length === 0) {
          rmSync(parent, { recursive: true, force: true });
        }
      }
    }
    return changed;
  }

  history({ limit = 20 } = {}) {
    if (!existsSync(this.historyPath)) {
      return [];
    }
    return readFileSync(this.historyPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .slice(-limit)
      .reverse();
  }

  record(entry) {
    const record = { at: this.clock().toISOString(), target: this.target, source: this.source, ...entry };
    mkdirSync(dirname(this.historyPath), { recursive: true });
    appendFileSync(this.historyPath, JSON.stringify(record) + "\n", "utf8");
    // The shared journal is what the next Claude Code or Codex session reads first.
    const journal = join(this.target, ".astack", "interop", "journal.jsonl");
    mkdirSync(dirname(journal), { recursive: true });
    appendFileSync(
      journal,
      JSON.stringify({ at: record.at, kind: "update", runtime: process.env.ASTACK_RUNTIME || "cli", from: entry.from, to: entry.to, ref: entry.ref, result: entry.result }) + "\n",
      "utf8"
    );
    return record;
  }

  setupArgs() {
    const args = ["setup", "--stage", "local"];
    for (const flag of SETUP_FLAGS) {
      const camel = flag.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
      if (this.flags[flag] || this.flags[camel]) {
        args.push("--" + flag);
      }
    }
    return args;
  }

  runSetup() {
    if (this.hooks.setup) {
      return this.hooks.setup(this);
    }
    return node(join(this.target, "bin", "astack.mjs"), this.setupArgs(), this.target);
  }

  runVerify() {
    if (this.hooks.verify) {
      return this.hooks.verify(this);
    }
    const bin = join(this.target, "bin", "astack.mjs");
    const doctor = node(bin, ["doctor"], this.target, { capture: true });
    if (!doctor.ok) {
      return { ok: false, detail: "doctor: " + doctor.output.split(/\r?\n/).slice(-1)[0] };
    }
    const parity = node(bin, ["interop", "doctor"], this.target, { capture: true });
    if (!parity.ok) {
      return { ok: false, detail: "interop: " + parity.output.split(/\r?\n/).slice(-1)[0] };
    }
    if (this.flags.test) {
      const suites = readdirSync(join(this.target, "tests")).filter((name) => /^verify-.*\.mjs$/.test(name) && !name.includes("browser"));
      for (const suite of suites) {
        const result = node(join(this.target, "tests", suite), [], this.target, { capture: true });
        if (!result.ok) {
          return { ok: false, detail: suite + ": " + result.output.split(/\r?\n/).slice(-3).join(" ") };
        }
      }
      return { ok: true, detail: "doctor, parity and " + suites.length + " test suites passed" };
    }
    return { ok: true, detail: "doctor and Claude Code/Codex parity passed" };
  }

  run() {
    const check = Boolean(this.flags.check);
    const from = readVersion(this.target);
    let to = from;
    let ref = null;
    let backupDir = null;

    // preflight
    if (!existsSync(join(this.target, "astack.config.yaml")) && !existsSync(join(this.target, "core", "manifest.json"))) {
      this.stage("preflight", false, "no AStack install in " + this.target + "; install it with: astack setup --target " + this.target);
      return this.finish({ ok: false, from, to });
    }
    const [major] = process.versions.node.split(".").map(Number);
    if (major < 20) {
      this.stage("preflight", false, "Node " + process.versions.node + " is too old; AStack needs Node 20+");
      return this.finish({ ok: false, from, to });
    }
    const origin = spawnSync("git", ["remote", "get-url", "origin"], { cwd: this.target, encoding: "utf8", windowsHide: true });
    if (origin.status === 0 && !existsSync(this.source) && repositoryId(origin.stdout) === repositoryId(this.source) && !this.flags.force) {
      // Copying release files over the repository they come from would
      // overwrite work in progress; the source repository updates with git.
      this.stage("preflight", false, "this is the AStack source repository itself; update it with git pull, not the pipeline");
      return this.finish({ ok: false, from, to, sourceRepository: true });
    }
    try {
      this.acquireLock();
    } catch (error) {
      this.stage("preflight", false, error.message);
      return this.finish({ ok: false, from, to, locked: true });
    }
    try {
      // fetch
      let sourceDir;
      try {
        ref = this.hooks.ref ?? (existsSync(this.source) ? "local" : resolveRef({ source: this.source, version: this.version, channel: this.channel }));
        const synced = this.hooks.fetch ? this.hooks.fetch(this, ref) : syncCanonical({ source: this.source, ref, dir: canonicalCore() });
        sourceDir = synced.dir;
        this.stage("fetch", true, this.source + " @ " + ref + (synced.commit ? " (" + synced.commit + ")" : ""));
      } catch (error) {
        this.stage("fetch", false, String(error.stderr ?? error.message).trim().split(/\r?\n/).slice(-1)[0]);
        return this.finish({ ok: false, from, to, ref });
      }

      // plan
      const keep = this.flags.keep ? String(this.flags.keep).split(",").map((entry) => entry.trim()).filter(Boolean) : [];
      const engine = new UpgradeEngine(this.target, { sourceDir, keep });
      const plan = engine.plan();
      to = plan.sourceVersion;
      if (compareVersions(plan.sourceVersion, plan.currentVersion) < 0 && !this.flags.force) {
        this.stage("plan", false, "source " + plan.sourceVersion + " is older than installed " + plan.currentVersion + "; pass --force to downgrade");
        return this.finish({ ok: false, from, to, ref });
      }
      const changelog = existsSync(join(sourceDir, "CHANGELOG.md"))
        ? changelogBetween(readFileSync(join(sourceDir, "CHANGELOG.md"), "utf8"), plan.currentVersion, plan.sourceVersion)
        : [];
      const managed = engine.manifest.managed ?? [];
      const dirty = this.dirtyManagedFiles(managed) ?? [];
      this.stage(
        "plan",
        true,
        plan.currentVersion + " → " + plan.sourceVersion + ": " + plan.counts.add + " add, " + plan.counts.update + " update, " + plan.counts.seed + " seed" +
          (plan.newConfigSections.length ? ", config +" + plan.newConfigSections.join("+") : "") +
          (changelog.length ? " | " + changelog.map((entry) => entry.version + (entry.title ? " " + entry.title : "")).join("; ") : "") +
          (dirty.length ? " | uncommitted changes in " + dirty.length + " managed file(s) will be backed up and replaced" : "")
      );
      if (check) {
        return this.finish({ ok: true, from, to, ref, check: true, changelog });
      }

      // apply
      if (plan.upToDate) {
        this.stage("apply", true, "already at " + plan.sourceVersion + "; nothing to replace");
      } else {
        const result = engine.apply({ force: Boolean(this.flags.force) });
        backupDir = result.backupDir;
        this.stage("apply", true, result.appliedCount + " file(s) written, backup " + backupDir);
      }

      // merge: the owner's protected paths, three ways against the last base
      // Seed files (the config, CLAUDE.md, README) and preserved owner data are
      // never merged: the config gains new sections on apply, the rest is the owner's.
      const unmergeable = [...(engine.manifest.seed ?? []), ...(engine.manifest.preserve ?? [])];
      const ownerKeep = [...new Set([...readKeepList(this.target), ...keep])]
        .map((entry) => String(entry).replace(/[/\\]+$/, ""))
        .filter((entry) => !entry.includes("*") && !unmergeable.some((path) => entry === path || entry.startsWith(path + "/")));
      if (backupDir && ownerKeep.length) {
        const merged = mergeKept({ target: this.target, sourceDir, keep: ownerKeep, required: engine.manifest.required ?? [], backupDir });
        this.stage(
          "merge",
          true,
          ownerKeep.length + " protected path(s): " + merged.merged + " merged, " + merged.updated + " taken from upstream, " + merged.added + " added, " + merged.deleted + " removed, " + merged.kept + " kept as owned" +
            (merged.hasBase ? "" : " (no merge base yet: owner files kept, required files added)") +
            (merged.conflicts.length ? " | needs a manual merge: " + merged.conflicts.join("; ") : "")
        );
      }

      // setup (migrations, contract, wiring, Graphify, index) with the new code
      if (backupDir) {
        this.snapshotWiring(backupDir);
      }
      const setup = this.runSetup();
      this.stage("setup", setup.ok, setup.ok ? "migrations, contract, Claude Code/Codex wiring, code graph and index refreshed" : "setup failed: " + (setup.output ?? "").split(/\r?\n/).slice(-1)[0]);

      // verify, and roll back on failure
      const verify = this.flags.noVerify ? { ok: true, detail: "skipped (--no-verify)" } : this.runVerify();
      this.stage("verify", verify.ok && setup.ok, verify.detail);
      if ((!verify.ok || !setup.ok) && backupDir && !this.flags.noRollback) {
        const restored = this.rollback(backupDir);
        this.stage("rollback", true, "restored " + restored.restored + ", removed " + restored.removed + "; back on " + restored.version);
        this.record({ from, to, ref, result: "rolled-back", backup: backupDir, reason: verify.ok ? "setup failed" : verify.detail });
        return this.finish({ ok: false, from, to, ref, rolledBack: true, backup: backupDir });
      }

      // record
      const outcome = verify.ok && setup.ok ? (plan.upToDate ? "current" : "updated") : "failed";
      if (outcome === "updated" && ownerKeep.length) {
        // This release is now the base the next update merges against.
        refreshBase({ target: this.target, sourceDir, keep: ownerKeep });
      }
      this.record({ from, to, ref, result: outcome, backup: backupDir });
      this.stage("record", true, ".astack/update-history.jsonl and the shared journal");
      return this.finish({ ok: outcome !== "failed", from, to, ref, backup: backupDir, changelog, result: outcome });
    } finally {
      this.releaseLock();
    }
  }

  finish(result) {
    return { ...result, target: this.target, source: this.source, stages: this.stages };
  }
}
