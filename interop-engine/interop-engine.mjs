import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { hashId, redactSecrets } from "../lib/text.mjs";

/**
 * Runtime interoperability: one contract, one memory, one journal.
 *
 * Claude Code and Codex read different files, register tools in different
 * places and keep different private memories. This engine generates the
 * runtime-specific wiring from a single source of truth so both runtimes load
 * the same operating contract (AGENTS.md), reach the same tools (the astack
 * MCP server), start every session from the same state (the session-start
 * hook) and leave a trace the other runtime can continue from (the journal).
 */

export const MCP_SERVER_ID = "astack";
const HOOK_MARKER = "interop hook";
const TOML_BEGIN = "# >>> astack (managed by `astack interop sync`) >>>";
const TOML_END = "# <<< astack <<<";
const CLAUDE_IMPORT = "@AGENTS.md";

export const runtimeSurfaces = {
  "claude-code": {
    name: "Claude Code",
    instructions: "CLAUDE.md",
    mcp: ".mcp.json",
    hooks: ".claude/settings.json",
    privateMemory: "~/.claude/projects/<workspace>/memory (imported at session start)"
  },
  codex: {
    name: "Codex",
    instructions: "AGENTS.md",
    mcp: ".codex/config.toml",
    hooks: ".codex/hooks.json",
    privateMemory: "~/.codex memories (opaque store, not imported; write to AStack memory instead)"
  }
};

const IMPORT_FACETS = {
  user: "identity",
  feedback: "preference",
  project: "project",
  reference: "semantic"
};

function readJson(path, fallback) {
  if (!existsSync(path)) {
    return fallback;
  }
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  if (!text.trim()) {
    return fallback;
  }
  return JSON.parse(text);
}

function json(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function contractHash(text) {
  return hashId(text.replace(/\r\n/g, "\n")).slice(0, 16);
}

export function detectRuntime(env = process.env) {
  if (env.ASTACK_RUNTIME) {
    return env.ASTACK_RUNTIME;
  }
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_PROJECT_DIR) {
    return "claude-code";
  }
  if (Object.keys(env).some((key) => key.startsWith("CODEX_"))) {
    return "codex";
  }
  return "unknown";
}

/**
 * Claude Code stores per-project data under a directory named after the
 * project path with every non alphanumeric character replaced by "-". Drive
 * letter case differs between launches on Windows, so match case-insensitively.
 */
export function claudeProjectSlug(path) {
  return String(path).replace(/[^a-zA-Z0-9]/g, "-");
}

