import { execFileSync } from "node:child_process";
import { parseFrontMatter } from "../../frontmatter.mjs";
import { slugify, uniqueTokens } from "../../../lib/text.mjs";
import { baseOf, cleanRepoPath, cleanText, gitFetch, isRepo, repoUrl } from "./common.mjs";

/**
 * GitHub, two ways:
 *
 * 1. The official `anthropics/skills` repository, indexed without auth:
 *      GET https://api.github.com/repos/anthropics/skills/contents/skills   (one call; 60 an hour unauthenticated)
 *      GET https://raw.githubusercontent.com/anthropics/skills/HEAD/skills/<name>/SKILL.md   (no API quota)
 *    The index is cached and matched locally against the query.
 * 2. Code search for SKILL.md files through the GitHub CLI, when `gh` is
 *    installed, authenticated and allowlisted by the automation policy
 *    (`astack schedule policy allow-command gh`):
 *      gh search code --filename SKILL.md --limit <n> --json path,repository,url,textMatches -- <q>
 *    The automation policy allowlists a command, not a subcommand: allow-command
 *    gh lets every gh subcommand pass the policy, so enable it only for
 *    attended use, not for a workspace whose scheduled jobs or signal rules
 *    run commands.
 *    GitHub's REST code search needs a token, so without `gh` this half is
 *    skipped and reported.
 */
export const OFFICIAL_REPOSITORIES = [{ repo: "anthropics/skills", path: "skills" }];

export const github = {
  id: "github",
  label: "GitHub",
  hosts: ["api.github.com", "raw.githubusercontent.com", "github.com"],

  async search(query, context) {
    const { limit } = context;
    const warnings = [];
    const hits = [];
    let succeeded = 0;
    try {
      hits.push(...(await officialHits(query, context)));
      succeeded += 1;
    } catch (error) {
      warnings.push({ part: "anthropics/skills", error: error.message, hint: error.hint ?? null });
    }
    try {
      hits.push(...codeSearch(query, context));
      succeeded += 1;
    } catch (error) {
      warnings.push({ part: "gh search code", error: error.message, hint: error.hint ?? null });
    }
    if (!succeeded) {
      const error = new Error(warnings.map((entry) => entry.part + ": " + entry.error).join("; "));
      error.hint = warnings.find((entry) => entry.hint)?.hint ?? null;
      throw error;
    }
    return { hits: hits.slice(0, limit * 2), warnings };
  },

  /** `owner/repo[/path][#ref]` */
  parseId(native) {
    const [value, ref = null] = String(native ?? "").split("#");
    const parts = value.split("/");
    const repo = parts.slice(0, 2).join("/");
    const path = cleanRepoPath(parts.slice(2).join("/"));
    if (!isRepo(repo) || path === null) {
      return null;
    }
    return hit({ repo, path, ref, name: path ? path.split("/").pop() : parts[1], description: "" });
  }
};

function hit({ repo, path, ref = null, name, description, popularity = null, popularityKind = null }) {
  return {
    source: "github",
    id: "github:" + repo + (path ? "/" + path : "") + (ref ? "#" + ref : ""),
    name: cleanText(name, 120),
    description: cleanText(description, 240),
    author: repo.split("/")[0],
    repo,
    repoUrl: repoUrl(repo),
    path,
    ref,
    skillId: path ? path.split("/").pop() : repo.split("/")[1],
    popularity,
    popularityKind,
    url: repoUrl(repo) + (path ? "/tree/" + (ref ?? "HEAD") + "/" + path : ""),
    fetch: gitFetch({ repo, path, skillId: path ? path.split("/").pop() : null, ref })
  };
}

