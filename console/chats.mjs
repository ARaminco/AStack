import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { redactSecretsStrict } from "../lib/text.mjs";
import { toolInputPreview, toolTarget } from "../lib/tool-summary.mjs";
import { claudeSlug, cleanUserText } from "../search-engine/sources/sessions.mjs";
import { MANDATORY_CLAUDE_DENIED, killProcessTree, resolveCommand, startProcess, unattendedEnv } from "../runner-engine/engines.mjs";
import { PERMISSION_TOOL_NAME } from "../interop-engine/mcp-server.mjs";

/**
 * Conversations (گفت‌وگوها): Claude Code sessions in the console.
 *
 * Reading: the transcripts Claude Code keeps in
 * `~/.claude/projects/<slug>/<session>.jsonl` for the projects listed in
 * `console.chats.projects`, parsed into a chat (user and assistant text, tool
 * calls as one-line chips, thinking and injected IDE/system blocks left out)
 * and strict-redacted before anything leaves the server.
 *
 * Writing: a turn spawns Claude Code headless in the session's project —
 * `claude -p --resume <id>` (or `--session-id <new uuid>`) with
 * `--output-format stream-json --verbose`, the prompt on stdin — and streams
 * its events to the browser over the console's SSE channel. Tool use is
 * decided by the owner: `--permission-prompt-tool mcp__astack__permission_prompt`
 * turns every permission request into an AStack approval. The runner's
 * mandatory `.astack/**` denies always apply, so a chat can never forge one.
 *
 * 3.1.1: the Claude Code child runs with `ASTACK_UNATTENDED=1` (it and
 * everything it starts can request approvals but never decide one, and
 * `astack console user|token` refuse to run); decisions are made by the
 * console server process, which is not unattended. Every turn also denies
 * the console's, vault's and gateway's state folders (CHAT_STATE_DENIES).
 */

