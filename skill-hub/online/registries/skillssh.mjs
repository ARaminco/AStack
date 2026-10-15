import { baseOf, cleanText, gitFetch, isRepo, numberOrNull, repoUrl } from "./common.mjs";

/**
 * skills.sh (Vercel). No API key.
 *
 *   GET https://skills.sh/api/search?q=<q>&limit=<n>
 *   -> { query, searchType, skills: [{ id: "owner/repo/skillId", source: "owner/repo", skillId, name, installs }], count }
 *
 * Results carry no description. Every skill lives in a public GitHub
 * repository (`source`); the folder is found by `skillId` when fetched.
 */
export const skillssh = {
  id: "skillssh",
  label: "skills.sh",
  hosts: ["skills.sh"],

  async search(query, { http, limit, endpoints }) {
    const base = baseOf(endpoints, "skillssh", "https://skills.sh");
    const url = base + "/api/search?q=" + encodeURIComponent(query) + "&limit=" + encodeURIComponent(limit);
    const json = await http.json(url);
    const skills = Array.isArray(json?.skills) ? json.skills : [];
    return { hits: skills.map((entry) => normalise(entry, base)).filter(Boolean).slice(0, limit) };
  },

  /** `owner/repo/skillId` → a hit that can be fetched without a prior search. */
  parseId(native) {
    const parts = String(native ?? "").split("/");
    if (parts.length !== 3) {
      return null;
    }
    return normalise({ id: native, source: parts[0] + "/" + parts[1], skillId: parts[2], name: parts[2] }, "https://skills.sh");
  }
};

function normalise(entry, base) {
  const repo = String(entry?.source ?? "");
  const skillId = cleanText(entry?.skillId ?? "", 120);
  if (!isRepo(repo) || !skillId || /[/\\]/.test(skillId)) {
    return null;
  }
  const native = repo + "/" + skillId;
  return {
    source: "skillssh",
    id: "skillssh:" + native,
    name: cleanText(entry?.name ?? skillId, 120) || skillId,
    description: "",
    author: repo.split("/")[0],
    repo,
    repoUrl: repoUrl(repo),
    path: null,
    ref: null,
    skillId,
    popularity: numberOrNull(entry?.installs),
    popularityKind: "installs",
    url: base + "/" + native,
    fetch: gitFetch({ repo, skillId })
  };
}