async function officialIndex({ http, endpoints, cache }) {
  const api = baseOf(endpoints, "github_api", "https://api.github.com");
  const raw = baseOf(endpoints, "github_raw", "https://raw.githubusercontent.com");
  const entries = [];
  for (const { repo, path } of OFFICIAL_REPOSITORIES) {
    const load = async () => {
      const listing = await http.json(api + "/repos/" + repo + "/contents/" + path, { headers: { accept: "application/vnd.github+json" } });
      const folders = (Array.isArray(listing) ? listing : []).filter((entry) => entry?.type === "dir" && /^[A-Za-z0-9_.-]+$/.test(String(entry.name ?? ""))).slice(0, 80);
      const described = await Promise.all(folders.map(async (folder) => {
        try {
          const response = await http.get(raw + "/" + repo + "/HEAD/" + path + "/" + folder.name + "/SKILL.md", { maxBytes: 512 * 1024 });
          const data = parseFrontMatter(response.body.toString("utf8")).data ?? {};
          return { repo, path: path + "/" + folder.name, name: String(data.name ?? folder.name), description: String(data.description ?? "") };
        } catch {
          return { repo, path: path + "/" + folder.name, name: folder.name, description: "" };
        }
      }));
      return described;
    };
    entries.push(...(cache ? await cache.remember("github-index-" + slugify(repo), load) : await load()));
  }
  return entries;
}

async function officialHits(query, context) {
  const tokens = uniqueTokens(query);
  const index = await officialIndex(context);
  return index
    .filter((entry) => {
      const words = uniqueTokens([entry.name, entry.path.split("/").pop().replace(/[-_]/g, " "), entry.description].join(" "));
      return tokens.some((token) => words.some((word) => word === token || (token.length >= 4 && word.startsWith(token))));
    })
    .map((entry) => hit({ ...entry, popularity: null, popularityKind: "official" }));
}

function defaultRunGh(args) {
  return execFileSync("gh", args, { stdio: ["ignore", "pipe", "pipe"], timeout: 30000, windowsHide: true, encoding: "utf8", env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" } });
}

function codeSearch(query, { limit, policy, runGh = defaultRunGh }) {
  const terms = String(query).replace(/[;&|`$<>\r\n"']/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  // The terms follow "--" (end of options), so a query can never become a gh flag.
  const args = ["search", "code", "--filename", "SKILL.md", "--limit", String(Math.min(30, Math.max(1, limit))), "--json", "path,repository,url,textMatches", "--", terms];
  if (policy) {
    const verdict = policy.allowInvocation("gh", args);
    if (!verdict.allowed) {
      const error = new Error("gh refused by the automation policy: " + String(verdict.reason).replace(/.s*Add it with:.*$/, ""));
      error.hint = /not allowlisted/i.test(verdict.reason) ? "astack schedule policy allow-command gh" : null;
      throw error;
    }
  }
  let output;
  try {
    output = runGh(args);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("the GitHub CLI (gh) is not installed");
    }
    const stderr = String(error?.stderr ?? error?.message ?? error).trim().split(/\r?\n/)[0];
    const failure = new Error("gh search code failed: " + stderr.slice(0, 160));
    failure.hint = /auth|login/i.test(stderr) ? "gh auth login" : null;
    throw failure;
  }
  let results = [];
  try {
    results = JSON.parse(String(output ?? "[]"));
  } catch {
    throw new Error("gh search code returned invalid JSON");
  }
  return (Array.isArray(results) ? results : [])
    .map((entry) => {
      const repo = String(entry?.repository?.nameWithOwner ?? "");
      if (entry?.repository?.isPrivate || !isRepo(repo)) {
        return null;
      }
      const file = String(entry?.path ?? "");
      if (!(file === "SKILL.md" || file.endsWith("/SKILL.md"))) {
        return null;
      }
      const path = cleanRepoPath(file === "SKILL.md" ? "" : file.slice(0, -"/SKILL.md".length));
      if (path === null) {
        return null;
      }
      const fragment = (entry?.textMatches ?? []).map((match) => String(match?.fragment ?? "")).join(" ");
      const description = /description:\s*["']?([^\n"']+)/i.exec(fragment)?.[1] ?? fragment;
      const name = /(^|\n)name:\s*["']?([^\n"']+)/i.exec(fragment)?.[2] ?? (path ? path.split("/").pop() : repo.split("/")[1]);
      return hit({ repo, path, name, description, popularity: null, popularityKind: null });
    })
    .filter(Boolean);
}
