import { estimateTokens, uniqueTokens } from "../lib/text.mjs";
import { rankMembers } from "./ranking.mjs";

const TIERS = { deep: 3, outline: 2, path: 1 };

function humanSize(bytes) {
  if (bytes >= 1048576) {
    return (bytes / 1048576).toFixed(1) + "MB";
  }
  if (bytes >= 1024) {
    return Math.round(bytes / 1024) + "KB";
  }
  return bytes + "B";
}

function humanTokens(count) {
  if (count >= 1000000) {
    return (count / 1000000).toFixed(1) + "M";
  }
  if (count >= 1000) {
    return (count / 1000).toFixed(1) + "k";
  }
  return String(count);
}

function signalSummary(entry, limit = 3) {
  const linking = (entry.signals ?? []).filter((signal) => signal.linking);
  const rest = (entry.signals ?? []).filter((signal) => !signal.linking);
  return [...linking, ...rest]
    .slice(0, limit)
    .map((signal) => signal.type + "=" + signal.value)
    .join(" ");
}

function fileHeadline(item) {
  const entry = item.entry;
  const facts = [];
  if (entry.opaque) {
    facts.push(entry.language === "unknown" ? "opaque" : entry.language + " opaque");
    facts.push(humanSize(entry.size));
  } else if (entry.oversized) {
    facts.push(entry.language, humanSize(entry.size), "not parsed");
  } else {
    facts.push(entry.language);
    if (entry.lines) {
      facts.push(entry.lines + "L");
    }
  }
  const signals = signalSummary(entry);
  const title = entry.title ? " " + String.fromCharCode(171) + entry.title.slice(0, 60) + String.fromCharCode(187) : "";
  return "[" + facts.filter(Boolean).join(" ") + "]" + title + (signals ? "  " + signals : "");
}

function memberLine(members, queryTokens, limit) {
  return rankMembers({ symbols: members.symbols, headings: members.headings }, queryTokens)
    .slice(0, limit)
    .map((member) => (member.type === "heading" ? "#" : abbreviate(member.kind)) + " " + member.name + ":" + member.line)
    .join(" · ");
}

function abbreviate(kind) {
  return { function: "fn", const: "const", class: "class", method: "m", type: "type", table: "tbl", view: "view", key: "k", section: "s", column: "col", record: "rec", interface: "iface" }[kind] ?? kind;
}

/**
 * Render the ranked workspace into a map that fits a token budget.
 *
 * Three levels of detail are used: deep (members with line anchors), outline
 * (one headline per file) and path (grouped folder listing). Whatever does not
 * fit is reported as an explicit omission with the command that reveals it, so
 * the reader always knows the map is an index and never mistakes it for the
 * whole corpus.
 */