function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^\uFEFF/, ""));
  if (!match) {
    return { data: {}, body: text.trim() };
  }
  const data = {};
  let section = data;
  for (const line of match[1].split(/\r?\n/)) {
    const nested = /^\s+([\w-]+):\s*(.*)$/.exec(line);
    const top = /^([\w-]+):\s*(.*)$/.exec(line);
    if (top) {
      const value = top[2].trim().replace(/^["']|["']$/g, "");
      if (value) {
        data[top[1]] = value;
        section = data;
      } else {
        data[top[1]] = {};
        section = data[top[1]];
      }
    } else if (nested && section !== data) {
      section[nested[1]] = nested[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return { data, body: match[2].trim() };
}

export class InteropEngine {
  constructor(root, { workspaceRoot = root, memory = null, standup = null, graphify = null, clock, home = homedir(), env = process.env } = {}) {
    this.root = root;
    this.graphify = graphify;
    this.workspaceRoot = workspaceRoot;
    this.memory = memory;
    this.standupProvider = standup;
    this.clock = clock ?? (() => new Date());
    this.home = home;
    this.env = env;
    this.directory = join(workspaceRoot, ".astack", "interop");
    this.journalPath = join(this.directory, "journal.jsonl");
  }

  now() {
    return this.clock().toISOString();
  }

  path(...segments) {
    return join(this.workspaceRoot, ...segments);
  }

  /** The command a runtime launches to reach this core, relative to the workspace root. */
  cli() {
    const bin = relative(this.workspaceRoot, join(this.root, "bin", "astack.mjs")).split("\\").join("/");
    return bin || "bin/astack.mjs";
  }

  contract() {
    const path = this.path("AGENTS.md");
    if (!existsSync(path)) {
      return { present: false, hash: null, bytes: 0 };
    }
    const text = readFileSync(path, "utf8");
    return { present: true, hash: contractHash(text), bytes: Buffer.byteLength(text) };
  }

  // ---------------------------------------------------------------- wiring

  claudeHookCommand(event) {
    return "node \"$CLAUDE_PROJECT_DIR/" + this.cli() + "\" " + HOOK_MARKER + " " + event + " --runtime claude-code";
  }

  codexHookCommand(event) {
    return "node " + this.cli() + " " + HOOK_MARKER + " " + event + " --runtime codex";
  }

  mcpServer() {
    return { command: "node", args: [this.cli(), "mcp", "serve"] };
  }

  plannedClaudeInstructions(current) {
    if (current === null) {
      return [
        "# Claude Code Operating Guide",
        "",
        "Claude Code and Codex share one operating contract: `AGENTS.md`.",
        "",
        CLAUDE_IMPORT,
        ""
      ].join("\n");
    }
    if (current.split(/\r?\n/).some((line) => line.trim() === CLAUDE_IMPORT)) {
      return current;
    }
    const lines = current.split(/\r?\n/);
    const heading = lines.findIndex((line) => line.startsWith("# "));
    const insertAt = heading === -1 ? 0 : heading + 1;
    lines.splice(insertAt, 0, "", "The shared operating contract for Claude Code and Codex lives in `AGENTS.md`:", "", CLAUDE_IMPORT, "");
    return lines.join("\n");
  }

  plannedMcpJson(current) {
    const next = current ?? {};
    next.mcpServers = { ...(next.mcpServers ?? {}), [MCP_SERVER_ID]: { type: "stdio", ...this.mcpServer() } };
    return next;
  }

  mergeHooks(hooks, event, entry) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = groups
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !String(hook.command ?? "").includes(HOOK_MARKER)) }))
      .filter((group) => group.hooks.length);
    return [...kept, entry];
  }

  plannedClaudeSettings(current) {
    const next = current ?? {};
    const hooks = { ...(next.hooks ?? {}) };
    hooks.SessionStart = this.mergeHooks(hooks, "SessionStart", {
      matcher: "startup|resume|clear|compact",
      hooks: [{ type: "command", command: this.claudeHookCommand("session-start"), timeout: 30 }]
    });
    hooks.SessionEnd = this.mergeHooks(hooks, "SessionEnd", {
      hooks: [{ type: "command", command: this.claudeHookCommand("session-end"), timeout: 30 }]
    });
    next.hooks = hooks;
    next.enabledMcpjsonServers = [...new Set([...(next.enabledMcpjsonServers ?? []), MCP_SERVER_ID])];
    const permissions = next.permissions ?? {};
    next.permissions = { ...permissions, allow: [...new Set([...(permissions.allow ?? []), "mcp__" + MCP_SERVER_ID])] };
    return next;
  }

  plannedCodexHooks(current) {
    const next = current ?? {};
    const hooks = { ...(next.hooks ?? {}) };
    hooks.SessionStart = this.mergeHooks(hooks, "SessionStart", {
      matcher: "startup|resume",
      hooks: [
        {
          type: "command",
          command: this.codexHookCommand("session-start"),
          statusMessage: "Loading the AStack shared brain",
          additionalContextLimit: 4000
        }
      ]
    });
    hooks.SessionEnd = this.mergeHooks(hooks, "SessionEnd", {
      hooks: [{ type: "command", command: this.codexHookCommand("session-end") }]
    });
    next.hooks = hooks;
    return next;
  }

  plannedCodexConfig(current) {
    const server = this.mcpServer();
    const block = [
      TOML_BEGIN,
      "[mcp_servers." + MCP_SERVER_ID + "]",
      "command = " + JSON.stringify(server.command),
      "args = [" + server.args.map((argument) => JSON.stringify(argument)).join(", ") + "]",
      "startup_timeout_sec = 30",
      // Every astack tool is a local CLI call already bound by the AStack trust
      // rules, so Codex runs it the way Claude Code does once mcp__astack is allowed.
      "default_tools_approval_mode = \"approve\"",
      TOML_END
    ].join("\n");
    if (current === null) {
      return block + "\n";
    }
    const begin = current.indexOf(TOML_BEGIN);
    const end = current.indexOf(TOML_END);
    if (begin !== -1 && end > begin) {
      return current.slice(0, begin) + block + current.slice(end + TOML_END.length);
    }
    if (/^\s*\[mcp_servers\.astack\]\s*$/m.test(current)) {
      // An owner-written entry for the same server wins; never declare it twice.
      return current;
    }
    return current.replace(/\s*$/, "") + (current.trim() ? "\n\n" : "") + block + "\n";
  }

  /**
   * Every file a runtime needs, with the action `sync` would take on it.
   * Owner content in these files is merged, never discarded.
   */
  plan() {
    const files = [
      { runtime: "claude-code", path: "CLAUDE.md", kind: "text", build: (current) => this.plannedClaudeInstructions(current) },
      { runtime: "claude-code", path: ".mcp.json", kind: "json", build: (current) => this.plannedMcpJson(current) },
      { runtime: "claude-code", path: ".claude/settings.json", kind: "json", build: (current) => this.plannedClaudeSettings(current) },
      { runtime: "codex", path: ".codex/config.toml", kind: "text", build: (current) => this.plannedCodexConfig(current) },
      { runtime: "codex", path: ".codex/hooks.json", kind: "json", build: (current) => this.plannedCodexHooks(current) }
    ];
    return files.map((file) => {
      const absolute = this.path(file.path);
      const exists = existsSync(absolute);
      const before = exists ? readFileSync(absolute, "utf8") : null;
      let content;
      if (file.kind === "json") {
        let parsed;
        try {
          parsed = exists ? readJson(absolute, {}) : null;
        } catch (error) {
          // A malformed owner file is reported, never overwritten.
          return { runtime: file.runtime, path: file.path, action: "invalid", error: error.message, content: null };
        }
        content = json(file.build(parsed === null ? null : structuredClone(parsed)));
      } else {
        content = file.build(before);
      }
      const same = before !== null && before.replace(/\r\n/g, "\n") === content.replace(/\r\n/g, "\n");
      return { runtime: file.runtime, path: file.path, action: !exists ? "create" : same ? "ok" : "update", content };
    });
  }

  sync({ dryRun = false } = {}) {
    if (!this.contract().present) {
      throw new Error("AGENTS.md is missing: the shared contract must exist before the runtimes can be wired to it");
    }
    const plan = this.plan();
    if (!dryRun) {
      for (const entry of plan) {
        if (entry.action === "ok" || entry.action === "invalid") {
          continue;
        }
        const absolute = this.path(entry.path);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, entry.content, "utf8");
      }
    }
    return plan.map(({ runtime, path, action }) => ({ runtime, path, action }));
  }

  // ---------------------------------------------------------------- codex trust

  codexConfigPath() {
    return join(this.home, ".codex", "config.toml");
  }

  codexTrustKey() {
    const path = this.workspaceRoot;
    return process.platform === "win32" ? path.toLowerCase() : path;
  }

  codexTrust() {
    const path = this.codexConfigPath();
    if (!existsSync(path)) {
      return { installed: false, trusted: false, key: this.codexTrustKey() };
    }
    const text = readFileSync(path, "utf8");
    const key = this.codexTrustKey().toLowerCase();
    let inSection = false;
    for (const line of text.split(/\r?\n/)) {
      const header = /^\s*\[projects\.(['"])(.*)\1\]\s*$/.exec(line);
      if (header) {
        inSection = header[2].replace(/\\\\/g, "\\").toLowerCase() === key;
        continue;
      }
      if (/^\s*\[/.test(line)) {
        inSection = false;
      }
      if (inSection && /^\s*trust_level\s*=\s*["']trusted["']/.test(line)) {
        return { installed: true, trusted: true, key: this.codexTrustKey() };
      }
    }
    return { installed: true, trusted: false, key: this.codexTrustKey() };
  }

  /**
   * Codex ignores a project's .codex/ layer (config, hooks, MCP servers) until
   * the project is trusted in the user's own config. This edits a file outside
   * the workspace, so it only runs when the owner asks for it, and keeps a backup.
   */
  trustCodex() {
    const state = this.codexTrust();
    if (state.trusted) {
      return { ...state, changed: false, backup: null };
    }
    const path = this.codexConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    let backup = null;
    let text = "";
    if (existsSync(path)) {
      text = readFileSync(path, "utf8");
      backup = path + ".astack-backup";
      copyFileSync(path, backup);
    }
    const section = "[projects.'" + state.key + "']\ntrust_level = \"trusted\"\n";
    writeFileSync(path, text.replace(/\s*$/, "") + (text.trim() ? "\n\n" : "") + section, "utf8");
    return { installed: true, trusted: true, key: state.key, changed: true, backup };
  }

  // ---------------------------------------------------------------- journal

  record(entry) {
    mkdirSync(this.directory, { recursive: true });
    const record = { at: this.now(), ...entry };
    appendFileSync(this.journalPath, JSON.stringify(record) + "\n", "utf8");
    return record;
  }

  journal({ limit = 20, runtime = null, kind = null } = {}) {
    if (!existsSync(this.journalPath)) {
      return [];
    }
    const entries = [];
    for (const line of readFileSync(this.journalPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        entries.push(JSON.parse(line));
      } catch {
        // A torn final line from an interrupted write is skipped, not fatal.
      }
    }
    return entries
      .filter((entry) => (!runtime || entry.runtime === runtime) && (!kind || entry.kind === kind))
      .slice(-limit)
      .reverse();
  }

  git(args) {
    try {
      return execFileSync("git", args, { cwd: this.workspaceRoot, encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  }

  workspaceState() {
    const status = this.git(["status", "--porcelain"]);
    const changed = status === null ? null : status.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3));
    return {
      branch: this.git(["rev-parse", "--abbrev-ref", "HEAD"]),
      head: this.git(["rev-parse", "--short", "HEAD"]),
      changedFiles: changed === null ? null : changed.length,
      sample: changed === null ? [] : changed.slice(0, 8)
    };
  }

  /**
   * A structured handoff: the only thing one runtime passes to the other. It
   * goes to the journal for the next session-start and to episodic memory so
   * recall finds it later.
   */
  handoff({ runtime = detectRuntime(this.env), summary, done = "", findings = [], openQuestions = [], next = "", artifacts = [], project = null }) {
    const text = String(summary ?? "").trim();
    if (!text) {
      throw new Error("A handoff needs a summary");
    }
    const packet = {
      kind: "handoff",
      runtime,
      summary: redactSecrets(text),
      whatWasDone: redactSecrets(done),
      findings: findings.map((item) => redactSecrets(item)),
      artifacts,
      openQuestions: openQuestions.map((item) => redactSecrets(item)),
      recommendedNextStep: redactSecrets(next),
      project,
      workspace: this.workspaceState()
    };
    const record = this.record(packet);
    let memoryId = null;
    if (this.memory) {
      const body = [
        packet.whatWasDone && "Done: " + packet.whatWasDone,
        packet.findings.length && "Findings: " + packet.findings.join("; "),
        packet.openQuestions.length && "Open: " + packet.openQuestions.join("; "),
        packet.recommendedNextStep && "Next: " + packet.recommendedNextStep
      ]
        .filter(Boolean)
        .join("\n");
      memoryId = this.memory.remember("episodic", {
        title: "[" + runtime + " handoff] " + packet.summary,
        body,
        project,
        tags: ["handoff", runtime],
        source: runtime,
        importance: 0.7
      }).id;
    }
    return { ...record, memoryId };
  }

  // ---------------------------------------------------------------- claude memory import

  claudeMemoryDirectory() {
    const projects = join(this.home, ".claude", "projects");
    if (!existsSync(projects)) {
      return null;
    }
    const wanted = claudeProjectSlug(this.workspaceRoot).toLowerCase();
    const match = readdirSync(projects).find((name) => name.toLowerCase() === wanted);
    if (!match) {
      return null;
    }
    const directory = join(projects, match, "memory");
    return existsSync(directory) ? directory : null;
  }

  /**
   * Claude Code keeps an auto-memory per project as one markdown file per fact.
   * Each file becomes one record in the shared store, so Codex recalls it too.
   * A changed file supersedes its earlier record instead of piling up copies.
   */
  importClaudeMemory() {
    const directory = this.claudeMemoryDirectory();
    if (!directory) {
      return { directory: null, imported: 0, updated: 0, unchanged: 0, skipped: 0 };
    }
    if (!this.memory) {
      throw new Error("The memory engine is required to import Claude Code memory");
    }
    const statePath = join(this.directory, "claude-memory.json");
    const state = readJson(statePath, { files: {} });
    const report = { directory, imported: 0, updated: 0, unchanged: 0, skipped: 0 };
    for (const name of readdirSync(directory).sort()) {
      if (!name.endsWith(".md") || name === "MEMORY.md" || !statSync(join(directory, name)).isFile()) {
        continue;
      }
      const text = readFileSync(join(directory, name), "utf8");
      const digest = hashId(text).slice(0, 16);
      const previous = state.files[name];
      if (previous?.digest === digest) {
        report.unchanged += 1;
        continue;
      }
      const { data, body } = parseFrontmatter(text);
      const type = data.metadata?.type ?? data.type ?? "reference";
      const title = String(data.description ?? data.name ?? name.replace(/\.md$/, "")).trim();
      const content = redactSecrets(body);
      if (!title && !content) {
        report.skipped += 1;
        continue;
      }
      const facet = IMPORT_FACETS[type] ?? "semantic";
      const entry = {
        title: redactSecrets(title),
        body: content,
        tags: ["claude-code-memory", type],
        refs: ["claude-memory:" + name],
        source: "claude-code-memory",
        meta: { file: name, name: data.name ?? null, type }
      };
      let record;
      if (previous?.id && this.memory.facets.get(previous.id) && !this.memory.facets.get(previous.id).supersededBy) {
        record = this.memory.facets.supersede(previous.id, entry).replacement;
        report.updated += 1;
      } else {
        record = this.memory.remember(facet, entry);
        report.imported += 1;
      }
      state.files[name] = { digest, id: record.id, at: this.now() };
    }
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(statePath, json(state), "utf8");
    return report;
  }

  // ---------------------------------------------------------------- hooks

  /**
   * The context both runtimes receive before their first turn. It is built
   * from the same sources for both, so they start from the same state.
   */
  sessionContext({ runtime, budget = 1400 } = {}) {
    const lines = ["# AStack shared brain", ""];
    const contract = this.contract();
    lines.push("Runtime: " + (runtimeSurfaces[runtime]?.name ?? runtime) + " · contract AGENTS.md#" + (contract.hash ?? "missing") + " (shared by Claude Code and Codex)");
    const graphLine = this.graphifyLine();
    if (graphLine) {
      lines.push(graphLine);
    }
    const recent = this.journal({ limit: 6 }).filter((entry) => entry.kind === "handoff" || entry.kind === "session-end");
    if (recent.length) {
      lines.push("", "## Recent work (both runtimes, newest first)");
      for (const entry of recent) {
        const when = String(entry.at).slice(0, 16).replace("T", " ");
        if (entry.kind === "handoff") {
          lines.push("- " + when + " " + entry.runtime + " handoff: " + entry.summary + (entry.recommendedNextStep ? " → next: " + entry.recommendedNextStep : ""));
        } else {
          const files = entry.workspace?.changedFiles;
          lines.push("- " + when + " " + entry.runtime + " session ended on " + (entry.workspace?.branch ?? "?") + "@" + (entry.workspace?.head ?? "?") + (files ? ", " + files + " uncommitted files" : ""));
        }
      }
    }
    if (this.standupProvider) {
      try {
        const standup = this.standupProvider();
        if (standup?.capsule?.lines?.length) {
          lines.push("", "## Owner");
          lines.push(...standup.capsule.lines);
        }
        if (standup?.missions?.active || standup?.missions?.waitingApproval) {
          lines.push("", "## Open work");
          lines.push("- missions active " + standup.missions.active + ", waiting approval " + standup.missions.waitingApproval);
        }
        if (standup?.pendingApprovals?.length) {
          lines.push("- pending approvals: " + standup.pendingApprovals.map((approval) => approval.id).join(", "));
        }
      } catch (error) {
        lines.push("", "(standup unavailable: " + error.message + ")");
      }
    }
    if (this.memory) {
      const brief = this.memory.brief({ query: "", budget: Math.round(budget / 2), limit: 12 });
      if (brief.lines.length) {
        lines.push("", "## Memory brief (" + brief.rendered + " of " + brief.considered + "; `astack memory search` for more)");
        lines.push(...brief.lines);
      }
    }
    lines.push(
      "",
      "Rules: durable knowledge goes to the shared store (`astack memory remember` or MCP astack_memory_remember); finish substantial work with `astack interop handoff \"<summary>\" --next \"...\"`."
    );
    return lines.join("\n");
  }

  graphifyLine() {
    try {
      return this.graphify?.contextLine() ?? null;
    } catch {
      return null;
    }
  }

  sessionStart({ runtime, payload = {} } = {}) {
    let imported = null;
    if (runtime === "claude-code" && this.memory) {
      try {
        imported = this.importClaudeMemory();
      } catch {
        imported = null;
      }
    }
    this.record({ kind: "session-start", runtime, session: payload.session_id ?? null, source: payload.source ?? null, model: payload.model ?? null });
    const context = this.sessionContext({ runtime });
    return {
      imported,
      output: { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }
    };
  }

  sessionEnd({ runtime, payload = {} } = {}) {
    return this.record({
      kind: "session-end",
      runtime,
      session: payload.session_id ?? null,
      reason: payload.reason ?? null,
      workspace: this.workspaceState()
    });
  }

  // ---------------------------------------------------------------- status

  status() {
    const contract = this.contract();
    const plan = this.plan();
    const pending = plan.filter((entry) => entry.action !== "ok");
    const claudeMd = existsSync(this.path("CLAUDE.md")) ? readFileSync(this.path("CLAUDE.md"), "utf8") : "";
    const runtimes = {
      "claude-code": {
        instructions: claudeMd.split(/\r?\n/).some((line) => line.trim() === CLAUDE_IMPORT),
        wired: !pending.some((entry) => entry.runtime === "claude-code"),
        privateMemory: this.claudeMemoryDirectory()
      },
      codex: {
        instructions: contract.present,
        wired: !pending.some((entry) => entry.runtime === "codex"),
        trust: this.codexTrust()
      }
    };
    const last = (runtime) => this.journal({ limit: 1, runtime })[0] ?? null;
    return {
      contract,
      sharedMemory: ".astack/memory",
      journal: { path: ".astack/interop/journal.jsonl", entries: this.journal({ limit: Number.MAX_SAFE_INTEGER }).length },
      runtimes,
      lastSeen: { "claude-code": last("claude-code"), codex: last("codex") },
      pending: pending.map(({ runtime, path, action }) => ({ runtime, path, action })),
      parity: runtimes["claude-code"].instructions && runtimes.codex.instructions && !pending.length
    };
  }
}
