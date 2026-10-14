import { memoryFacets } from "../../memory-engine/facets.mjs";
import { redact } from "../redact.mjs";
import { fingerprintOf, sha } from "./util.mjs";

/**
 * Every memory-engine record, one document per record.
 *
 * Status mirrors MemoryEngine.recall: a record whose replacement exists is
 * "superseded" and carries its validity window, so a default search shows
 * only current facts while `asOf` answers "what did we believe then".
 * Forgotten (retired) records are already gone from the compacted facet view.
 */
export const id = "memory";
// Bump when parsing changes: every unit of this source is then re-read.
export const version = 1;

export function units({ memory }) {
  if (!memory?.facets) {
    return [];
  }
  const facets = memory.facets;
  return memoryFacets.map((facet) => ({
    key: facet,
    fingerprint: fingerprintOf(facets.path(facet)) ?? "absent",
    read() {
      const records = facets.all(facet);
      const docs = records.map((record) => toDoc(record, facets));
      return { hash: sha(JSON.stringify(docs)), docs };
    }
  }));
}

function toDoc(record, facets) {
  const replaced = Boolean(record.supersededBy) && facets.exists(record.facet, record.supersededBy);
  const ends = [replaced || !record.supersededBy ? record.validTo : null, record.expiresAt].filter(Boolean).sort();
  const extra = [record.tags?.length ? "tags: " + record.tags.join(", ") : "", record.entities?.length ? "entities: " + record.entities.join(", ") : ""]
    .filter(Boolean)
    .join("\n");
  return {
    id: "memory:" + record.id,
    kind: record.facet,
    title: redact(record.title || record.body.split(/\r?\n/)[0] || record.id),
    path: record.refs?.find((ref) => ref.startsWith("file:"))?.slice(5) ?? null,
    date: record.at ?? null,
    text: redact([record.body, extra].filter(Boolean).join("\n")),
    status: replaced ? "superseded" : "active",
    validFrom: record.validFrom ?? record.at ?? null,
    validTo: ends[0] ?? null,
    meta: {
      record: record.id,
      facet: record.facet,
      confidence: record.confidence,
      importance: record.importance,
      project: record.project ?? null,
      domain: record.domain ?? null,
      supersededBy: record.supersededBy ?? null
    }
  };
}
