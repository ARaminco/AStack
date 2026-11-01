#!/usr/bin/env node
/**
 * git commit-msg hook (installed by `astack interop sync` / `astack setup`).
 * Owner order: no commit ever names Claude or another AI. Strips AI
 * co-author trailers and "Generated with" footers from the message, and
 * refuses a commit whose author or committer identity is an AI tool, so the
 * rule holds for Claude Code, Codex and every other tool that commits.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hasAiAttribution, isAiIdentity, stripAiAttribution } from "../lib/git-attribution.mjs";

const file = process.argv[2];
if (!file) {
  process.exit(0);
}

for (const variable of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
  let ident = "";
  try {
    ident = execFileSync("git", ["var", variable], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    continue;
  }
  if (isAiIdentity(ident.replace(/\s+\d+\s+[+-]\d{4}\s*$/, ""))) {
    process.stderr.write("astack: refused — the commit " + (variable.includes("AUTHOR") ? "author" : "committer") + " is an AI identity (" + ident.trim().replace(/\s+\d+\s+[+-]\d{4}$/, "") + "). Commit as the owner: git config user.name / user.email.\n");
    process.exit(1);
  }
}

const message = readFileSync(file, "utf8");
if (hasAiAttribution(message)) {
  writeFileSync(file, stripAiAttribution(message));
}
