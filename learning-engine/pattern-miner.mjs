import { jaccard, slugify, uniqueTokens } from "../lib/text.mjs";

const DAY = 24 * 60 * 60 * 1000;

export const DEFAULT_THRESHOLDS = {
  minOccurrences: 3,
  minDistinctDays: 2,
  minSuccessRate: 0.6,
  similarity: 0.5,
  requiredStepShare: 0.6,
  optionalStepShare: 0.3
};

function stepKey(step) {
  return (step.tool ? step.tool + ":" : "") + normalizeAction(step.action);
}

function normalizeAction(action) {
  return String(action ?? "")
    .replace(/[0-9]{2,}/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 90);
}

/**
 * Group episodes into work patterns. Exact signatures are merged first, then
 * near neighbours are folded in by token overlap, so the same job described
 * three different ways still lands in one pattern.
 */
export function cluster(episodes, { similarity = DEFAULT_THRESHOLDS.similarity } = {}) {
  const bySignature = new Map();
  for (const episode of episodes) {
    const bucket = bySignature.get(episode.signature) ?? [];
    bucket.push(episode);
    bySignature.set(episode.signature, bucket);
  }
  const groups = [];
  for (const [signature, bucket] of [...bySignature.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const tokens = new Set(bucket.flatMap((episode) => episode.tokensOfTask ?? uniqueTokens(episode.task)));
    const host = groups.find(
      (group) =>
        group.domain === bucket[0].domain &&
        group.action === bucket[0].action &&
        jaccard([...group.tokens], [...tokens]) >= similarity
    );
    if (host) {
      host.episodes.push(...bucket);
      host.signatures.push(signature);
      for (const token of tokens) {
        host.tokens.add(token);
      }
      continue;
    }
    groups.push({
      signatures: [signature],
      domain: bucket[0].domain,
      action: bucket[0].action,
      tokens,
      episodes: [...bucket]
    });
  }
  return groups;
}

/**
 * Derive the canonical procedure of a pattern: the steps that appear in most
 * runs, in the order they usually appear, plus the ones that are optional.
 */
export function canonicalProcedure(episodes, { requiredShare, optionalShare }) {
  const total = episodes.length;
  const stats = new Map();
  for (const episode of episodes) {
    const seen = new Set();
    (episode.steps ?? []).forEach((step, position) => {
      const key = stepKey(step);
      if (!key || seen.has(key)) {
        return;
      }
      seen.add(key);
      const entry = stats.get(key) ?? { key, label: step.action, tool: step.tool ?? null, count: 0, positions: [] };
      entry.count += 1;
      entry.positions.push(position / Math.max(1, (episode.steps ?? []).length - 1 || 1));
      stats.set(key, entry);
    });
  }
  const steps = [...stats.values()]
    .map((entry) => ({
      label: entry.label,
      tool: entry.tool,
      share: Number((entry.count / total).toFixed(3)),
      position: median(entry.positions)
    }))
    .filter((entry) => entry.share >= optionalShare)
    .sort((a, b) => a.position - b.position || b.share - a.share)
    .map((entry, index) => ({ order: index + 1, ...entry, required: entry.share >= requiredShare }));
  return steps;
}

function median(values) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Failures are the most valuable part of a pattern: they become the guardrails
 * of the generated skill.
 */
export function guardrails(episodes) {
  const rails = [];
  for (const episode of episodes.filter((entry) => entry.outcome !== "done")) {
    if (episode.notes) {
      rails.push({ from: episode.id, outcome: episode.outcome, note: episode.notes.slice(0, 240) });
    }
  }
  return rails.slice(0, 12);
}

function stability(episodes) {
  const sequences = episodes.map((episode) => (episode.steps ?? []).map(stepKey).join(">"));
  if (sequences.length < 2) {
    return 0.5;
  }
  let matches = 0;
  let pairs = 0;
  for (let left = 0; left < sequences.length; left += 1) {
    for (let right = left + 1; right < sequences.length; right += 1) {
      pairs += 1;
      matches += jaccard(sequences[left].split(">"), sequences[right].split(">"));
    }
  }
  return pairs ? Number((matches / pairs).toFixed(3)) : 0.5;
}

/**
 * Turn clusters into skill candidates with everything a forge needs: name,
 * keywords, procedure, guardrails, evidence and a confidence score.
 */
export function mine(episodes, options = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options };
  const groups = cluster(episodes, thresholds);
  const candidates = [];
  for (const group of groups) {
    const runs = group.episodes;
    const days = new Set(runs.map((episode) => String(episode.at).slice(0, 10)));
    const successes = runs.filter((episode) => episode.outcome === "done").length;
    const successRate = runs.length ? successes / runs.length : 0;
    const procedure = canonicalProcedure(runs, {
      requiredShare: thresholds.requiredStepShare,
      optionalShare: thresholds.optionalStepShare
    });
    const consistency = stability(runs);
    const totalDuration = runs.reduce((sum, episode) => sum + (episode.durationMs ?? 0), 0);
    const totalTokens = runs.reduce((sum, episode) => sum + (episode.tokens ?? 0), 0);
    const span = spanDays(runs);
    const keywords = [...group.tokens].slice(0, 12);
    const title = buildTitle(group, keywords);
    const confidence = Number(
      Math.min(
        0.98,
        0.25 * Math.min(1, runs.length / 6) +
          0.3 * successRate +
          0.25 * consistency +
          0.1 * Math.min(1, days.size / 4) +
          0.1 * Math.min(1, procedure.length / 5)
      ).toFixed(3)
    );
    const qualifies =
      runs.length >= thresholds.minOccurrences &&
      days.size >= thresholds.minDistinctDays &&
      successRate >= thresholds.minSuccessRate &&
      procedure.length >= 2;
    candidates.push({
      id: slugify(group.domain + "-" + group.action + "-" + keywords.slice(0, 3).join("-"), { fallback: "learned-skill" }),
      title,
      domain: group.domain,
      action: group.action,
      signatures: group.signatures,
      keywords,
      occurrences: runs.length,
      distinctDays: days.size,
      spanDays: span,
      successRate: Number(successRate.toFixed(3)),
      stability: consistency,
      procedure,
      guardrails: guardrails(runs),
      episodes: runs.map((episode) => episode.id),
      samples: runs.slice(-3).map((episode) => ({ id: episode.id, task: episode.task, outcome: episode.outcome, artifacts: episode.artifacts })),
      impact: {
        totalDurationMs: totalDuration,
        avgDurationMs: runs.length ? Math.round(totalDuration / runs.length) : 0,
        totalTokens,
        avgTokens: runs.length ? Math.round(totalTokens / runs.length) : 0,
        perMonth: span > 0 ? Number((runs.length / Math.max(1, span / 30)).toFixed(2)) : runs.length
      },
      confidence,
      qualifies
    });
  }
  return candidates.sort((a, b) => Number(b.qualifies) - Number(a.qualifies) || b.confidence - a.confidence || b.occurrences - a.occurrences);
}

function spanDays(episodes) {
  const times = episodes.map((episode) => new Date(episode.at).getTime()).sort((a, b) => a - b);
  if (times.length < 2) {
    return 0;
  }
  return Number(((times[times.length - 1] - times[0]) / DAY).toFixed(1));
}

function buildTitle(group, keywords) {
  const label = {
    review: "Review", build: "Build", fix: "Fix", report: "Report", file: "File", analyze: "Analyze",
    extract: "Extract", close: "Close", draft: "Draft", deploy: "Deploy", monitor: "Monitor", handle: "Handle"
  }[group.action] ?? "Handle";
  const subject = keywords.slice(0, 3).join(" ");
  return label + " " + (subject || group.domain);
}