export const PERMISSION_TOOL = "mcp__astack__" + PERMISSION_TOOL_NAME;
export const CHAT_PERMISSION_MODES = ["default", "acceptEdits", "plan", "dontAsk"];
export const DEFAULT_CHAT_TOOLS = ["Read", "Grep", "Glob"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_FILE = /^agent-[A-Za-z0-9_-]{1,64}$/;
const MAX_PROMPT = 100000;
const BUFFER_LIMIT = 600;
const STDERR_TAIL = 4000;

/**
 * Denied in every conversation turn, local or remote: the console's sessions,
 * users, token and TOTP state, the vault and the gateway's state, plus the
 * `astack console` commands that manage sign-in.
 *
 * Rule syntax as Claude Code 2.1.x documents it (code.claude.com/docs/en/permissions):
 * file access is checked against `Read(path)` and `Edit(path)` rules only. A
 * Read deny also covers Grep and Glob (best effort) and blocks Edit and Write
 * on the same path; an Edit deny covers every editing tool (Write,
 * NotebookEdit). `Write(…)`, `Grep(…)` and `Glob(…)` path rules are
 * accepted but never consulted, so they are not used here. Paths use
 * gitignore syntax: `//` anchors at the filesystem root (`//**` spans every
 * drive on Windows, where paths are normalised to `/c/...`), a pattern without
 * a prefix is relative to the working directory. In Bash and PowerShell rules
 * `*` matches any text, spaces included, at any position.
 */
export const CHAT_STATE_DIRECTORIES = ["console", "vault", "gateway"];
export const CHAT_STATE_DENIES = [
  ...CHAT_STATE_DIRECTORIES.flatMap((name) => [
    "Read(//**/.astack/" + name + "/**)",
    "Edit(//**/.astack/" + name + "/**)",
    "Read(**/.astack/" + name + "/**)",
    "Edit(**/.astack/" + name + "/**)"
  ]),
  // The workspace may sit outside the project folder a turn runs in.
  "Edit(//**/.astack/**)",
  ...CHAT_STATE_DIRECTORIES.flatMap((name) => ["Bash(*.astack/" + name + "*)", "PowerShell(*.astack*" + name + "*)"]),
  "Bash(*astack* console*)",
  "Bash(*astack.mjs* console*)",
  "PowerShell(*astack* console*)",
  "PowerShell(*astack.mjs* console*)"
];

/**
 * Extra denies for a turn started from the remote (internet) listener when
 * conversations are ever enabled there: no secrets files, no AStack state,
 * no SSH or Claude configuration, nothing on the Z: drive.
 */
export function remoteChatDenies() {
  const patterns = ["**/.env*", ".env*", "**/.astack/**", "~/.ssh/**", "**/.ssh/**", "~/.claude/**", "**/.claude/**", "//z/**", "//Z/**", "Z:/**"];
  const tools = ["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Grep", "Glob"];
  return [
    ...tools.flatMap((tool) => patterns.map((pattern) => tool + "(" + pattern + ")")),
    "Bash(*.env*)", "Bash(*.ssh*)", "Bash(*.claude*)", "Bash(*.astack*)", "Bash(*Z:*)", "Bash(*z:*)",
    "PowerShell(*.env*)", "PowerShell(*.ssh*)", "PowerShell(*.claude*)", "PowerShell(*.astack*)", "PowerShell(*Z:*)"
  ];
}

function toList(value, fallback = []) {
  if (Array.isArray(value)) {
    return value.map(String).map((entry) => entry.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  return fallback;
}

export function claudeHomeDirectory(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(homedir(), ".claude");
}

/**
 * The transcript folders of a project: Claude Code names them after the
 * working directory with every non-alphanumeric character turned into "-".
 * Windows drive letters appear in either case (`c--…` and `C--…`), depending
 * on how the folder was opened; both are read.
 */
export function transcriptDirectories(projectPath, home) {
  const projects = join(home, "projects");
  if (!existsSync(projects)) {
    return [];
  }
  const slug = claudeSlug(resolve(projectPath));
  const wanted = new Set([slug]);
  if (/^[A-Za-z]--/.test(slug)) {
    wanted.add(slug[0].toLowerCase() + slug.slice(1));
    wanted.add(slug[0].toUpperCase() + slug.slice(1));
  }
  let names = [];
  try {
    names = readdirSync(projects);
  } catch {
    return [];
  }
  // Windows paths are case-insensitive, and Claude Code keeps whatever casing
  // the folder was opened with: compare the whole slug without case there.
  const insensitive = process.platform === "win32" || /^[A-Za-z]--/.test(slug);
  const lowered = slug.toLowerCase();
  return names.filter((name) => wanted.has(name) || (insensitive && name.toLowerCase() === lowered)).map((name) => join(projects, name)).filter((path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  });
}

// Entry types a list card needs; every other line is skipped before parsing.
const SUMMARY_TYPES = /"type":"(user|assistant|summary|custom-title|ai-title)"/;

function readLines(path, { only = null } = {}) {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || (only && !only.test(line))) {
      continue;
    }
    try {
      entries.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return entries;
}

function userText(content) {
  if (typeof content === "string") {
    return { text: cleanUserText(content), images: 0, toolResults: [] };
  }
  if (!Array.isArray(content)) {
    return { text: "", images: 0, toolResults: [] };
  }
  const texts = [];
  let images = 0;
  const toolResults = [];
  for (const block of content) {
    if (block?.type === "text") {
      texts.push(block.text ?? "");
    } else if (block?.type === "image") {
      images += 1;
    } else if (block?.type === "tool_result") {
      toolResults.push(block);
    }
  }
  return { text: cleanUserText(texts.join("\n\n")), images, toolResults };
}

function clipText(text, max) {
  const value = String(text ?? "");
  return value.length > max ? value.slice(0, max) + "\n… (" + (value.length - max) + " more characters)" : value;
}

function oneLine(text, max) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

function toolResultText(block) {
  const content = block?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => (part?.type === "text" ? part.text : part?.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
  }
  return "";
}

/**
 * The list card of one transcript: title, activity, size and branch.
 * Title: the owner's `/rename` title, then a `summary` entry, then Claude
 * Code's generated title, then the first real user message.
 */
export function summarizeTranscript(path) {
  const entries = readLines(path, { only: SUMMARY_TYPES });
  let customTitle = null;
  let summary = null;
  let aiTitle = null;
  let firstUser = null;
  let firstAt = null;
  let lastAt = null;
  let branch = null;
  let cwd = null;
  let users = 0;
  let sidechainOnly = entries.length > 0;
  const assistantIds = new Set();
  for (const entry of entries) {
    if (entry.type === "custom-title" && entry.customTitle) {
      customTitle = String(entry.customTitle);
    } else if (entry.type === "summary" && entry.summary) {
      summary = String(entry.summary);
    } else if (entry.type === "ai-title" && entry.aiTitle) {
      aiTitle = String(entry.aiTitle);
    }
    if (entry.type !== "user" && entry.type !== "assistant") {
      continue;
    }
    if (entry.isSidechain) {
      continue;
    }
    sidechainOnly = false;
    if (entry.timestamp) {
      firstAt = firstAt ?? entry.timestamp;
      lastAt = entry.timestamp > (lastAt ?? "") ? entry.timestamp : lastAt;
    }
    branch = entry.gitBranch || branch;
    cwd = entry.cwd || cwd;
    if (entry.isMeta || entry.isCompactSummary) {
      continue;
    }
    if (entry.type === "user") {
      const { text, images } = userText(entry.message?.content);
      if (text || images) {
        users += 1;
        firstUser = firstUser ?? (text || "[image]");
      }
    } else if (Array.isArray(entry.message?.content) && entry.message.content.some((block) => block?.type === "text" && String(block.text ?? "").trim())) {
      assistantIds.add(entry.message.id ?? entry.uuid);
    }
  }
  const raw = customTitle ?? summary ?? aiTitle ?? firstUser ?? "";
  return {
    id: basename(path, ".jsonl"),
    title: redactSecretsStrict(oneLine(raw, 140)),
    titleSource: customTitle ? "custom" : summary ? "summary" : aiTitle ? "ai" : firstUser ? "first-message" : "none",
    firstAt,
    lastAt,
    messages: users + assistantIds.size,
    branch: branch && branch !== "HEAD" ? branch : branch ?? null,
    cwd,
    sidechain: sidechainOnly && entries.some((entry) => entry.isSidechain)
  };
}

/**
 * A transcript as chat items:
 * - `{ kind: "user", text, images }`
 * - `{ kind: "assistant", text }` (consecutive blocks of one message merged)
 * - `{ kind: "tool", id, name, target, input, result: { error, preview } }`
 * - `{ kind: "divider", label }` (a compaction)
 * Thinking blocks, meta entries, sidechains and injected tags are dropped.
 */
export function parseTranscript(path) {
  const items = [];
  const tools = new Map();
  let lastAssistant = null;
  for (const entry of readLines(path)) {
    if (entry.isSidechain && !/[\\/]subagents[\\/]/.test(path)) {
      continue;
    }
    if (entry.type === "system" && entry.subtype === "compact_boundary") {
      items.push({ kind: "divider", label: "compact", at: entry.timestamp ?? null });
      lastAssistant = null;
      continue;
    }
    if (entry.type === "user") {
      if (entry.isMeta) {
        continue;
      }
      if (entry.isCompactSummary) {
        items.push({ kind: "divider", label: "compact", at: entry.timestamp ?? null });
        lastAssistant = null;
        continue;
      }
      const { text, images, toolResults } = userText(entry.message?.content);
      for (const block of toolResults) {
        const tool = tools.get(block.tool_use_id);
        if (tool) {
          tool.result = { error: Boolean(block.is_error), preview: redactSecretsStrict(clipText(toolResultText(block), 1200)) };
        }
      }
      if (text || images) {
        items.push({ kind: "user", id: entry.uuid ?? null, at: entry.timestamp ?? null, text: redactSecretsStrict(clipText(text, 20000)), images });
        lastAssistant = null;
      }
      continue;
    }
    if (entry.type !== "assistant" || !Array.isArray(entry.message?.content)) {
      continue;
    }
    const messageId = entry.message.id ?? entry.uuid;
    for (const block of entry.message.content) {
      if (block?.type === "text" && String(block.text ?? "").trim()) {
        if (lastAssistant && lastAssistant.messageId === messageId && items[items.length - 1] === lastAssistant) {
          lastAssistant.raw += "\n\n" + block.text;
        } else {
          lastAssistant = { kind: "assistant", id: entry.uuid ?? null, messageId, at: entry.timestamp ?? null, raw: String(block.text) };
          items.push(lastAssistant);
        }
      } else if (block?.type === "tool_use") {
        const tool = {
          kind: "tool",
          id: block.id,
          at: entry.timestamp ?? null,
          name: String(block.name ?? "tool"),
          target: toolTarget(block.name, block.input),
          input: toolInputPreview(block.input, { maxString: 600 }),
          result: null
        };
        tools.set(block.id, tool);
        items.push(tool);
        lastAssistant = null;
      }
    }
  }
  return items.map((item) => {
    if (item.kind !== "assistant") {
      return item;
    }
    const { raw, messageId, ...rest } = item;
    return { ...rest, text: redactSecretsStrict(clipText(raw, 40000)) };
  });
}

/** The last `turns` turns before item index `before` (a turn starts at a user message). */
export function windowItems(items, { before = null, turns = 12 } = {}) {
  const end = before === null || before === undefined || before === "" ? items.length : Math.max(0, Math.min(items.length, Number(before)));
  const starts = [];
  for (let index = 0; index < end; index += 1) {
    if (items[index].kind === "user") {
      starts.push(index);
    }
  }
  const count = Math.max(1, Math.min(100, Number(turns) || 12));
  const start = starts.length > count ? starts[starts.length - count] : 0;
  return { items: items.slice(start, end), start, end, total: items.length, hasMore: start > 0 };
}

function localDay(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

export class ChatError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/**
 * Lists, reads and drives Claude Code sessions for the console.
 */
export class ChatManager {
  constructor({ runtime, config = {}, events = null, clock = null, home = null, log = () => {} } = {}) {
    this.runtime = runtime;
    this.config = config ?? {};
    this.events = events;
    this.clock = clock ?? (() => new Date());
    this.home = home ?? (this.config.claude_home ? resolve(String(this.config.claude_home)) : claudeHomeDirectory());
    this.log = log;
    this.directory = join(runtime.workspaceRoot, ".astack", "console", "chats");
    this.ledgerPath = join(this.directory, "ledger.jsonl");
    this.summaries = new Map();
    this.parsed = new Map();
    this.turns = new Map();
    this.recentTurns = [];
  }

  // ------------------------------------------------------------- settings

  enabled() {
    return this.config.enabled !== false;
  }

  projects() {
    const configured = toList(this.config.projects, []);
    const list = configured.length ? configured : [this.runtime.workspaceRoot];
    const seen = new Set();
    return list.map((path) => resolve(path)).filter((path) => {
      const key = path.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    }).map((path, index) => ({ index, path, name: basename(path) || path, exists: existsSync(path) }));
  }

  permissionMode() {
    const mode = String(this.config.permission_mode ?? "default");
    if (mode === "bypassPermissions") {
      throw new ChatError(400, "console.chats.permission_mode bypassPermissions is refused");
    }
    if (!CHAT_PERMISSION_MODES.includes(mode)) {
      throw new ChatError(400, "console.chats.permission_mode " + mode + " is refused: use one of " + CHAT_PERMISSION_MODES.join(", "));
    }
    return mode;
  }

  allowedTools() {
    return toList(this.config.allowed_tools, DEFAULT_CHAT_TOOLS);
  }

  approvalTimeoutMs() {
    const minutes = Number(this.config.approval_timeout_minutes ?? 10);
    return Math.max(10 * 1000, (Number.isFinite(minutes) ? minutes : 10) * 60 * 1000);
  }

  // ------------------------------------------------------------- reading

  summaryOf(path) {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return null;
    }
    const key = stat.mtimeMs + ":" + stat.size;
    const cached = this.summaries.get(path);
    if (cached?.key === key) {
      return cached.value;
    }
    const value = { ...summarizeTranscript(path), size: stat.size, modifiedAt: new Date(stat.mtimeMs).toISOString() };
    this.summaries.set(path, { key, value });
    return value;
  }

  sessionFiles(project) {
    const files = [];
    for (const directory of transcriptDirectories(project.path, this.home)) {
      let names = [];
      try {
        names = readdirSync(directory);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl") || name.startsWith("agent-") || !UUID.test(name.slice(0, -6))) {
          continue;
        }
        files.push({ path: join(directory, name), directory, id: name.slice(0, -6) });
      }
    }
    return files;
  }

  subagentsOf(directory, id) {
    const folder = join(directory, id, "subagents");
    if (!existsSync(folder)) {
      return [];
    }
    let names = [];
    try {
      names = readdirSync(folder);
    } catch {
      return [];
    }
    return names.filter((name) => name.endsWith(".jsonl")).map((name) => {
      const agent = name.slice(0, -6);
      let meta = {};
      try {
        meta = JSON.parse(readFileSync(join(folder, agent + ".meta.json"), "utf8"));
      } catch {
        meta = {};
      }
      return { id: agent, type: meta.agentType ? String(meta.agentType).slice(0, 60) : null, description: meta.description ? redactSecretsStrict(oneLine(meta.description, 120)) : null };
    }).filter((agent) => AGENT_FILE.test(agent.id));
  }

  list({ q = "", project = null, page = 1, size = 30 } = {}) {
    const projects = this.projects();
    const needle = String(q ?? "").trim().toLowerCase();
    const all = [];
    const counts = {};
    for (const entry of projects) {
      if (project !== null && project !== undefined && project !== "" && String(entry.index) !== String(project)) {
        continue;
      }
      counts[entry.index] = 0;
      for (const file of this.sessionFiles(entry)) {
        const summary = this.summaryOf(file.path);
        if (!summary || summary.sidechain || summary.messages === 0) {
          continue;
        }
        counts[entry.index] += 1;
        if (needle && !summary.title.toLowerCase().includes(needle)) {
          continue;
        }
        all.push({
          id: summary.id,
          title: summary.title,
          titleSource: summary.titleSource,
          lastAt: summary.lastAt ?? summary.modifiedAt,
          firstAt: summary.firstAt,
          messages: summary.messages,
          branch: summary.branch,
          project: { index: entry.index, name: entry.name },
          subagents: this.subagentsOf(file.directory, file.id).length,
          active: this.turns.has(summary.id)
        });
      }
    }
    all.sort((a, b) => String(b.lastAt ?? "").localeCompare(String(a.lastAt ?? "")));
    const safeSize = Math.min(100, Math.max(5, Number(size) || 30));
    const pages = Math.max(1, Math.ceil(all.length / safeSize));
    const current = Math.min(pages, Math.max(1, Number(page) || 1));
    return {
      items: all.slice((current - 1) * safeSize, current * safeSize),
      page: current,
      pages,
      size: safeSize,
      total: all.length,
      projects: projects.map((entry) => ({ index: entry.index, name: entry.name, exists: entry.exists, sessions: counts[entry.index] ?? null })),
      today: this.todaySpend(),
      budget: this.budget()
    };
  }

  locate(id) {
    if (!UUID.test(String(id ?? ""))) {
      return null;
    }
    for (const project of this.projects()) {
      for (const directory of transcriptDirectories(project.path, this.home)) {
        const path = join(directory, id + ".jsonl");
        if (existsSync(path)) {
          return { path, directory, project };
        }
      }
    }
    return null;
  }

  parsedItems(path) {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return [];
    }
    const key = stat.mtimeMs + ":" + stat.size;
    const cached = this.parsed.get(path);
    if (cached?.key === key) {
      return cached.items;
    }
    const items = parseTranscript(path);
    this.parsed.set(path, { key, items });
    if (this.parsed.size > 6) {
      this.parsed.delete(this.parsed.keys().next().value);
    }
    return items;
  }

  get(id, { before = null, turns = 12, agent = null } = {}) {
    const found = this.locate(id);
    const active = this.turns.get(id);
    if (!found) {
      if (active) {
        // A brand-new session whose transcript is not on disk yet.
        return { id, title: oneLine(active.prompt, 140), project: { index: active.project.index, name: active.project.name }, branch: null, messages: 0, items: [], start: 0, end: 0, total: 0, hasMore: false, subagents: [], agent: null, active: this.activeState(active) };
      }
      throw new ChatError(404, "Unknown conversation: " + id);
    }
    let path = found.path;
    if (agent) {
      if (!AGENT_FILE.test(String(agent))) {
        throw new ChatError(400, "invalid sub-agent id");
      }
      path = join(found.directory, id, "subagents", agent + ".jsonl");
      if (!existsSync(path)) {
        throw new ChatError(404, "Unknown sub-agent: " + agent);
      }
    }
    const summary = this.summaryOf(found.path);
    const window = windowItems(this.parsedItems(path), { before, turns });
    return {
      id,
      title: summary?.title ?? id,
      titleSource: summary?.titleSource ?? null,
      project: { index: found.project.index, name: found.project.name },
      branch: summary?.branch ?? null,
      messages: summary?.messages ?? 0,
      lastAt: summary?.lastAt ?? null,
      subagents: agent ? [] : this.subagentsOf(found.directory, id),
      agent: agent ?? null,
      ...window,
      active: active ? this.activeState(active) : null
    };
  }

  // ------------------------------------------------------------- budget

  ledger() {
    if (!existsSync(this.ledgerPath)) {
      return [];
    }
    return readFileSync(this.ledgerPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  }

  todaySpend() {
    const today = localDay(this.clock());
    const entries = this.ledger().filter((entry) => localDay(new Date(entry.at)) === today);
    return { usd: Math.round(entries.reduce((sum, entry) => sum + (Number(entry.costUsd) || 0), 0) * 10000) / 10000, turns: entries.length };
  }

  budget() {
    const value = Number(this.config.daily_budget_usd);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  // ------------------------------------------------------------- turns

  activeState(turn) {
    return {
      turnId: turn.id,
      sessionId: turn.sessionId,
      startedAt: turn.startedAt,
      status: turn.status,
      isNew: turn.isNew,
      prompt: redactSecretsStrict(clipText(turn.prompt, 4000)),
      events: turn.buffer.slice(-BUFFER_LIMIT)
    };
  }

  emit(turn, type, payload = {}) {
    turn.seq = (turn.seq ?? 0) + 1;
    const event = { sessionId: turn.sessionId, turnId: turn.id, seq: turn.seq, type, at: this.clock().toISOString(), ...payload };
    if (type !== "partial") {
      turn.buffer.push(event);
      if (turn.buffer.length > BUFFER_LIMIT) {
        turn.buffer.splice(0, turn.buffer.length - BUFFER_LIMIT);
      }
    }
    this.events?.broadcast?.("chat", event);
    return event;
  }

  args({ sessionId, isNew, mcpConfigPath, channel = "local", budgetUsd = null }) {
    const remote = channel === "remote";
    const permissionMode = this.permissionMode();
    const args = ["-p", isNew ? "--session-id" : "--resume", sessionId, "--output-format", "stream-json", "--verbose"];
    if (this.config.partial_messages !== false) {
      args.push("--include-partial-messages");
    }
    args.push("--permission-mode", permissionMode);
    if (this.config.model) {
      args.push("--model", String(this.config.model));
    }
    if (this.config.strict_mcp !== false) {
      args.push("--strict-mcp-config");
    }
    args.push("--mcp-config", mcpConfigPath, "--permission-prompt-tool", PERMISSION_TOOL);
    const tools = toList(this.config.tools, []);
    if (tools.length) {
      // Only these built-in tools are loaded (fewer tool schemas per turn).
      args.push("--tools", tools.join(","));
    }
    const denies = [...new Set([...toList(this.config.disallowed_tools, []), ...MANDATORY_CLAUDE_DENIED, ...CHAT_STATE_DENIES, ...(remote ? remoteChatDenies() : [])])];
    const allowed = remote ? [] : this.allowedTools().filter((tool) => !/^mcp__astack__permission/.test(tool));
    args.push("--disallowedTools", ...denies);
    if (allowed.length) {
      args.push("--allowedTools", ...allowed);
    }
    if (budgetUsd !== null) {
      // Also ends the variadic tool lists above.
      args.push("--max-budget-usd", String(Number(budgetUsd).toFixed(2)));
    }
    return args;
  }

  mcpConfig({ sessionId }) {
    const timeoutMs = this.approvalTimeoutMs();
    return {
      mcpServers: {
        astack: {
          type: "stdio",
          command: process.execPath,
          args: [join(this.runtime.root, "bin", "astack.mjs"), "mcp", "serve"],
          env: {
            ASTACK_CONSOLE_CHAT: sessionId,
            ASTACK_WORKSPACE_ROOT: this.runtime.workspaceRoot,
            ASTACK_PERMISSION_TIMEOUT_MS: String(timeoutMs),
            // The permission server asks; it can never decide.
            ASTACK_UNATTENDED: "1"
          },
          timeout: timeoutMs + 60 * 1000
        }
      }
    };
  }

  /**
   * Start one turn. `sessionId` continues a session; without it `project`
   * (an index into `console.chats.projects`) starts a new one.
   */
  send({ sessionId = null, project = null, prompt, channel = "local" } = {}) {
    if (!this.enabled()) {
      throw new ChatError(404, "conversations are turned off (console.chats.enabled: false)");
    }
    const text = String(prompt ?? "").replace(/\r\n/g, "\n");
    if (!text.trim()) {
      throw new ChatError(400, "an empty message cannot be sent");
    }
    if (text.length > MAX_PROMPT) {
      throw new ChatError(413, "the message is longer than " + MAX_PROMPT + " characters");
    }
    let target;
    let isNew = false;
    if (sessionId) {
      if (!UUID.test(String(sessionId))) {
        throw new ChatError(400, "invalid session id");
      }
      const found = this.locate(sessionId);
      if (!found) {
        throw new ChatError(404, "Unknown conversation: " + sessionId);
      }
      target = found.project;
    } else {
      target = this.projects().find((entry) => String(entry.index) === String(project ?? 0));
      if (!target) {
        throw new ChatError(400, "choose one of the configured projects (console.chats.projects)");
      }
      isNew = true;
      sessionId = randomUUID();
    }
    if (!target.exists) {
      throw new ChatError(409, "the project folder does not exist: " + target.name);
    }
    if (this.turns.has(sessionId)) {
      throw new ChatError(409, "this conversation is already answering; wait for it or press stop", { busy: true });
    }
    const maxParallel = Math.max(1, Number(this.config.max_parallel ?? 2) || 2);
    if (this.turns.size >= maxParallel) {
      throw new ChatError(429, "too many conversations are answering at once (console.chats.max_parallel: " + maxParallel + ")");
    }
    const budget = this.budget();
    let remaining = null;
    if (budget !== null) {
      remaining = Math.round((budget - this.todaySpend().usd) * 100) / 100;
      if (remaining < 0.01) {
        throw new ChatError(402, "today's conversation budget is spent (console.chats.daily_budget_usd: " + budget + ")", { budget: true });
      }
    }
    const command = String(this.config.command ?? this.runtime.configuration?.get?.("runner.claude.command", null) ?? "claude");
    const verdict = this.runtime.automationPolicy?.allowCommand?.(command) ?? { allowed: true };
    if (!verdict.allowed) {
      throw new ChatError(403, "the automation policy does not allow " + command + ": " + verdict.reason, { policy: true });
    }
    const resolved = resolveCommand(command);
    if (!resolved) {
      throw new ChatError(503, "Claude Code was not found on PATH (set console.chats.command)");
    }
    const permissionMode = this.permissionMode();
    const turnId = "T" + this.clock().getTime().toString(36) + Math.random().toString(36).slice(2, 6);
    mkdirSync(this.directory, { recursive: true });
    const mcpConfigPath = join(this.directory, "mcp-" + turnId + ".json");
    writeFileSync(mcpConfigPath, JSON.stringify(this.mcpConfig({ sessionId }), null, 2) + "\n", "utf8");
    const args = this.args({ sessionId, isNew, mcpConfigPath, channel, budgetUsd: remaining });
    // Unattended like a runner child: the child can ask, only this server decides.
    const env = unattendedEnv({ ...process.env, MCP_TOOL_TIMEOUT: String(this.approvalTimeoutMs() + 60 * 1000) });
    let child;
    try {
      child = startProcess(resolved, args, { input: text, cwd: target.path, env });
    } catch (error) {
      rmSync(mcpConfigPath, { force: true });
      throw new ChatError(500, "Claude Code could not be started: " + error.message);
    }
    const turn = {
      id: turnId,
      sessionId,
      isNew,
      channel,
      project: target,
      prompt: text,
      startedAt: this.clock().toISOString(),
      status: "running",
      child,
      buffer: [],
      partial: "",
      partialTimer: null,
      stderr: "",
      result: null,
      seenApprovals: new Map(),
      // Requests of earlier turns of this session are not this turn's cards.
      earlierApprovals: new Set(this.approvalIdsFor(sessionId)),
      mcpConfigPath,
      args
    };
    this.turns.set(sessionId, turn);
    this.runtime.audit?.record?.({ actor: "owner@console", action: "console-chat-turn", target: sessionId, tool: "claude", riskLevel: "L3", result: (isNew ? "new" : "resume") + " in " + target.name + " (" + permissionMode + ", " + channel + ")" });
    this.emit(turn, "start", { isNew, project: { index: target.index, name: target.name }, prompt: redactSecretsStrict(clipText(text, 4000)) });
    let pending = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      let index = pending.indexOf("\n");
      while (index !== -1) {
        const line = pending.slice(0, index).trim();
        pending = pending.slice(index + 1);
        if (line) {
          this.handleLine(turn, line);
        }
        index = pending.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      turn.stderr = (turn.stderr + chunk).slice(-STDERR_TAIL);
    });
    const watch = setInterval(() => this.watchApprovals(turn), Number(this.config.approval_poll_ms ?? 700));
    watch.unref?.();
    turn.watch = watch;
    child.on("error", (error) => {
      turn.spawnError = error.message;
    });
    child.on("close", (code) => {
      if (pending.trim()) {
        this.handleLine(turn, pending.trim());
      }
      this.finish(turn, code);
    });
    return { turnId, sessionId, isNew, project: { index: target.index, name: target.name } };
  }

  flushPartial(turn) {
    clearTimeout(turn.partialTimer);
    turn.partialTimer = null;
    if (turn.partial) {
      this.emit(turn, "partial", { text: redactSecretsStrict(turn.partial) });
    }
  }

  handleLine(turn, line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === "system" && event.subtype === "init") {
      this.emit(turn, "init", { model: event.model ? String(event.model) : null, permissionMode: event.permissionMode ?? null });
      return;
    }
    if (event.type === "stream_event") {
      const inner = event.event ?? {};
      if (event.parent_tool_use_id) {
        return;
      }
      if (inner.type === "message_start" || (inner.type === "content_block_start" && inner.content_block?.type === "text")) {
        turn.partial = "";
      }
      if (inner.type === "content_block_delta" && inner.delta?.type === "text_delta") {
        turn.partial += String(inner.delta.text ?? "");
        // Redaction needs the whole text so far; send it at most every 120 ms.
        if (!turn.partialTimer) {
          turn.partialTimer = setTimeout(() => this.flushPartial(turn), 120);
        }
      }
      return;
    }
    if (event.parent_tool_use_id) {
      // Sub-agent traffic: only the parent's tool chip is shown.
      return;
    }
    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === "text" && String(block.text ?? "").trim()) {
          clearTimeout(turn.partialTimer);
          turn.partialTimer = null;
          turn.partial = "";
          this.emit(turn, "assistant", { messageId: event.message.id ?? null, text: redactSecretsStrict(clipText(block.text, 40000)) });
        } else if (block?.type === "tool_use") {
          this.emit(turn, "tool", { id: block.id, name: String(block.name ?? "tool"), target: toolTarget(block.name, block.input), input: toolInputPreview(block.input, { maxString: 600 }) });
        }
      }
      return;
    }
    if (event.type === "user" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === "tool_result") {
          this.emit(turn, "tool-result", { id: block.tool_use_id, error: Boolean(block.is_error), preview: redactSecretsStrict(clipText(toolResultText(block), 1200)) });
        }
      }
      return;
    }
    if (event.type === "result") {
      turn.result = {
        subtype: event.subtype ?? null,
        isError: Boolean(event.is_error) || (event.subtype && event.subtype !== "success"),
        costUsd: Number(event.total_cost_usd ?? 0) || 0,
        durationMs: Number(event.duration_ms ?? 0) || null,
        turns: event.num_turns ?? null,
        text: event.is_error || (event.subtype && event.subtype !== "success") ? redactSecretsStrict(clipText(String(event.result ?? ""), 1000)) : null,
        denials: Array.isArray(event.permission_denials) ? event.permission_denials.length : 0
      };
    }
  }

  approvalIdsFor(sessionId) {
    try {
      return this.runtime.approvals.list({ limit: 500 }).filter((record) => record.requestedBy === "console-chat:" + sessionId).map((record) => record.id);
    } catch {
      return [];
    }
  }

  /** Permission requests of this turn's session, as cards in the chat. */
  watchApprovals(turn) {
    const requester = "console-chat:" + turn.sessionId;
    let records = [];
    try {
      records = this.runtime.approvals.list({ limit: 200 }).filter((record) => record.requestedBy === requester && !turn.earlierApprovals.has(record.id));
    } catch {
      return;
    }
    for (const record of records) {
      const seen = turn.seenApprovals.get(record.id);
      if (!seen) {
        turn.seenApprovals.set(record.id, record.state);
        this.emit(turn, "permission", { approvalId: record.id, state: record.state });
        if (record.state === "pending") {
          // The console's poller announces the approval itself; the owner's
          // phone hears about it through the gateway.
          Promise.resolve()
            .then(() => this.runtime.gateway?.notify?.({ approvalId: record.id }))
            .catch((error) => this.log("[console] gateway notify failed: " + error.message));
        }
      } else if (seen !== record.state) {
        turn.seenApprovals.set(record.id, record.state);
        this.emit(turn, "permission-decided", { approvalId: record.id, state: record.state });
      }
    }
  }

  finish(turn, code) {
    if (turn.finished) {
      return;
    }
    turn.finished = true;
    clearInterval(turn.watch);
    this.flushPartial(turn);
    this.watchApprovals(turn);
    rmSync(turn.mcpConfigPath, { force: true });
    const result = turn.result;
    const status = turn.status === "stopping" ? "stopped" : result && !result.isError ? "completed" : "failed";
    turn.status = status;
    // A permission card left open belongs to a turn that no longer listens.
    for (const [id, state] of turn.seenApprovals) {
      if (state !== "pending") {
        continue;
      }
      try {
        if (this.runtime.approvals.get(id).state === "pending") {
          this.runtime.approvals.reject(id, { by: "owner@console", note: "conversation turn ended (" + status + ")" });
          this.emit(turn, "permission-decided", { approvalId: id, state: "rejected" });
        }
      } catch {
        // already decided or expired
      }
    }
    const costUsd = result?.costUsd ?? 0;
    const durationMs = result?.durationMs ?? Date.now() - new Date(turn.startedAt).getTime();
    mkdirSync(this.directory, { recursive: true });
    appendFileSync(this.ledgerPath, JSON.stringify({ at: this.clock().toISOString(), sessionId: turn.sessionId, turnId: turn.id, status, costUsd, durationMs }) + "\n", "utf8");
    const error = status === "failed"
      ? redactSecretsStrict(result?.text || turn.spawnError || (turn.stderr ? turn.stderr.trim().split(/\r?\n/).slice(-3).join(" ") : "") || "Claude Code exited with code " + code).slice(0, 600)
      : null;
    this.runtime.audit?.record?.({ actor: "owner@console", action: "console-chat-turn-finished", target: turn.sessionId, tool: "claude", riskLevel: "L3", result: status + " $" + costUsd.toFixed(4) });
    this.emit(turn, "done", { status, costUsd, durationMs, error, denials: result?.denials ?? 0, today: this.todaySpend(), budget: this.budget() });
    this.turns.delete(turn.sessionId);
    this.recentTurns = [{ id: turn.id, sessionId: turn.sessionId, status, costUsd, durationMs, at: this.clock().toISOString() }, ...this.recentTurns].slice(0, 50);
    this.events?.soon?.();
  }

  stop(sessionId) {
    const turn = this.turns.get(sessionId);
    if (!turn) {
      throw new ChatError(404, "nothing is running in this conversation");
    }
    turn.status = "stopping";
    this.emit(turn, "stopping", {});
    killProcessTree(turn.child);
    return { stopping: true, turnId: turn.id };
  }

  status() {
    return {
      enabled: this.enabled(),
      active: [...this.turns.values()].map((turn) => ({ sessionId: turn.sessionId, turnId: turn.id, startedAt: turn.startedAt, project: turn.project.name })),
      today: this.todaySpend(),
      budget: this.budget()
    };
  }

  stopAll() {
    for (const turn of this.turns.values()) {
      turn.status = "stopping";
      killProcessTree(turn.child);
    }
  }
}
