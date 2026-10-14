/**
 * Optional "also found in past sessions" lines for `astack memory search` and
 * `astack context search`.
 *
 * Silent unless the search index exists and holds matching sessions, so the
 * existing commands print exactly what they printed before on an install
 * that never ran `astack search reindex`. Disabled with `search.hooks: false`
 * or `--no-sessions`. Never throws.
 */
export function appendSessionMatches({ runtime, query, out, t, flags = {}, k = 3 }) {
  try {
    const search = runtime?.search;
    if (!search || !String(query ?? "").trim() || flags.noSessions || flags["no-sessions"] || flags.json) {
      return [];
    }
    if (runtime.configuration?.section?.("search", {})?.hooks === false) {
      return [];
    }
    const hits = search.querySync(query, { sources: ["sessions"], k });
    if (!hits.length) {
      return [];
    }
    out(t("cli.search.alsoFound", { count: hits.length }));
    for (const hit of hits) {
      out("- " + (hit.date ? hit.date.slice(0, 10) + " " : "") + hit.title);
      out("    " + hit.snippet);
    }
    return hits;
  } catch {
    return [];
  }
}
