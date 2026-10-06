import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * The canonical core: a shallow clone of the AStack git repository at
 * ~/.astack/core, checked out at the release being installed. Every update and
 * every setup of another project goes through it, so all projects on a machine
 * update from the same repository and the same release.
 */

export const DEFAULT_SOURCE = "https://github.com/ARaminco/AStack.git";
export const CHANNELS = ["stable", "main"];

export function userHome(env = process.env) {
  return env.ASTACK_USER_HOME || homedir();
}

export function canonicalCore(env = process.env) {
  return env.ASTACK_CORE || join(userHome(env), ".astack", "core");
}

function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 180000, ...options }).trim();
}

/** Highest vX.Y.Z tag in `git ls-remote --tags` output. */
export function latestReleaseTag(lsRemoteOutput) {
  const tags = String(lsRemoteOutput)
    .split(/\r?\n/)
    .map((line) => /refs\/tags\/(v(\d+)\.(\d+)\.(\d+))$/.exec(line.trim()))
    .filter(Boolean)
    .map((match) => ({ tag: match[1], parts: [Number(match[2]), Number(match[3]), Number(match[4])] }));
  tags.sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2]);
  return tags[0]?.tag ?? null;
}

/**
 * Which git ref an update installs: an explicit version wins, then the channel.
 * "stable" is the newest release tag; "main" is the branch head.
 */
export function resolveRef({ source = DEFAULT_SOURCE, version = null, channel = "stable" } = {}) {
  if (version) {
    return String(version).startsWith("v") ? String(version) : "v" + version;
  }
  if (channel === "main") {
    return "main";
  }
  if (!CHANNELS.includes(channel)) {
    throw new Error("Unknown update channel: " + channel + " (expected " + CHANNELS.join(" or ") + ")");
  }
  const tag = latestReleaseTag(git(["ls-remote", "--tags", "--refs", source]));
  if (!tag) {
    throw new Error("No release tag found in " + source + "; use --channel main");
  }
  return tag;
}

/**
 * Bring the canonical clone to `ref`. Works whether the clone sits on a branch
 * or on a detached release, and repoints it when the source changed.
 */
export function syncCanonical({ source = DEFAULT_SOURCE, ref = "main", dir = canonicalCore() } = {}) {
  if (existsSync(source)) {
    return { dir: resolve(source), ref: "local", commit: null, local: true };
  }
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dirname(dir), { recursive: true });
    git(["clone", "--depth", "1", "--quiet", "--branch", ref, source, dir]);
  } else {
    git(["-C", dir, "remote", "set-url", "origin", source]);
    git(["-C", dir, "fetch", "--depth", "1", "--quiet", "origin", ref]);
    git(["-C", dir, "checkout", "--quiet", "--force", "--detach", "FETCH_HEAD"]);
  }
  return { dir, ref, commit: git(["-C", dir, "rev-parse", "--short", "HEAD"]), local: false };
}