export function renderMap({
  index,
  ranked,
  graph,
  query = "",
  domain = null,
  budget = 4000,
  deepRatio = 0.16,
  outlineRatio = 0.45,
  maxMembers = 8,
  freshness = null,
  extraSections = []
} = {}) {
  const queryTokens = uniqueTokens(query);
  const corpusTokens = index.stats.corpusTokens ?? 0;
  const deepCount = Math.min(30, Math.max(3, Math.round(ranked.length * deepRatio), Math.round(budget / 240)));
  const outlineCount = Math.min(120, Math.max(deepCount, Math.round(ranked.length * outlineRatio), Math.round(budget / 70)));
  const header = [];
  header.push("# AStack Context Map");
  header.push(
    "scope=" + (index.root.split("/").pop() || index.root) +
    " | domain=" + (domain ?? "-") +
    " | files=" + index.stats.files +
    " | symbols=" + index.stats.symbols +
    " | signals=" + index.stats.signals +
    " | corpus=" + humanTokens(corpusTokens) + " tok"
  );
  if (freshness) {
    header.push("freshness=" + (freshness.fresh ? "fresh" : "stale:" + (freshness.stale.length + freshness.added.length + freshness.missing.length) + " files") + " | built=" + index.builtAt);
  }
  if (query) {
    header.push("focus=" + JSON.stringify(query));
  }
  header.push("rule=this map is an index, not the corpus; open a path before you rely on its content");
  header.push("");

  const lines = [...header];
  let used = estimateTokens(header.join("\n"));
  const reserve = 220;
  const rendered = [];
  const omitted = [];
  const groups = new Map();

  for (let position = 0; position < ranked.length; position += 1) {
    const item = ranked[position];
    const tier = position < deepCount ? TIERS.deep : position < outlineCount ? TIERS.outline : TIERS.path;
    const folder = item.entry.folder === "." ? "" : item.entry.folder;
    const name = folder ? item.rel.slice(folder.length + 1) : item.rel;
    const body = [];
    if (tier === TIERS.deep) {
      body.push("- " + name + "  " + fileHeadline(item));
      const members = memberLine(item.entry, queryTokens, maxMembers);
      if (members) {
        body.push("    " + members);
      }
    } else if (tier === TIERS.outline) {
      body.push("- " + name + "  " + fileHeadline(item));
    } else {
      body.push("- " + name);
    }
    const headerCost = groups.has(folder) ? 0 : estimateTokens("## " + (folder || "(root)")) + 1;
    const cost = estimateTokens(body.join("\n")) + headerCost;
    if (used + cost + reserve > budget) {
      omitted.push(item);
      continue;
    }
    used += cost;
    const bucket = groups.get(folder) ?? [];
    bucket.push(body);
    groups.set(folder, bucket);
    rendered.push({ rel: item.rel, tier, score: item.score });
  }

  for (const [folder, bodies] of groups) {
    lines.push("");
    lines.push("## " + (folder || "(root)"));
    for (const body of bodies) {
      lines.push(...body);
    }
  }

  const clusters = (graph?.clusters ?? [])
    .slice()
    .sort((a, b) => b.members.length * b.weight - a.members.length * a.weight)
    .slice(0, 8);
  if (clusters.length) {
    const block = ["", "## links (shared records)"];
    for (const cluster of clusters) {
      block.push("- " + cluster.key + " -> " + cluster.members.length + " files: " + cluster.members.slice(0, 4).join(", ") + (cluster.members.length > 4 ? ", ..." : ""));
    }
    const cost = estimateTokens(block.join("\n"));
    if (used + cost + 120 <= budget) {
      lines.push(...block);
      used += cost;
    }
  }

  for (const section of extraSections) {
    if (!section?.lines?.length) {
      continue;
    }
    const block = ["", "## " + section.title, ...section.lines];
    const cost = estimateTokens(block.join("\n"));
    if (used + cost + 80 <= budget) {
      lines.push(...block);
      used += cost;
    }
  }

  const omittedSymbols = omitted.reduce((sum, item) => sum + (item.entry.symbols?.length ?? 0) + (item.entry.headings?.length ?? 0), 0);
  const omittedTokens = omitted.reduce((sum, item) => sum + (item.entry.tokens ?? 0), 0);
  const footer = ["", "## omitted"];
  footer.push(
    "- " + omitted.length + " files and " + omittedSymbols + " members are indexed but not printed (" + humanTokens(omittedTokens) + " tok)"
  );
  footer.push('- reveal with: astack context query "<terms>" | astack context expand <path> | astack context map --budget <n>');
  lines.push(...footer);
  used += estimateTokens(footer.join("\n"));

  const savings = corpusTokens > 0 ? Number((1 - used / corpusTokens).toFixed(4)) : 0;
  return {
    text: lines.join("\n") + "\n",
    tokens: used,
    budget,
    rendered,
    renderedCount: rendered.length,
    omittedCount: omitted.length,
    corpusTokens,
    savings
  };
}

/**
 * Full detail for a single file: every member with its line anchor plus the
 * graph neighbourhood. This is the zoom step that keeps precision intact.
 */
export function renderExpansion({ rel, entry, neighbours = [], clusters = [] }) {
  const lines = ["# " + rel];
  lines.push(
    "language=" + entry.language +
    " | category=" + entry.category +
    " | size=" + humanSize(entry.size) +
    " | lines=" + entry.lines +
    " | tokens=" + entry.tokens +
    " | modified=" + entry.mtime
  );
  if (entry.opaque) {
    lines.push("note=binary or office document; use the matching reader skill (pdf-deep-read, ocr, transcribe) to read it");
  }
  if (entry.title) {
    lines.push("title=" + entry.title);
  }
  if (entry.summary) {
    lines.push("summary=" + entry.summary);
  }
  if (entry.symbols?.length) {
    lines.push("", "## members");
    for (const symbol of entry.symbols) {
      lines.push("- " + abbreviate(symbol.kind) + " " + symbol.name + "  " + rel + ":" + symbol.line);
    }
  }
  if (entry.headings?.length) {
    lines.push("", "## outline");
    for (const heading of entry.headings) {
      lines.push("- " + "  ".repeat(Math.max(0, heading.level - 1)) + heading.text + "  " + rel + ":" + heading.line);
    }
  }
  if (entry.signals?.length) {
    lines.push("", "## records");
    for (const signal of entry.signals) {
      lines.push("- " + signal.type + "=" + signal.value + (signal.linking ? " (linking)" : ""));
    }
  }
  if (entry.imports?.length) {
    lines.push("", "## imports", "- " + entry.imports.join(", "));
  }
  if (neighbours.length) {
    lines.push("", "## neighbours");
    for (const neighbour of neighbours) {
      lines.push("- " + neighbour.rel + " (" + neighbour.kinds.join("/") + ", w=" + neighbour.weight.toFixed(2) + ")");
    }
  }
  if (clusters.length) {
    lines.push("", "## shared records");
    for (const cluster of clusters) {
      lines.push("- " + cluster.key + ": " + cluster.members.join(", "));
    }
  }
  const text = lines.join("\n") + "\n";
  return { text, tokens: estimateTokens(text) };
}

export { humanTokens, humanSize };
