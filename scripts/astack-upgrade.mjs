#!/usr/bin/env node
// Standalone AStack core upgrader.
//
// Works inside any project that embeds an AStack core, including versions
// that predate the upgrade engine. Copy this single file into the project
// (or fetch it raw from the AStack repository) and run:
//
//   node astack-upgrade.mjs [--from <path-or-git-url>] [--check] [--force] [--keep a,b]
//
// It locates the AStack install root, fetches the latest AStack into
// .astack/cache/upstream, and executes the fetched upgrade engine, so the
// newest upgrade logic always governs the upgrade. Requires Node >= 20 and git.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_SOURCE = "https://github.com/ARaminco/AStack.git";

function parseArgs(tokens) {
  const flags = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const equals = token.indexOf("=");
    if (equals !== -1) {
      flags[token.slice(2, equals)] = token.slice(equals + 1);
    } else if (index + 1 < tokens.length && !tokens[index + 1].startsWith("--")) {
      flags[token.slice(2)] = tokens[index + 1];
      index += 1;
    } else {
      flags[token.slice(2)] = true;
    }
  }
  return flags;
}

function findInstallRoot(startDir) {
  let current = resolve(startDir);
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

function fetchSource(root, source) {
  if (existsSync(source) && statSync(source).isDirectory()) {
    return resolve(source);
  }
  const cache = join(root, ".astack", "cache", "upstream");
  rmSync(cache, { recursive: true, force: true });
  mkdirSync(dirname(cache), { recursive: true });
  execFileSync("git", ["clone", "--depth", "1", source, cache], { stdio: "pipe" });
  return cache;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const root = findInstallRoot(process.cwd());
  if (!root) {
    console.error("astack-upgrade: no AStack install found above " + process.cwd());
    process.exitCode = 1;
    return;
  }
  const source = String(flags.from ?? process.env.ASTACK_SOURCE ?? DEFAULT_SOURCE);
  console.log("ریشه نصب AStack: " + root);
  console.log("منبع ارتقا: " + source);
  const sourceDir = fetchSource(root, source);
  const engineModule = await import(pathToFileURL(join(sourceDir, "upgrade-engine", "upgrade-engine.mjs")).href);
  const keep = flags.keep ? String(flags.keep).split(",").map((entry) => entry.trim()).filter(Boolean) : [];
  const engine = new engineModule.UpgradeEngine(root, { sourceDir, keep });
  const plan = engine.plan();
  console.log("نسخه نصب‌شده: " + plan.currentVersion + " | نسخه جدید: " + plan.sourceVersion);
  if (plan.upToDate && !flags.force) {
    console.log("هسته AStack به‌روز است؛ تغییری لازم نیست.");
    return;
  }
  console.log("تغییرات: " + plan.counts.add + " افزودن، " + plan.counts.update + " به‌روزرسانی، " + plan.counts.seed + " فایل اولیه، " + plan.counts.preserved + " محفوظ");
  if (flags.check) {
    for (const change of plan.changes.filter((entry) => entry.action !== "preserved").slice(0, 40)) {
      console.log("- " + change.action + " " + change.path);
    }
    console.log("حالت بررسی: هیچ فایلی تغییر نکرد.");
    return;
  }
  const result = engine.apply({ force: Boolean(flags.force) });
  console.log("ارتقا اعمال شد: " + result.appliedCount + " فایل. نسخه پشتیبان: " + result.backupDir);
  console.log("برای اطمینان اجرا کنید: node bin/astack.mjs doctor");
}

main().catch((error) => {
  console.error("astack-upgrade: " + error.message);
  process.exitCode = 1;
});
