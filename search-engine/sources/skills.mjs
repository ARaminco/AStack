import { redact } from "../redact.mjs";
import { sha } from "./util.mjs";

/**
 * The skill catalog one-liners (built-in, learned and, once the skill hub is
 * merged, imported packs). One unit for the whole catalog: it is small and
 * changes rarely.
 */
export const id = "skills";
// Bump when parsing changes: every unit of this source is then re-read.
export const version = 1;

export function units({ skills }) {
  if (!skills?.list) {
    return [];
  }
  let list = [];
  try {
    list = skills.list();
  } catch {
    return [];
  }
  const docs = list.map((skill) => ({
    id: "skills:" + skill.id,
    kind: skill.source ?? "builtin",
    title: redact(skill.nameFa && skill.nameFa !== skill.name ? skill.id + " — " + skill.nameFa : skill.id + (skill.name && skill.name !== skill.id ? " — " + skill.name : "")),
    path: skill.path ?? null,
    date: skill.updatedAt ?? skill.createdAt ?? null,
    text: redact([skill.description, (skill.keywords ?? []).join(" "), (skill.domains ?? []).join(" ")].filter(Boolean).join("\n")),
    meta: { skill: skill.id, source: skill.source ?? null, status: skill.status ?? null, confidence: skill.confidence ?? null }
  }));
  const hash = sha(JSON.stringify(docs));
  return [{ key: "catalog", fingerprint: hash, read: () => ({ hash, docs }) }];
}
