import { baseOf, cleanText, gitFetch, numberOrNull, parseGitHubUrl, repoUrl } from "./common.mjs";

/**
 * SkillsMP. Anonymous keyword search, no key needed; an optional free API key
 * (`skills.online.skillsmp_key: credential://skillsmp/api-key`) raises the
 * quota. Anonymous quota seen on 2026-10-15: 10 requests a minute, 50 a day
 * (`x-ratelimit-*` headers), so results are cached.
 *
 *   GET https://skillsmp.com/api/v1/skills/search?q=<q>&limit=<1..50>&sortBy=relevance
 *   -> { success, data: { skills: [{ id, name, author, description, githubUrl, skillUrl, stars, updatedAt }],
 *                          pagination: { page, limit, total, totalPages, hasNext } } }
 *
 * `githubUrl` is a GitHub tree URL; `stars` are the repository's stars. There
 * is no detail endpoint, so a SkillsMP id can only be fetched after a search.
 */
export const skillsmp = {
  id: "skillsmp",
  label: "SkillsMP",
  hosts: ["skillsmp.com"],

  async search(query, { http, limit, endpoints, credential }) {
    const base = baseOf(endpoints, "skillsmp", "https://skillsmp.com");
    const url = base + "/api/v1/skills/search?q=" + encodeURIComponent(query.slice(0, 200)) + "&limit=" + Math.min(50, Math.max(1, limit)) + "&sortBy=relevance";
    const key = credential ? credential("skillsmp") : null;
    const json = await http.json(url, key ? { headers: { authorization: "Bearer " + key } } : {});
    if (json?.success === false) {
      throw new Error("SkillsMP error: " + cleanText(json?.error?.message ?? json?.message ?? "unknown", 160));
    }
    const skills = Array.isArray(json?.data?.skills) ? json.data.skills : [];
    return { hits: skills.map(normalise).filter(Boolean).slice(0, limit) };
  },

  parseId() {
    return null;
  }
};

function normalise(entry) {
  const id = cleanText(entry?.id ?? "", 200);
  const github = parseGitHubUrl(entry?.githubUrl);
  if (!id || /\s/.test(id)) {
    return null;
  }
  return {
    source: "skillsmp",
    id: "skillsmp:" + id,
    name: cleanText(entry?.name ?? id, 120) || id,
    description: cleanText(entry?.description ?? "", 240),
    author: cleanText(entry?.author ?? "", 80) || (github ? github.repo.split("/")[0] : null),
    repo: github?.repo ?? null,
    repoUrl: github ? repoUrl(github.repo) : null,
    path: github?.path ?? null,
    ref: github?.ref ?? null,
    skillId: github?.path ? github.path.split("/").pop() : null,
    popularity: numberOrNull(entry?.stars),
    popularityKind: "stars",
    url: /^https:\/\//.test(String(entry?.skillUrl ?? "")) ? String(entry.skillUrl) : null,
    fetch: github ? gitFetch({ repo: github.repo, path: github.path, skillId: github.path ? github.path.split("/").pop() : null, ref: github.ref }) : null
  };
}
