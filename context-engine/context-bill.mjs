import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { estimateTokens } from "../lib/text.mjs";

export const DEFAULT_ALWAYS_ON_BUDGET = 15000;

/**
 * The context bill (3.5.0; idea from gstack's context-bill, MIT, © 2026 Garry
 * Tan): what every session pays before the first question — the contract and
 * instructions, the session-start brief, the MCP tool definitions and the
 * skill listings — measured, itemised and held against a budget, so growth in
 * always-loaded text is seen before it costs every conversation.
 */
export function contextBill({ projectRoot, interop = null, mcpTools = [], home = homedir(), budget = DEFAULT_ALWAYS_ON_BUDGET } = {}) {
  const items = [];
  const add = (group, name, text, note = null) => {
    if (text === null || text === undefined) {
      return;
    }
    items.push({ group, name, tokens: estimateTokens(String(text)), note });
  };
  const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);

  add("instructions", "AGENTS.md (shared contract)", read(join(projectRoot, "AGENTS.md")));
  add("instructions", "CLAUDE.md", read(join(projectRoot, "CLAUDE.md")));
  try {
    add("session start", "session-start brief", interop?.sessionContext?.({ runtime: "claude-code" }) ?? null);
  } catch {
    // An unavailable standup is reported by the session itself.
  }
  if (mcpTools.length) {
    add("tools", "astack MCP server (" + mcpTools.length + " tools)", JSON.stringify(mcpTools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))));
  }
  const browserTools = join(projectRoot, ".astack", "browser", "dedicated", "tools.json");
  if (existsSync(browserTools)) {
    try {
      const cached = JSON.parse(readFileSync(browserTools, "utf8"));
      items.push({ group: "tools", name: "browser MCP server (" + cached.count + " tools)", tokens: cached.tokens, note: "measured " + cached.at });
    } catch {
      // A torn cache is measured again on the next tools/list.
    }
  } else {
    items.push({ group: "tools", name: "browser MCP server", tokens: 0, note: "not measured yet (opens on first use)" });
  }
  for (const [label, dir] of [["project skills", join(projectRoot, ".claude", "skills")], ["global skills", join(home, ".claude", "skills")]]) {
    const listing = skillListing(dir);
    if (listing.count) {
      add("skills", label + " (" + listing.count + ")", listing.text);
    }
  }
  const total = items.reduce((sum, item) => sum + item.tokens, 0);
  return {
    items: items.sort((a, b) => b.tokens - a.tokens),
    total,
    budget,
    overBudget: total > budget,
    note: "Always-on cost per session, before the first question. Codex loads MCP tool definitions up front; Claude Code may defer them until a tool is searched for. Per-call costs (recall, maps, tool results) are measured by `astack context stats`."
  };
}

/** Only a skill's name and description are always loaded; the body is not. */
function skillListing(dir) {
  if (!existsSync(dir)) {
    return { count: 0, text: "" };
  }
  const lines = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name, "SKILL.md");
    if (!entry.isDirectory() || !existsSync(path)) {
      continue;
    }
    const head = readFileSync(path, "utf8").slice(0, 3000);
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(head.replace(/\r\n/g, "\n"))?.[1] ?? "";
    lines.push(entry.name + ": " + (/description:\s*(.+)/.exec(frontmatter)?.[1] ?? ""));
  }
  return { count: lines.length, text: lines.join("\n") };
}
