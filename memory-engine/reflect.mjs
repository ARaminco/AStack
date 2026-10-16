import { recordBindings } from "./facets.mjs";
import { DEFAULT_BLOCK_LIMIT, MemoryBlocks, looksLikeInstruction, looksSecret } from "./blocks.mjs";

export const REFLECT_SOURCE = "memory-reflect";
export const KEY_FACTS_LABEL = "key-facts";

const OWNER_FACETS = ["identity", "preference", "decision", "lesson", "procedural"];
const EXCLUDED_FACETS = ["working", "episodic", "calibration"];
const SCOPE_KINDS = ["owner", "project", "case", "entity"];

/**
 * The memory manager pass (what Letta calls a sleep-time agent), done
 * deterministically: for each scope it ranks the long-term records that matter
 * most — high importance, proven by use, decisions and preferences — and
 * writes them as a bounded `<scope>/key-facts` block, so the active window
 * always carries the current version of what matters for that owner, project
 * or case.
 *
 * - A superseded, forgotten or expired record leaves the block on the next
 *   pass; its replacement takes its place when it qualifies.
 * - The block is managed: a pass only rewrites it while the latest version is
 *   its own. A block someone edited by hand is reported and left alone.
 * - Nothing in the long-term store is changed.
 */
export function reflect({ facets, blocks, scope = null, limit = 8, threshold = 0.65, minNew = 2, dryRun = false, clock = null } = {}) {
  if (!facets || !blocks) {
    throw new Error("Reflection needs the facet store and the block store");
  }
  const now = (clock ?? (() => new Date()))().getTime();
  const live = facets.everything().filter((record) => isLive(record, facets, now));
  const scopes = scope ? [scope] : discoverScopes(live, blocks);
  const report = { scopes: [], written: 0, unchanged: 0, skipped: 0 };
  for (const target of scopes) {
    const kind = String(target).split(":")[0];
    if (!SCOPE_KINDS.includes(kind) || !MemoryBlocks.validScope(target)) {
      report.scopes.push({ scope: target, status: "skipped", reason: "only owner, project, case and entity scopes are reflected" });
      report.skipped += 1;
      continue;
    }
    const candidates = rank(live, target, threshold).slice(0, limit);
    const id = target + "/" + KEY_FACTS_LABEL;
    const current = blocks.get(id);
    const last = blocks.history(id).at(-1);
    if (!current && last?.deleted && last.source !== REFLECT_SOURCE) {
      report.scopes.push({ scope: target, block: id, status: "skipped", reason: "retired by " + last.source + "; restoring a version that reflect wrote hands it back to reflection" });
      report.skipped += 1;
      continue;
    }
    if (current && current.source !== REFLECT_SOURCE) {
      report.scopes.push({ scope: target, block: id, status: "skipped", reason: "edited by " + current.source + "; reflection never overwrites a manual edit" });
      report.skipped += 1;
      continue;
    }
    if (!current && candidates.length < (target === "owner" ? 1 : minNew)) {
      report.scopes.push({ scope: target, status: "unchanged", reason: "not enough important records yet", candidates: candidates.length });
      report.unchanged += 1;
      continue;
    }
    const cap = current?.limit ?? DEFAULT_BLOCK_LIMIT;
    // A line the block guard would refuse (a secret shape, an instruction) is
    // left in long-term memory rather than promoted.
    const lines = fit(candidates.map(line).filter((entry) => !looksSecret(entry) && !looksLikeInstruction(entry)), cap);
    const previous = current?.value ? current.value.split("\n").filter(Boolean) : [];
    const added = lines.filter((entry) => !previous.includes(entry));
    const removed = previous.filter((entry) => !lines.includes(entry));
    const entry = { scope: target, block: id, records: lines.length, added: added.length, removed: removed.length };
    if (!added.length && !removed.length) {
      report.scopes.push({ ...entry, status: "unchanged" });
      report.unchanged += 1;
      continue;
    }
    if (!dryRun) {
      // One scope that cannot be written is reported; the others still are.
      try {
        if (lines.length) {
          blocks.set(id, lines.join("\n"), {
            limit: cap,
            managed: true,
            description: "Maintained by memory reflect from long-term memory. Correct the source record (memory supersede), not this block.",
            source: REFLECT_SOURCE
          });
        } else {
          blocks.remove(id, { source: REFLECT_SOURCE });
        }
      } catch (error) {
        report.scopes.push({ ...entry, status: "skipped", reason: error.message });
        report.skipped += 1;
        continue;
      }
    }
    report.scopes.push({ ...entry, status: dryRun ? "planned" : "written", addedLines: added, removedLines: removed });
    report.written += 1;
  }
  return report;
}

function isLive(record, facets, now) {
  if (EXCLUDED_FACETS.includes(record.facet)) {
    return false;
  }
  if (record.supersededBy && facets.exists(record.facet, record.supersededBy)) {
    return false;
  }
  if (record.validTo && !record.supersededBy && new Date(record.validTo).getTime() <= now) {
    return false;
  }
  if (record.expiresAt && new Date(record.expiresAt).getTime() <= now) {
    return false;
  }
  return true;
}

function discoverScopes(records, blocks) {
  const scopes = new Set(["owner"]);
  for (const block of blocks.list()) {
    if (SCOPE_KINDS.includes(block.scope.split(":")[0])) {
      scopes.add(block.scope);
    }
  }
  const counts = new Map();
  for (const record of records) {
    for (const binding of recordBindings(record)) {
      if (/^(project|case):/.test(binding)) {
        counts.set(binding, (counts.get(binding) ?? 0) + 1);
      }
    }
  }
  for (const [binding, count] of counts) {
    if (count >= 2 && MemoryBlocks.validScope(binding)) {
      scopes.add(binding);
    }
  }
  return [...scopes];
}

function rank(records, scope, threshold) {
  return records
    .filter((record) => {
      const bindings = recordBindings(record);
      if (scope === "owner") {
        return !bindings.size && OWNER_FACETS.includes(record.facet);
      }
      const key = scope.startsWith("entity:") ? scope.slice(7) : scope;
      return bindings.has(key);
    })
    .map((record) => ({ record, score: score(record) }))
    .filter((entry) => entry.score >= threshold)
    .sort((a, b) => b.score - a.score || String(b.record.at).localeCompare(String(a.record.at)) || a.record.id.localeCompare(b.record.id))
    .map((entry) => entry.record);
}

function score(record) {
  const importance = record.importance ?? 0.5;
  const usage = 0.15 * Math.log2(1 + (record.hits ?? 0));
  const kind = ["decision", "preference", "identity"].includes(record.facet) ? 0.2 : 0;
  return importance * (0.7 + 0.3 * (record.confidence ?? 0.6)) + usage + kind;
}

function line(record) {
  const body = String(record.body ?? "").split(/\r?\n/).find((entry) => entry.trim())?.trim() ?? "";
  const detail = body && body !== record.title ? " — " + body.slice(0, 120) : "";
  return "- " + String(record.title).slice(0, 160) + detail + " [" + record.id + "]";
}

function fit(lines, cap) {
  const kept = [];
  let size = 0;
  for (const entry of lines) {
    const cost = entry.length + (kept.length ? 1 : 0);
    if (size + cost > cap) {
      continue;
    }
    kept.push(entry);
    size += cost;
  }
  return kept;
}
