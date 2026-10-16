import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { hashId, redactSecrets } from "../lib/text.mjs";
import { ConfigurationEngine } from "../configuration-engine/configuration.mjs";
import { importLegacyMemory } from "./memory-sources.mjs";

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
// The project's dedicated browser (Playwright MCP over CDP, 3.4.0). An entry
// with this name that does not run astack-browser-mcp is the owner's own and
// is never touched.
export const BROWSER_SERVER_ID = "astack-browser";
const BROWSER_MARKER = "astack-browser-mcp";
// A Playwright MCP server the owner already runs (for example "browser" on a
// shared CDP port) is the project's browser: AStack then adds none of its own,
// for Claude Code or Codex, so both runtimes stay on one window.
const PLAYWRIGHT_MARKER = /@playwright\/mcp|playwright-mcp/i;
// Browser tools that only look: allowed without a prompt. Clicking, typing,
// uploading and running code still ask, so a commit step always stops.
export const BROWSER_READ_TOOLS = [
  "browser_snapshot", "browser_take_screenshot", "browser_console_messages",
  "browser_network_requests", "browser_wait_for", "browser_navigate", "browser_navigate_back", "browser_resize"
];
const HOOK_MARKER = "interop hook";
const GUARD_MARKER = "astack-guard.mjs";
const TOML_BEGIN = "# >>> astack (managed by `astack interop sync`) >>>";
const TOML_END = "# <<< astack <<<";
const CLAUDE_IMPORT = "@AGENTS.md";
export const CONTRACT_SOURCE = "system/agent-contract.md";
const CONTRACT_BEGIN = "<!-- astack:contract:begin — managed by astack setup from system/agent-contract.md; project rules go outside this block -->";
const CONTRACT_END = "<!-- astack:contract:end -->";
// AGENTS.md as 2.2.0 shipped it, before the contract moved into a managed block.
const STOCK_CONTRACT_HASHES = new Set(["8ce3d5fbd21caf4e", "bd49495ccdf2d4dd"]);

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
  constructor(root, { workspaceRoot = root, projectRoot = null, legacyMemory = null, memory = null, standup = null, graphify = null, browser = null, guard = null, clock, home = homedir(), env = process.env } = {}) {
    this.root = root;
    this.browserConfig = browser ?? readDedicatedConfig(root);
    this.guardConfig = guard ?? readSection(root, "guard");
    this.graphify = graphify;
    this.workspaceRoot = workspaceRoot;
    // Where the runtimes are opened. Usually the install itself; for a core
    // embedded in a subfolder (interop.project_root), the folder above it.
    this.projectRoot = projectRoot ? resolve(workspaceRoot, projectRoot) : workspaceRoot;
    this.legacyMemory = legacyMemory;
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
    return join(this.projectRoot, ...segments);
  }

  /** The command a runtime launches to reach this core, relative to the workspace root. */
  cli() {
    const bin = relative(this.projectRoot, join(this.root, "bin", "astack.mjs")).split("\\").join("/");
    return bin || "bin/astack.mjs";
  }

  /** The contract text shipped with the core; AGENTS.md carries it as a managed block. */
  contractSource() {
    const path = join(this.root, CONTRACT_SOURCE);
    return existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n").trim() : null;
  }

  /**
   * AGENTS.md belongs to the project. The AStack contract lives in it between
   * two markers: the block is refreshed from the core on every setup, and
   * everything outside it — the project's own rules — is kept as written.
   */
  plannedAgents(current) {
    const source = this.contractSource();
    if (source === null) {
      return current;
    }
    const block = CONTRACT_BEGIN + "\n" + source + "\n" + CONTRACT_END;
    if (current === null || !current.trim()) {
      return block + "\n";
    }
    const begin = current.indexOf(CONTRACT_BEGIN.slice(0, 26));
    const end = current.indexOf(CONTRACT_END);
    if (begin !== -1 && end > begin) {
      return current.slice(0, begin) + block + current.slice(end + CONTRACT_END.length);
    }
    if (current.replace(/\r\n/g, "\n").trim() === source || STOCK_CONTRACT_HASHES.has(contractHash(current))) {
      // An unmarked copy of a stock contract: replaced, not duplicated.
      return block + "\n";
    }
    return current.replace(/\s*$/, "") + "\n\n" + block + "\n";
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

  guardCli() {
    const bin = relative(this.projectRoot, join(this.root, "bin", "astack-guard.mjs")).split("\\").join("/");
    return bin || "bin/astack-guard.mjs";
  }

  browserEnabled() {
    return this.browserConfig?.enabled !== false;
  }

  browserServer() {
    const bin = relative(this.projectRoot, join(this.root, "bin", "astack-browser-mcp.mjs")).split("\\").join("/");
    return { command: "node", args: [bin || "bin/astack-browser-mcp.mjs"] };
  }

  plannedMcpJson(current) {
    const next = current ?? {};
    const servers = { ...(next.mcpServers ?? {}), [MCP_SERVER_ID]: { type: "stdio", ...this.mcpServer() } };
    // Entries of ours under any name (a 3.4 pre-release used "browser") are
    // dropped and written again only where AStack manages the browser.
    for (const [name, entry] of Object.entries(servers)) {
      if (JSON.stringify(entry).includes(BROWSER_MARKER)) {
        delete servers[name];
      }
    }
    if (this.browserManagedFor(servers) && !this.codexOwnsBrowser()) {
      servers[BROWSER_SERVER_ID] = { type: "stdio", ...this.browserServer() };
    }
    next.mcpServers = servers;
    return next;
  }

  /** AStack's browser is wired unless it is off or the owner runs Playwright already. */
  browserManagedFor(servers = {}) {
    if (!this.browserEnabled()) {
      return false;
    }
    return !Object.values(servers ?? {}).some((entry) => {
      const text = JSON.stringify(entry);
      return !text.includes(BROWSER_MARKER) && PLAYWRIGHT_MARKER.test(text);
    });
  }

  /** True when .mcp.json's browser entry is (or will be) AStack's own. */
  browserManaged() {
    try {
      const current = existsSync(this.path(".mcp.json")) ? readJson(this.path(".mcp.json"), {}) : {};
      if (!this.browserManagedFor(current?.mcpServers ?? {})) {
        return false;
      }
    } catch {
      return false;
    }
    return !this.codexOwnsBrowser();
  }

  /** True when .mcp.json has a server of that name that is not AStack's. */
  ownerHasServer(name) {
    try {
      const entry = existsSync(this.path(".mcp.json")) ? readJson(this.path(".mcp.json"), {})?.mcpServers?.[name] : null;
      return Boolean(entry) && !JSON.stringify(entry).includes(BROWSER_MARKER);
    } catch {
      return true;
    }
  }

  /** An owner's Playwright server declared only for Codex counts too. */
  codexOwnsBrowser() {
    const path = this.path(".codex", "config.toml");
    return existsSync(path) && PLAYWRIGHT_MARKER.test(outsideManagedBlock(readFileSync(path, "utf8")));
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
    // The guard (3.5.0): destructive commands ask, catastrophic ones are
    // refused, and a frozen folder bounds edits. guard.enabled: false removes it.
    const guardCommand = "node \"$CLAUDE_PROJECT_DIR/" + this.guardCli() + "\"";
    const keptPreToolUse = (Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [])
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !String(hook.command ?? "").includes(GUARD_MARKER)) }))
      .filter((group) => group.hooks.length);
    hooks.PreToolUse = this.guardConfig?.enabled === false
      ? keptPreToolUse
      : [...keptPreToolUse, { matcher: "Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: guardCommand, timeout: 10 }] }];
    if (!hooks.PreToolUse.length) {
      delete hooks.PreToolUse;
    }
    next.hooks = hooks;
    // Our enable and allow entries exist only while AStack manages the
    // browser; they are removed otherwise, so they can never carry over to a
    // server the owner adds later.
    const browser = this.browserManaged();
    // A 3.4 pre-release wired the server as "browser": its entries go too,
    // unless "browser" in .mcp.json is the owner's own server.
    const legacy = !this.ownerHasServer("browser");
    const legacyAllow = new Set(BROWSER_READ_TOOLS.concat(["browser_tabs"]).map((tool) => "mcp__browser__" + tool));
    const ownAllow = (entry) => String(entry).startsWith("mcp__" + BROWSER_SERVER_ID + "__") || (legacy && legacyAllow.has(String(entry)));
    const enabled = (next.enabledMcpjsonServers ?? []).filter((name) => name !== BROWSER_SERVER_ID && !(legacy && name === "browser"));
    next.enabledMcpjsonServers = [...new Set([...enabled, MCP_SERVER_ID, ...(browser ? [BROWSER_SERVER_ID] : [])])];
    const permissions = next.permissions ?? {};
    const browserReads = browser ? BROWSER_READ_TOOLS.map((tool) => "mcp__" + BROWSER_SERVER_ID + "__" + tool) : [];
    const keptAllow = (permissions.allow ?? []).filter((entry) => !ownAllow(entry));
    next.permissions = { ...permissions, allow: [...new Set([...keptAllow, "mcp__" + MCP_SERVER_ID, ...browserReads])] };
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

  /** The browser server inside the managed block, unless the owner declared one. */
  codexBrowserLines(current) {
    if (!this.browserManaged()) {
      return [];
    }
    // Any owner definition of the same key, in any TOML shape, wins: two
    // definitions would make Codex reject the whole file.
    const outside = outsideManagedBlock(current ?? "");
    if (/astack-browser/.test(outside) || PLAYWRIGHT_MARKER.test(outside)) {
      return [];
    }
    const server = this.browserServer();
    return [
      "",
      "[mcp_servers." + BROWSER_SERVER_ID + "]",
      "command = " + JSON.stringify(server.command),
      "args = [" + server.args.map((argument) => JSON.stringify(argument)).join(", ") + "]",
      // The first start may fetch the pinned Playwright MCP package.
      "startup_timeout_sec = 120"
    ];
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
      ...this.codexBrowserLines(current),
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
      { runtime: "shared", path: "AGENTS.md", kind: "text", build: (current) => this.plannedAgents(current) },
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
      if (content === null) {
        return { runtime: file.runtime, path: file.path, action: "ok", content: null };
      }
      const same = before !== null && before.replace(/\r\n/g, "\n") === content.replace(/\r\n/g, "\n");
      return { runtime: file.runtime, path: file.path, action: !exists ? "create" : same ? "ok" : "update", content };
    });
  }

  sync({ dryRun = false } = {}) {
    if (!this.contract().present && this.contractSource() === null) {
      throw new Error("AGENTS.md is missing and the core has no " + CONTRACT_SOURCE + ": nothing to wire the runtimes to");
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
    const path = this.projectRoot;
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
      return execFileSync("git", args, { cwd: this.projectRoot, encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
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
    const wanted = claudeProjectSlug(this.projectRoot).toLowerCase();
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
    const recent = this.journal({ limit: 8 }).filter((entry) => ["handoff", "session-end", "update"].includes(entry.kind)).slice(0, 6);
    if (recent.length) {
      lines.push("", "## Recent work (both runtimes, newest first)");
      for (const entry of recent) {
        const when = String(entry.at).slice(0, 16).replace("T", " ");
        if (entry.kind === "update") {
          lines.push("- " + when + " AStack update " + (entry.from ?? "?") + " → " + (entry.to ?? "?") + " (" + (entry.ref ?? "-") + "): " + entry.result);
        } else if (entry.kind === "handoff") {
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
    if (this.memory?.active) {
      try {
        const active = this.memory.active({ budget: Math.round(budget / 4) });
        if (active.lines.length) {
          lines.push("", "## Active memory (" + active.rendered + " blocks; `astack memory block list`, edit with `astack memory block append|replace`)");
          lines.push(...active.lines);
        }
      } catch {
        // A damaged block file must not cost the session its start brief.
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

  /** Markdown memory from memory.import_paths into the shared store (idempotent). */
  importLegacy() {
    if (!this.memory || !this.legacyMemory) {
      return null;
    }
    return importLegacyMemory({ memory: this.memory, workspaceRoot: this.workspaceRoot, clock: this.clock, ...this.legacyMemory });
  }

  sessionStart({ runtime, payload = {} } = {}) {
    try {
      this.importLegacy();
    } catch {
      // A memory file being written mid-session is picked up next time.
    }
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

/** TOML text outside the managed astack block. */
function outsideManagedBlock(text) {
  const begin = text.indexOf(TOML_BEGIN);
  const end = text.indexOf(TOML_END);
  return begin !== -1 && end > begin ? text.slice(0, begin) + text.slice(end + TOML_END.length) : text;
}

/** A top-level section of the core's configuration, or {}. */
function readSection(root, name) {
  try {
    return new ConfigurationEngine(root).section(name, {}) ?? {};
  } catch {
    return {};
  }
}

/** browser.dedicated from the core's configuration, or the defaults. */
function readDedicatedConfig(root) {
  try {
    return new ConfigurationEngine(root).section("browser", {}).dedicated ?? {};
  } catch {
    return {};
  }
}
