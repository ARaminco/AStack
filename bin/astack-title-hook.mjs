#!/usr/bin/env node
// Claude Code UserPromptSubmit and Stop hooks for chat titles.
//
// It runs on every prompt, so it loads only the session-titles engine and the
// configuration, not the whole AStack runtime (about 300 ms per prompt).
// Usage (written by `astack interop sync` and `astack session hook install`):
//   node bin/astack-title-hook.mjs interop hook prompt|stop --runtime claude-code [--scope=user]
// The words after the script are kept so the commands carry the same marker
// as the other AStack hooks.
//
// A hook must never break the session that runs it: every failure is silent
// and the process always exits 0.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigurationEngine } from "../configuration-engine/configuration.mjs";
import { SessionTitles, projectHasPromptHook, projectTitleConfig } from "../interop-engine/session-titles.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readPayload() {
  if (process.stdin.isTTY) {
    return {};
  }
  try {
    const text = readFileSync(0, "utf8").trim();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

try {
  const payload = readPayload();
  const userScope = process.argv.includes("--scope=user");
  const projectDir = process.env.CLAUDE_PROJECT_DIR || payload.cwd || null;
  // The user-level hook leaves a project with its own AStack prompt hook to it.
  if (!(userScope && projectHasPromptHook(projectDir))) {
    let config = {};
    try {
      config = new ConfigurationEngine(root).section("session_titles", {});
    } catch {
      config = {};
    }
    // From the user level, a project's own settings (an opt-out, a naming
    // hint) win over the canonical core's.
    const project = userScope ? projectTitleConfig(projectDir) : null;
    if (project) {
      config = { ...config, ...project };
    }
    const titles = new SessionTitles({ projectRoot: projectDir ?? root, config, cli: join(root, "bin", "astack.mjs") });
    if (process.argv.includes("stop")) {
      // End of a reply: name the chat now if it was asked and skipped, and
      // keep the phone copy in step.
      const result = await titles.stopHook(payload);
      if (result?.block) {
        process.stdout.write(JSON.stringify({ decision: "block", reason: result.block }));
      }
    } else {
      const context = titles.promptHook(payload);
      if (context) {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } }));
      }
    }
  }
} catch {
  // Silent by design.
}
process.exitCode = 0;
