import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { shortHash, slugify } from "../lib/text.mjs";

/**
 * Where a skill pack comes from: a local folder, a git URL, or a GitHub
 * `owner/repo[/path][#ref]` shorthand.
 *
 * Remote sources are shallow-cloned into `.astack/skill-hub/cache/`. Git is
 * only ever run for `clone` and `ls-remote`, through the automation policy,
 * with prompts disabled. Nothing inside a cloned repository is executed: the
 * commit and origin are read from the files under `.git/` directly, because
 * running git inside an untrusted checkout can execute repository config.
 */
export function classifySource(source, { cwd = process.cwd() } = {}) {
  const value = String(source ?? "").trim();
  if (!value) {
    throw new Error("A skill source is required (a folder, a git URL or owner/repo/path).");
  }
  const local = isAbsolute(value) ? value : resolve(cwd, value);
  if (existsSync(local) && statSync(local).isDirectory()) {
    return { type: "local", directory: local, input: value };
  }
  if (/^https?:\/\//i.test(value) || /\.git(#.*)?$/i.test(value)) {
    const [url, ref = null] = value.split("#");
    return { type: "git", url, ref, subpath: null, input: value };
  }
  const github = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/([^#]+))?(?:#(.+))?$/.exec(value);
  if (github) {
    return {
      type: "github",
      url: "https://github.com/" + github[1] + "/" + github[2].replace(/\.git$/, "") + ".git",
      ref: github[4] ?? null,
      subpath: github[3] ? github[3].replace(/^\/+|\/+$/g, "") : null,
      input: value
    };
  }
  throw new Error("Unrecognised skill source: " + value);
}

function stripCredentials(url) {
  return String(url ?? "").replace(/^(https?:\/\/)[^@/]+@/i, "$1");
}

/**
 * Read HEAD's commit and the origin URL of a checkout without running git.
 */
export function readGitInfo(directory) {
  let gitDirectory = join(directory, ".git");
  if (!existsSync(gitDirectory)) {
    return { commit: null, origin: null };
  }
  try {
    if (statSync(gitDirectory).isFile()) {
      const pointer = /gitdir:\s*(.+)/.exec(readFileSync(gitDirectory, "utf8"))?.[1]?.trim();
      gitDirectory = pointer ? resolve(directory, pointer) : gitDirectory;
    }
    const head = readFileSync(join(gitDirectory, "HEAD"), "utf8").trim();
    let commit = /^[0-9a-f]{40}$/.test(head) ? head : null;
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1]?.trim();
    if (!commit && ref) {
      const loose = join(gitDirectory, ...ref.split("/"));
      if (existsSync(loose)) {
        commit = readFileSync(loose, "utf8").trim();
      } else if (existsSync(join(gitDirectory, "packed-refs"))) {
        const line = readFileSync(join(gitDirectory, "packed-refs"), "utf8").split(/\r?\n/).find((entry) => entry.endsWith(" " + ref));
        commit = line ? line.split(" ")[0] : null;
      }
    }
    let origin = null;
    const configPath = join(gitDirectory, "config");
    if (existsSync(configPath)) {
      const config = readFileSync(configPath, "utf8");
      const section = /\[remote "origin"\]([\s\S]*?)(\n\[|$)/.exec(config)?.[1] ?? "";
      origin = /^\s*url\s*=\s*(.+)$/m.exec(section)?.[1]?.trim() ?? null;
    }
    return { commit: commit && /^[0-9a-f]{40}$/.test(commit) ? commit : null, origin: origin ? stripCredentials(origin) : null };
  } catch {
    return { commit: null, origin: null };
  }
}

function gitEnvironment() {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GCM_INTERACTIVE: "never" };
}

function checkRemote(policy, url, args) {
  if (policy) {
    const host = policy.allowHost(url);
    if (!host.allowed) {
      throw new Error("Skill source refused by the automation policy: " + host.reason);
    }
    const invocation = policy.allowInvocation("git", args);
    if (!invocation.allowed) {
      throw new Error("git refused by the automation policy: " + invocation.reason);
    }
  }
}

/**
 * Resolve a source to a local directory that can be scanned and copied.
 */
export function resolveSource(source, { cacheDirectory, policy = null, cwd = process.cwd(), runGit = defaultRunGit } = {}) {
  const classified = classifySource(source, { cwd });
  if (classified.type === "local") {
    const git = readGitInfo(classified.directory);
    return { ...classified, root: classified.directory, url: git.origin, commit: git.commit };
  }
  const url = stripCredentials(classified.url);
  const target = join(cacheDirectory, slugify(url.replace(/^https?:\/\//, ""), { maxLength: 60 }) + "-" + shortHash(url, classified.ref ?? "").slice(0, 8));
  const args = ["-c", "protocol.file.allow=never", "-c", "core.symlinks=false", "clone", "--depth", "1", "--no-tags", "--single-branch"];
  if (classified.ref) {
    args.push("--branch", classified.ref);
  }
  args.push("--", url, target);
  checkRemote(policy, url, args);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(cacheDirectory, { recursive: true });
  runGit(args);
  const git = readGitInfo(target);
  const directory = classified.subpath ? join(target, ...classified.subpath.split("/")) : target;
  if (!existsSync(directory)) {
    throw new Error("Path not found in the cloned repository: " + classified.subpath);
  }
  return { ...classified, url, root: target, directory, commit: git.commit };
}

/**
 * The newest commit of a remote without cloning it (update check only).
 */
export function remoteHead(url, { ref = null, policy = null, runGit = defaultRunGit } = {}) {
  const clean = stripCredentials(url);
  const args = ["ls-remote", "--", clean, ref ? ref : "HEAD"];
  checkRemote(policy, clean, args);
  const output = runGit(args);
  return /^([0-9a-f]{40})\s/m.exec(String(output ?? ""))?.[1] ?? null;
}

/**
 * Fetch one skill folder of a GitHub repository with a shallow, sparse,
 * blob-less clone (online skill search). Only the trees, the root licence
 * files and the requested folder are downloaded. When `path` is unknown, the
 * folder is located by `skillId`: first by folder name in the tree listing,
 * then by the `name:` of every SKILL.md in the repository.
 *
 * git runs only for `clone`, `ls-tree` and `sparse-checkout` on a clone this
 * function just created (a fresh clone carries no repository config or hooks),
 * every invocation passes the automation policy, and nothing inside the
 * checkout is executed. A git without partial-clone support falls back to a
 * plain shallow clone.
 */
export function fetchGitFolder({ url, path = null, skillId = null, ref = null, target, policy = null, runGit = defaultRunGit, readName = null } = {}) {
  const clean = stripCredentials(url);
  const safety = ["-c", "protocol.file.allow=never", "-c", "core.symlinks=false"];
  const branch = ref ? ["--branch", ref] : [];
  const sparseArgs = [...safety, "clone", "--depth", "1", "--no-tags", "--single-branch", "--filter=blob:none", "--sparse", ...branch, "--", clean, target];
  checkRemote(policy, clean, sparseArgs);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(join(target, ".."), { recursive: true });
  let sparse = true;
  try {
    runGit(sparseArgs);
  } catch {
    sparse = false;
    rmSync(target, { recursive: true, force: true });
    const plainArgs = [...safety, "clone", "--depth", "1", "--no-tags", "--single-branch", ...branch, "--", clean, target];
    checkRemote(policy, clean, plainArgs);
    runGit(plainArgs);
  }
  const inside = (args) => {
    const full = ["-C", target, ...safety, ...args];
    if (policy) {
      const invocation = policy.allowInvocation("git", full);
      if (!invocation.allowed) {
        throw new Error("git refused by the automation policy: " + invocation.reason);
      }
    }
    return String(runGit(full) ?? "");
  };
  const checkout = (folder) => {
    if (sparse) {
      inside(["sparse-checkout", "set", "--no-cone", ...(folder ? ["/" + folder + "/"] : ["/*"]), "/LICENSE*", "/LICENCE*", "/COPYING*"]);
    }
  };
  const cleanPath = path ? String(path).replace(/^\/+|\/+$/g, "") : null;
  let folder = cleanPath;
  if (folder !== null) {
    checkout(folder);
  }
  const located = () => folder !== null && existsSync(join(target, ...folder.split("/").filter(Boolean), "SKILL.md"));
  if (!located()) {
    // Unknown or stale path: locate the folder by the skill id.
    const wanted = slugify(String(skillId ?? (cleanPath ? cleanPath.split("/").pop() : "") ?? ""), { maxLength: 80 });
    const listing = sparse ? inside(["ls-tree", "-r", "--name-only", "HEAD"]).split(/\r?\n/) : listFilesDeep(target);
    const skillFiles = listing.map((line) => line.trim()).filter((line) => line === "SKILL.md" || line.endsWith("/SKILL.md"));
    const dirs = skillFiles.map((line) => (line === "SKILL.md" ? "" : line.slice(0, -"/SKILL.md".length)));
    const byFolder = dirs.filter((dir) => slugify(dir.split("/").pop() || "", { maxLength: 80 }) === wanted).sort((a, b) => a.length - b.length);
    folder = byFolder[0] ?? null;
    if (folder === null && wanted && dirs.length) {
      if (sparse) {
        inside(["sparse-checkout", "set", "--no-cone", "SKILL.md"]);
      }
      const nameOf = readName ?? ((file) => /^name:\s*["']?([^"'\r\n]+)/m.exec(readFileSync(file, "utf8"))?.[1]?.trim() ?? "");
      folder = dirs.find((dir) => {
        const file = join(target, ...dir.split("/").filter(Boolean), "SKILL.md");
        return existsSync(file) && slugify(nameOf(file), { maxLength: 80 }) === wanted;
      }) ?? null;
    }
    if (folder === null && dirs.length === 1) {
      folder = dirs[0];
    }
    if (folder === null) {
      throw new Error("No skill folder matching \"" + (skillId ?? cleanPath ?? "?") + "\" in " + clean);
    }
    checkout(folder);
  }
  const directory = folder ? join(target, ...folder.split("/").filter(Boolean)) : target;
  if (!existsSync(join(directory, "SKILL.md"))) {
    throw new Error("SKILL.md not found at " + (folder || "/") + " in " + clean);
  }
  const git = readGitInfo(target);
  return { url: clean, root: target, directory, path: folder, commit: git.commit, sparse };
}

function listFilesDeep(directory, prefix = "") {
  const found = [];
  let entries = [];
  try {
    entries = readdirSync(join(directory, ...prefix.split("/").filter(Boolean)), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name === ".git" || entry.isSymbolicLink()) {
      continue;
    }
    const rel = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.isDirectory()) {
      found.push(...listFilesDeep(directory, rel));
    } else {
      found.push(rel);
    }
  }
  return found;
}

function defaultRunGit(args) {
  return execFileSync("git", args, { env: gitEnvironment(), stdio: ["ignore", "pipe", "pipe"], timeout: 180000, windowsHide: true, encoding: "utf8" });
}
