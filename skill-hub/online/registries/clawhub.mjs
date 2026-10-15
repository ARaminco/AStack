import { baseOf, cleanRepoPath, cleanText, gitFetch, isRepo, numberOrNull, parseGitHubUrl, repoUrl } from "./common.mjs";

/**
 * ClawHub (OpenClaw). No API key for reads. OpenAPI: https://clawhub.ai/api/v1/openapi.json
 *
 *   GET /api/v1/search?q=<q>&limit=<n>&nonSuspiciousOnly=true
 *   -> { results: [{ id, displayName, summary, canonicalUrl, downloads, ownerHandle, slug,
 *                     install: { kind: "clawhub" | "skills-sh", reference }, links: { source }, trust, ... }] }
 *   GET /api/v1/skills/<slug>?ownerHandle=<owner>
 *   -> { skill, latestVersion: { version }, owner, moderation: { verdict: clean|suspicious|malicious, isMalwareBlocked } }
 *   GET /api/v1/download?slug=<slug>&ownerHandle=<owner>
 *   -> application/zip (SKILL.md, _meta.json, … at the archive root), or
 *      application/json { sourceRef: "public-github", repo, commit, path, contentHash, archiveUrl }
 *
 * A bare slug is ambiguous when several publishers use it (HTTP 409), so the
 * owner handle is always sent. Results mirrored from skills.sh
 * (`install.kind: "skills-sh"`) point at GitHub and are fetched from there.
 */
export const clawhub = {
  id: "clawhub",
  label: "ClawHub",
  hosts: ["clawhub.ai"],

  async search(query, { http, limit, endpoints }) {
    const base = baseOf(endpoints, "clawhub", "https://clawhub.ai");
    const url = base + "/api/v1/search?q=" + encodeURIComponent(query) + "&limit=" + encodeURIComponent(limit) + "&nonSuspiciousOnly=true";
    const json = await http.json(url);
    const results = Array.isArray(json?.results) ? json.results : [];
    return { hits: results.map((entry) => normalise(entry, base)).filter(Boolean).slice(0, limit) };
  },

  /** `owner/slug` (hosted) or `skills-sh:owner/repo/skill` (mirrored). */
  parseId(native) {
    const value = String(native ?? "");
    if (value.startsWith("skills-sh:")) {
      return normalise({ install: { kind: "skills-sh", reference: value }, displayName: value.split("/").pop() }, "https://clawhub.ai");
    }
    const parts = value.split("/");
    return parts.length === 2 ? normalise({ install: { kind: "clawhub", reference: value }, displayName: parts[1] }, "https://clawhub.ai") : null;
  },

  /**
   * Resolve what to download for a hosted skill: the ZIP bytes, or the GitHub
   * handoff the registry answers with for a GitHub-backed skill.
   */
  async download({ owner, slug }, { http, endpoints }) {
    const base = baseOf(endpoints, "clawhub", "https://clawhub.ai");
    const query = "slug=" + encodeURIComponent(slug) + "&ownerHandle=" + encodeURIComponent(owner);
    let moderation = null;
    let version = null;
    try {
      const detail = await http.json(base + "/api/v1/skills/" + encodeURIComponent(slug) + "?ownerHandle=" + encodeURIComponent(owner));
      moderation = detail?.moderation ?? null;
      version = detail?.latestVersion?.version ? cleanText(detail.latestVersion.version, 40) : null;
    } catch {
      // Detail is advisory; the scan decides.
    }
    if (moderation?.isMalwareBlocked || moderation?.verdict === "malicious") {
      const error = new Error("ClawHub marks " + owner + "/" + slug + " as malicious; refused.");
      error.code = "registry-blocked";
      throw error;
    }
    const response = await http.get(base + "/api/v1/download?" + query, { maxBytes: 25 * 1024 * 1024 });
    const verdict = moderation?.verdict ?? null;
    if (/json/i.test(response.contentType)) {
      const handoff = JSON.parse(response.body.toString("utf8"));
      const github = parseGitHubUrl(handoff?.repo) ?? (isRepo(handoff?.repo) ? { repo: handoff.repo } : null);
      const path = cleanRepoPath(handoff?.path ?? "");
      if (!github || path === null) {
        throw new Error("ClawHub returned a download handoff AStack cannot use for " + owner + "/" + slug);
      }
      return { type: "git", repo: github.repo, path, commit: /^[0-9a-f]{40}$/.test(String(handoff.commit ?? "")) ? handoff.commit : null, version, verdict, contentHash: cleanText(handoff.contentHash ?? "", 80) || null };
    }
    return { type: "zip", buffer: response.body, version, verdict, file: /filename="?([^";]+)/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? null };
  }
};

function normalise(entry, base) {
  const kind = entry?.install?.kind;
  const reference = String(entry?.install?.reference ?? "");
  const name = cleanText(entry?.displayName ?? entry?.slug ?? "", 120);
  const description = cleanText(entry?.summary ?? "", 240);
  const canonical = String(entry?.canonicalUrl ?? "");
  const url = canonical.startsWith("/") ? base + canonical : null;
  if (kind === "skills-sh") {
    const parts = reference.replace(/^skills-sh:/, "").split("/");
    const repo = parts.slice(0, 2).join("/");
    const skillId = parts[2];
    if (parts.length !== 3 || !isRepo(repo) || !skillId) {
      return null;
    }
    return {
      source: "clawhub",
      id: "clawhub:skills-sh:" + repo + "/" + skillId,
      name: name || skillId,
      description,
      author: parts[0],
      repo,
      repoUrl: repoUrl(repo),
      path: null,
      ref: null,
      skillId,
      popularity: numberOrNull(entry?.sourceIdentity?.lifetimeInstalls ?? entry?.downloads),
      popularityKind: "installs",
      url,
      fetch: gitFetch({ repo, skillId })
    };
  }
  if (kind !== "clawhub") {
    return null;
  }
  const [owner, slug] = reference.split("/");
  if (!/^[A-Za-z0-9_.-]+$/.test(owner ?? "") || !/^[A-Za-z0-9_.-]+$/.test(slug ?? "")) {
    return null;
  }
  return {
    source: "clawhub",
    id: "clawhub:" + owner + "/" + slug,
    name: name || slug,
    description,
    author: owner,
    repo: null,
    repoUrl: null,
    path: null,
    ref: null,
    skillId: slug,
    popularity: numberOrNull(entry?.downloads ?? entry?.native?.skill?.stats?.downloads),
    popularityKind: "downloads",
    url: url ?? base + "/" + owner + "/skills/" + slug,
    fetch: { type: "clawhub", owner, slug }
  };
}
