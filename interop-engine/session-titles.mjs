import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { looksSecret } from "../memory-engine/blocks.mjs";
import { parseYaml } from "../configuration-engine/configuration.mjs";

/**
 * Session titles: clear, findable names for Claude Code chat sessions.
 *
 * Claude Code keeps each session as ~/.claude/projects/<slug>/<id>.jsonl and
 * shows the last {"type":"custom-title"} record as its name, falling back to
 * the last {"type":"ai-title"}. AStack appends the same custom-title record
 * that /rename writes; it never edits or truncates a transcript line.
 *
 * Who wrote a custom title is answered by the shared history: a custom title
 * this engine did not write was set by the owner and is never replaced
 * without force. Sessions belong to the machine, not to one project, so the
 * history and state live under ~/.astack/session-titles/ and every AStack
 * install on the machine shares them.
 *
 * Naming itself needs judgement, so it is done by the agent that is already
 * in the session: the prompt hook only decides *when* a title is due and puts
 * a short instruction in front of the agent, which then calls
 * `astack session title` (or the astack_session_title MCP tool).
 */

export const SESSION_TITLE_DEFAULTS = {
  enabled: true,
  first_after_turns: 3,
  first_after_minutes: 15,
  recheck_turns: [12, 40],
  retry_after_turns: 3,
  max_nudges: 3,
  max_length: 60,
  language: "fa",
  hint: "",
  suggest_existing: true,
  sync_remote: true
};

const TITLE_MIN = 3;
const SESSION_ID = /^[0-9a-f][0-9a-f-]{7,35}$/i;
const LANGUAGE_NAMES = { fa: "Persian", en: "English", ar: "Arabic" };

// Words that say nothing about a subject; matching on them finds every chat.
const STOPWORDS = new Set([
  "این", "اون", "آن", "که", "را", "رو", "از", "به", "با", "در", "تو", "برای", "برا", "یه", "یک", "هم", "و", "یا", "اگه", "اگر",
  "می", "میخوام", "میخواهم", "کن", "بکن", "کنید", "بده", "بگو", "چی", "چیه", "چطور", "ببین", "لطفا", "رو", "های", "ها", "است", "هست",
  "بود", "شد", "کار", "کارو", "همه", "دیگه", "الان", "باید", "میشه", "داریم", "دارم", "ما", "من", "شما", "خودت", "اینو", "انجام",
  "the", "and", "for", "with", "this", "that", "from", "into", "please", "can", "you", "what", "how"
]);

function normalizeText(text) {
  return String(text ?? "")
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[ً-ْ]/g, "")
    .toLowerCase();
}

export function titleTokens(text) {
  return [...new Set(normalizeText(text).split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2 && !STOPWORDS.has(token)))];
}

/** Owner text from a transcript record, without IDE context and system blocks. */
function cleanPrompt(text) {
  return String(text ?? "")
    .replace(/<(system-reminder|ide_selection|ide_opened_file|command-[a-z-]+|local-command-[a-z-]+|browser_instruction|task-notification|cross-session-message)[^>]*>[\s\S]*?<\/\1>/g, " ")
    .replace(/<\/?pasted_content[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function promptText(content) {
  if (typeof content === "string") {
    return cleanPrompt(content);
  }
  if (!Array.isArray(content) || content.some((block) => block?.type === "tool_result")) {
    return "";
  }
  return cleanPrompt(content.filter((block) => block?.type === "text").map((block) => block.text).join(" "));
}

function assistantText(content) {
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content) ? content.filter((block) => block?.type === "text").map((block) => block.text).join(" ") : "";
}

function clip(text, length) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > length ? value.slice(0, length) + "…" : value;
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + "." + process.pid + "." + randomBytes(3).toString("hex") + ".tmp";
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, path);
}

function writeJsonAtomicText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + "." + process.pid + "." + randomBytes(3).toString("hex") + ".tmp";
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

/** The user-level hook's command tail; the project hook is "interop hook prompt --runtime claude-code". */
export const USER_HOOK_MARKER = "interop hook prompt --runtime claude-code --scope=user";
export const USER_STOP_MARKER = "interop hook stop --runtime claude-code --scope=user";

/**
 * True when a Claude Code project has AStack's own prompt hook, in which case
 * the user-level hook leaves the chat to it.
 */
/**
 * A project's own session_titles settings, from the AStack install in the
 * project folder or in its astack/ subfolder (an embedded core), or null.
 */
export function projectTitleConfig(projectDir) {
  if (!projectDir) {
    return null;
  }
  for (const folder of [String(projectDir), join(String(projectDir), "astack")]) {
    const path = join(folder, "astack.config.yaml");
    if (existsSync(path)) {
      try {
        return parseYaml(readFileSync(path, "utf8"))?.session_titles ?? {};
      } catch {
        return {};
      }
    }
  }
  return null;
}

export function projectHasPromptHook(projectDir) {
  if (!projectDir) {
    return false;
  }
  for (const name of ["settings.json", "settings.local.json"]) {
    const settings = readJson(join(String(projectDir), ".claude", name), null);
    const commands = (settings?.hooks?.UserPromptSubmit ?? []).flatMap((group) => group?.hooks ?? []).map((hook) => String(hook?.command ?? ""));
    if (commands.some((command) => command.includes("interop hook prompt") && !command.includes("--scope=user"))) {
      return true;
    }
  }
  return false;
}

/** Last record of one type in a transcript, found without parsing every line. */
function lastRecord(text, type, field) {
  const marker = "\"type\":\"" + type + "\"";
  let at = text.lastIndexOf(marker);
  while (at !== -1) {
    const start = text.lastIndexOf("\n", at) + 1;
    const end = text.indexOf("\n", at);
    try {
      const record = JSON.parse(text.slice(start, end === -1 ? undefined : end));
      if (record?.type === type && typeof record[field] === "string" && record[field]) {
        return record[field];
      }
    } catch {
      // A torn or nested occurrence; keep looking further up.
    }
    at = start > 1 ? text.lastIndexOf(marker, start - 2) : -1;
  }
  return null;
}

/**
 * Append a title record without changing the file's dates: chat lists sort by
 * them, and a rename is not activity.
 */
function appendTitle(file, id, title) {
  const before = statSync(file);
  // A crash can leave the last line unfinished; start a fresh line so the
  // title record is never glued onto it.
  let lead = "";
  if (before.size > 0) {
    const handle = openSync(file, "r");
    try {
      const last = Buffer.alloc(1);
      readSync(handle, last, 0, 1, before.size - 1);
      lead = last[0] === 0x0a ? "" : "\n";
    } finally {
      closeSync(handle);
    }
  }
  appendFileSync(file, lead + JSON.stringify({ type: "custom-title", sessionId: id, customTitle: title }) + "\n");
  try {
    utimesSync(file, before.atime, before.mtime);
  } catch {
    // Dates are cosmetic; the title is written.
  }
}

/**
 * The local id Claude Code gives a chat it resumes from a Remote Control
 * session: a UUID v5 of the session's URL in a fixed namespace (the same
 * computation Claude Code makes for --resume=<url>).
 */
const REMOTE_SESSION_NAMESPACE = "3ab19d7e-9f35-45c2-926e-75e271cc60b3";
export function remoteLocalId(remote, apiBase = "https://api.anthropic.com") {
  const href = new URL(apiBase + "/v1/code/sessions/" + remote).href;
  const hash = createHash("sha1").update(Buffer.from(REMOTE_SESSION_NAMESPACE.replace(/-/g, ""), "hex")).update(Buffer.from(href, "utf8")).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20, 32);
}

/** Claude Code's folder name for a project path (case differs between launchers). */
export function claudeSlug(path) {
  return String(path).replace(/[^a-zA-Z0-9]/g, "-");
}

export class SessionTitles {
  constructor({ home = homedir(), projectsRoot = null, stateRoot = null, projectRoot = process.cwd(), config = {}, clock, cli = "bin/astack.mjs", credentialsPath = null, apiBase = null, fetchImpl = null } = {}) {
    this.home = home;
    this.projectsRoot = projectsRoot ?? join(home, ".claude", "projects");
    this.stateRoot = stateRoot ?? join(home, ".astack", "session-titles");
    this.historyPath = join(this.stateRoot, "history.jsonl");
    this.indexPath = join(this.stateRoot, "index.json");
    this.projectRoot = projectRoot;
    this.clock = clock ?? (() => new Date());
    this.cli = cli;
    this.config = SessionTitles.settings(config);
    this.credentialsPath = credentialsPath ?? join(home, ".claude", ".credentials.json");
    // The sign-in token only ever goes to Anthropic's API; tests inject apiBase in code.
    this.apiBase = apiBase ?? "https://api.anthropic.com";
    this.fetch = fetchImpl ?? globalThis.fetch;
  }

  static settings(config = {}) {
    const merged = { ...SESSION_TITLE_DEFAULTS, ...(config ?? {}) };
    const whole = (value, fallback, min = 1) => (Number.isFinite(Number(value)) && Number(value) >= min ? Math.floor(Number(value)) : fallback);
    merged.enabled = merged.enabled !== false && merged.enabled !== "false";
    merged.suggest_existing = merged.suggest_existing !== false && merged.suggest_existing !== "false";
    merged.sync_remote = merged.sync_remote !== false && merged.sync_remote !== "false";
    merged.first_after_turns = whole(merged.first_after_turns, SESSION_TITLE_DEFAULTS.first_after_turns);
    merged.first_after_minutes = whole(merged.first_after_minutes, SESSION_TITLE_DEFAULTS.first_after_minutes);
    merged.retry_after_turns = whole(merged.retry_after_turns, SESSION_TITLE_DEFAULTS.retry_after_turns);
    merged.max_nudges = whole(merged.max_nudges, SESSION_TITLE_DEFAULTS.max_nudges);
    merged.max_length = Math.min(120, whole(merged.max_length, SESSION_TITLE_DEFAULTS.max_length, 20));
    const recheck = Array.isArray(merged.recheck_turns) ? merged.recheck_turns : String(merged.recheck_turns ?? "").split(",");
    merged.recheck_turns = recheck.map(Number).filter((turn) => Number.isFinite(turn) && turn > 0).sort((a, b) => a - b);
    merged.language = String(merged.language || "fa");
    merged.hint = String(merged.hint ?? "").trim();
    return merged;
  }

  now() {
    return this.clock();
  }

  // ------------------------------------------------------------- history

  history() {
    if (!existsSync(this.historyPath)) {
      return [];
    }
    const entries = [];
    for (const line of readFileSync(this.historyPath, "utf8").split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        entries.push(JSON.parse(line));
      } catch {
        // A torn line from a crash mid-write is skipped.
      }
    }
    return entries;
  }

  /**
   * Per session id: every title this engine wrote, and the owner's title when
   * the latest record restored one. Any title AStack ever wrote counts as its
   * own, because Claude Code may re-append an older title it still holds in
   * memory; a title restored for the owner stays the owner's.
   */
  ourTitles(history = this.history()) {
    const titles = new Map();
    for (const entry of history) {
      if (!entry?.id || typeof entry.newTitle !== "string") {
        continue;
      }
      const info = titles.get(entry.id) ?? { titles: new Set(), owner: null, signature: "" };
      // An owner title AStack wrote back (an undo, or a rename pulled from the phone) stays the owner's.
      if ((entry.reason === "undo" || entry.reason === "remote-owner") && entry.restoredSource === "owner") {
        info.owner = entry.newTitle;
      } else {
        info.titles.add(entry.newTitle);
        info.owner = null;
      }
      info.signature = String(entry.at) + "|" + entry.newTitle;
      titles.set(entry.id, info);
    }
    return titles;
  }

  // ------------------------------------------------------------- reading

  projectDirectories({ project = null, all = false } = {}) {
    if (!existsSync(this.projectsRoot)) {
      return [];
    }
    const names = readdirSync(this.projectsRoot).filter((name) => {
      try {
        return statSync(join(this.projectsRoot, name)).isDirectory();
      } catch {
        return false;
      }
    });
    if (all) {
      return names;
    }
    const wanted = (project ? String(project) : claudeSlug(this.projectRoot)).toLowerCase();
    const exact = names.filter((name) => name.toLowerCase() === wanted);
    return exact.length || !project ? exact : names.filter((name) => name.toLowerCase().includes(wanted));
  }

  sessionFiles(options = {}) {
    const files = [];
    for (const directory of this.projectDirectories(options)) {
      for (const name of readdirSync(join(this.projectsRoot, directory))) {
        if (name.endsWith(".jsonl")) {
          files.push(join(this.projectsRoot, directory, name));
        }
      }
    }
    return files;
  }

  /** Path of one session by full id or a unique prefix of at least 8 characters, across all projects. */
  resolve(session) {
    const id = String(session ?? "").trim();
    if (!SESSION_ID.test(id)) {
      throw new Error("Invalid session id: " + clip(id, 40));
    }
    const matches = this.sessionFiles({ all: true }).filter((file) => basename(file, ".jsonl").toLowerCase().startsWith(id.toLowerCase()));
    if (!matches.length) {
      throw new Error("Session not found: " + id);
    }
    if (matches.length > 1) {
      throw new Error("Session id " + id + " is ambiguous (" + matches.length + " sessions); give more characters.");
    }
    return matches[0];
  }

  titleOf(text, id, ours = this.ourTitles()) {
    const custom = lastRecord(text, "custom-title", "customTitle");
    const ai = lastRecord(text, "ai-title", "aiTitle");
    if (custom) {
      const info = ours.get(id);
      const astack = info && info.owner !== custom && info.titles.has(custom);
      return { title: custom, source: astack ? "astack" : "owner" };
    }
    return ai ? { title: ai, source: "ai" } : { title: "", source: "none" };
  }

  /** Title, prompts and outcome of one session; `full` also collects every owner prompt. */
  scan(file, { ours = this.ourTitles(), full = true } = {}) {
    const id = basename(file, ".jsonl");
    const stat = statSync(file);
    const text = readFileSync(file, "utf8");
    const { title, source } = this.titleOf(text, id, ours);
    const prompts = [];
    let firstAt = null;
    let finalAnswer = "";
    for (const line of text.split("\n")) {
      if (!line.includes("\"type\":\"user\"") && !(full && line.includes("\"type\":\"assistant\""))) {
        continue;
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.isSidechain || (record.type !== "user" && record.type !== "assistant")) {
        continue;
      }
      if (record.type === "user" && !record.isMeta) {
        const prompt = promptText(record.message?.content);
        if (prompt) {
          firstAt ??= record.timestamp ?? null;
          prompts.push(prompt);
          if (!full) {
            break;
          }
        }
      } else if (record.type === "assistant") {
        const answer = assistantText(record.message?.content);
        if (answer.trim()) {
          finalAnswer = answer;
        }
      }
    }
    return {
      id,
      project: basename(dirname(file)),
      file,
      title,
      source,
      firstAt,
      lastAt: stat.mtime.toISOString(),
      turns: prompts.length,
      prompts,
      finalAnswer,
      size: stat.size,
      mtimeMs: stat.mtimeMs
    };
  }

  sessions({ project = null, all = false, weak = false } = {}) {
    const ours = this.ourTitles();
    const sessions = [];
    for (const file of this.sessionFiles({ project, all })) {
      try {
        const session = this.scan(file, { ours });
        if (session.turns) {
          sessions.push(session);
        }
      } catch {
        // A transcript removed or locked mid-scan is skipped.
      }
    }
    sessions.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    return weak ? sessions.filter((session) => session.source === "ai" || session.source === "none") : sessions;
  }

  /** Compact per-session evidence an agent names from, instead of transcripts. */
  digest(options = {}) {
    return this.sessions(options).map((session) => {
      const middle = session.prompts.slice(1, -1);
      const step = Math.max(1, Math.ceil(middle.length / 3));
      return {
        id: session.id,
        project: session.project,
        date: String(session.firstAt ?? session.lastAt).slice(0, 10),
        turns: session.turns,
        current: session.title,
        source: session.source,
        first: clip(session.prompts[0], 400),
        middle: middle.filter((_, index) => index % step === 0).slice(0, 3).map((prompt) => clip(prompt, 160)),
        last: session.prompts.length > 1 ? clip(session.prompts.at(-1), 200) : "",
        outcome: clip(session.finalAnswer, 300)
      };
    });
  }

  // ------------------------------------------------------------- writing

  titleProblem(title) {
    const value = String(title ?? "");
    if (/[\r\n\t\u0000-\u001f\u007f]/.test(value)) {
      return "A title is one line without control characters.";
    }
    const clean = value.replace(/\s+/g, " ").trim();
    if (clean.length < TITLE_MIN) {
      return "A title needs at least " + TITLE_MIN + " characters.";
    }
    if (clean.length > this.config.max_length) {
      return "A title is at most " + this.config.max_length + " characters (got " + clean.length + ").";
    }
    if (looksSecret(clean)) {
      return "A title must not contain a password, token, card or account number.";
    }
    return null;
  }

  newBatch() {
    return this.now().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14) + "-" + randomBytes(2).toString("hex");
  }

  /**
   * Give one session a title. Owner titles are kept unless force is set; the
   * write is one appended record, the same way Claude Code appends.
   */
  setTitle(session, title, { force = false, dryRun = false, batch = null, runtime = null, reason = "manual" } = {}) {
    const problem = this.titleProblem(title);
    if (problem) {
      throw new Error(problem);
    }
    const clean = String(title).replace(/\s+/g, " ").trim();
    const file = this.resolve(session);
    const id = basename(file, ".jsonl");
    const current = this.titleOf(readFileSync(file, "utf8"), id);
    if (current.source === "owner" && !force) {
      return { id, status: "kept-owner", title: current.title };
    }
    if (current.title === clean) {
      if (!dryRun) {
        this.markNamed(id); // "the title still fits" is an answer too
      }
      return { id, status: "unchanged", title: clean };
    }
    if (dryRun) {
      return { id, status: "would-rename", from: current.title, title: clean };
    }
    appendTitle(file, id, clean);
    const entry = {
      at: this.now().toISOString(),
      batch: batch ?? this.newBatch(),
      id,
      project: basename(dirname(file)),
      oldTitle: current.title,
      oldSource: current.source,
      newTitle: clean,
      runtime,
      reason
    };
    mkdirSync(this.stateRoot, { recursive: true });
    appendFileSync(this.historyPath, JSON.stringify(entry) + "\n");
    this.markNamed(id);
    return { id, status: "renamed", from: current.title, title: clean, batch: entry.batch };
  }

  apply(entries, { force = false, dryRun = false, runtime = null } = {}) {
    if (!Array.isArray(entries)) {
      throw new Error("Expected a JSON array of { id, title }.");
    }
    const batch = this.newBatch();
    const results = entries.map((entry) => {
      try {
        return this.setTitle(entry?.id, entry?.title, { force, dryRun, batch, runtime, reason: "batch" });
      } catch (error) {
        return { id: String(entry?.id ?? ""), status: "error", error: error.message };
      }
    });
    return { batch: results.some((result) => result.status === "renamed") ? batch : null, results };
  }

  /**
   * Restore the titles a batch (default: the last one) or one session replaced.
   * A chat renamed since (by the owner or anyone else) is left as it is.
   */
  undo({ batch = null, session = null } = {}) {
    const history = this.history();
    if (!history.length) {
      return { batch: null, results: [] };
    }
    const sessionId = session ? basename(this.resolve(session), ".jsonl") : null;
    // Undo is not redo: records written by an undo are never undone again.
    const renames = history.filter((entry) => entry.reason !== "undo");
    const target = batch ?? (sessionId ? null : renames.at(-1)?.batch ?? null);
    const selected = renames.filter((entry) => (sessionId ? entry.id === sessionId : entry.batch === target)).reverse();
    const undoBatch = "undo-" + (target ?? sessionId.slice(0, 8)) + "-" + randomBytes(2).toString("hex");
    const seen = new Set();
    const results = [];
    for (const entry of selected) {
      if (seen.has(entry.id)) {
        continue;
      }
      seen.add(entry.id);
      const file = join(this.projectsRoot, entry.project, entry.id + ".jsonl");
      if (!entry.oldTitle || !existsSync(file)) {
        results.push({ id: entry.id, status: "skipped", reason: "no earlier title" });
        continue;
      }
      const current = this.titleOf(readFileSync(file, "utf8"), entry.id);
      if (current.title !== entry.newTitle) {
        results.push({ id: entry.id, status: "skipped", reason: "renamed since to «" + current.title + "»" });
        continue;
      }
      appendTitle(file, entry.id, entry.oldTitle);
      appendFileSync(this.historyPath, JSON.stringify({
        at: this.now().toISOString(),
        batch: undoBatch,
        id: entry.id,
        project: entry.project,
        oldTitle: entry.newTitle,
        oldSource: "astack",
        newTitle: entry.oldTitle,
        restoredSource: entry.oldSource ?? null,
        reason: "undo"
      }) + "\n");
      results.push({ id: entry.id, file, status: "restored", from: entry.newTitle, title: entry.oldTitle });
    }
    return { batch: undoBatch, results };
  }

  // ------------------------------------------------------------- finding

  /** Titles and first prompts of a set of transcripts, rescanning only files that changed. */
  index(options = {}) {
    const cached = readJson(this.indexPath, {});
    const ours = this.ourTitles();
    const next = {};
    let changed = false;
    for (const file of this.sessionFiles(options)) {
      let stat;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }
      const previous = cached[file];
      if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs && previous.ours === (ours.get(basename(file, ".jsonl"))?.signature ?? null)) {
        next[file] = previous;
        continue;
      }
      try {
        const session = this.scan(file, { ours, full: false });
        next[file] = {
          id: session.id,
          project: session.project,
          title: session.title,
          source: session.source,
          first: clip(session.prompts[0], 200),
          lastAt: session.lastAt,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ours: ours.get(session.id)?.signature ?? null
        };
        changed = true;
      } catch {
        // Unreadable right now; try again next time.
      }
    }
    if (changed) {
      try {
        writeJsonAtomic(this.indexPath, { ...cached, ...next });
      } catch {
        // The cache is an optimisation; a failed write costs only speed.
      }
    }
    return Object.values(next);
  }

  /** Sessions whose title (or first prompt) shares the subject of a query. */
  find(query, { project = null, all = false, limit = 5, exclude = null } = {}) {
    const wanted = titleTokens(query);
    if (!wanted.length) {
      return [];
    }
    const entries = this.index({ project, all }).filter((entry) => entry.id !== exclude && (entry.title || entry.first));
    // A word in many titles (the project's own label, "پیگیری") says little;
    // a client name or case number in one or two titles says a lot.
    const frequency = new Map();
    for (const entry of entries) {
      for (const token of titleTokens(entry.title)) {
        frequency.set(token, (frequency.get(token) ?? 0) + 1);
      }
    }
    const rarity = (token) => {
      const count = frequency.get(token) ?? 0;
      return count >= 4 && count / Math.max(1, entries.length) > 0.2 ? 0.25 : 1;
    };
    const hits = [];
    for (const entry of entries) {
      const subject = String(entry.title).split("·")[0];
      const titleSet = new Set(titleTokens(entry.title));
      const subjectSet = new Set(titleTokens(subject));
      const firstSet = new Set(titleTokens(entry.first));
      let score = 0;
      let subjectHit = false;
      const matched = [];
      for (const token of wanted) {
        const weight = (/^\d{3,}$/.test(token) ? 2 : 1) * rarity(token);
        if (subjectSet.has(token)) {
          score += 2 * weight;
          subjectHit ||= weight === 1 || weight === 2;
          matched.push(token);
        } else if (titleSet.has(token)) {
          score += 1.5 * weight;
          matched.push(token);
        } else if (firstSet.has(token)) {
          score += 0.5 * weight;
        }
      }
      if (matched.length && score >= 2) {
        hits.push({ id: entry.id, project: entry.project, title: entry.title || clip(entry.first, 60), source: entry.source, lastAt: entry.lastAt, score: Math.round(score * 10) / 10, subjectHit, matched });
      }
    }
    return hits.sort((a, b) => b.score - a.score || b.lastAt.localeCompare(a.lastAt)).slice(0, limit);
  }

  // ------------------------------------------------------------- remote

  /**
   * Remote Control ids of a session. A chat opened from the phone or the web
   * (Remote Control) also lives on claude.ai as cse_… sessions, and the phone
   * shows *that* title, not the local one. Claude Code's own /rename updates
   * both; this does the same through the same endpoint.
   */
  remoteIds(file) {
    const text = readFileSync(file, "utf8");
    const ids = new Set([...text.matchAll(/"bridgeSessionId":"(cse_[A-Za-z0-9]{8,64})"/g)].map((match) => match[1]));
    // A chat started from the phone runs in a process the Remote Control
    // server spawned; its transcript carries only a local id derived from
    // the cse_ id, so the link comes from the server's per-chat logs.
    for (const remote of this.remoteMap().get(basename(file, ".jsonl")) ?? []) {
      ids.add(remote);
    }
    return [...ids];
  }

  /** Folders where Remote Control servers write their per-chat logs (`--debug-file`). */
  remoteLogDirs() {
    const machine = readJson(this.machineConfigPath(), {});
    const dirs = [join(this.home, ".astack", "remote-control"), ...(Array.isArray(machine.remoteLogDirs) ? machine.remoteLogDirs : []), ...(this.config.remote_log_dirs ?? [])];
    return [...new Set(dirs.map((dir) => String(dir)))].filter((dir) => existsSync(dir));
  }

  machineConfigPath() {
    return join(this.stateRoot, "config.json");
  }

  /** Remember a folder of Remote Control logs for every AStack install on this machine. */
  addRemoteLogDir(dir) {
    const path = String(dir ?? "").trim();
    if (!path || !existsSync(path)) {
      throw new Error("Folder not found: " + (path || "-"));
    }
    const machine = readJson(this.machineConfigPath(), {});
    const dirs = new Set(Array.isArray(machine.remoteLogDirs) ? machine.remoteLogDirs : []);
    dirs.add(path);
    writeJsonAtomic(this.machineConfigPath(), { ...machine, remoteLogDirs: [...dirs] });
    return [...dirs];
  }

  /**
   * local session id → Set of cse_ ids. A chat the Remote Control server
   * spawns for the phone is stored under a local id that Claude Code derives
   * from its cse_ id (remoteLocalId), so the link is computed, never guessed.
   * The cse_ ids come from the servers' per-chat log names and from the
   * account's session list (refreshRemoteList), both cached.
   */
  remoteMap() {
    if (this.remoteMapCache) {
      return this.remoteMapCache;
    }
    const candidates = new Set(readJson(this.remoteListPath(), {})?.ids ?? []);
    for (const dir of this.remoteLogDirs()) {
      try {
        for (const name of readdirSync(dir)) {
          const match = /(cse_[A-Za-z0-9]{8,64}).(log|jsonl)$/.exec(name);
          if (match) {
            candidates.add(match[1]);
          }
        }
      } catch {
        // An unreadable folder adds nothing.
      }
    }
    const map = new Map();
    for (const remote of candidates) {
      const id = remoteLocalId(remote);
      if (!map.has(id)) {
        map.set(id, new Set());
      }
      map.get(id).add(remote);
    }
    this.remoteMapCache = map;
    return map;
  }

  remoteListPath() {
    return join(this.stateRoot, "remote-sessions.json");
  }

  /**
   * Every API call shares one budget inside a hook (Claude Code kills a hook
   * at its timeout): each request gets at most requestTimeoutMs and never
   * runs past the deadline.
   */
  requestSignal() {
    const left = this.deadline ? Math.max(1, this.deadline - Date.now()) : Infinity;
    return AbortSignal.timeout(Math.min(this.requestTimeoutMs ?? 10000, left));
  }

  pastDeadline() {
    return Boolean(this.deadline) && Date.now() >= this.deadline - 250;
  }

  /** Cache the account's Remote Control session ids (at most every maxAgeMs). */
  async refreshRemoteList({ maxAgeMs = 10 * 60000, pages = 20 } = {}) {
    const cached = readJson(this.remoteListPath(), {});
    if (cached?.at && this.now().getTime() - Date.parse(cached.at) < maxAgeMs) {
      return { refreshed: false, count: cached.ids?.length ?? 0 };
    }
    const { token } = this.accessToken();
    if (!token || typeof this.fetch !== "function") {
      return { refreshed: false, count: cached?.ids?.length ?? 0 };
    }
    const ids = new Set(cached?.ids ?? []);
    let cursor = null;
    const save = () => {
      try {
        writeJsonAtomic(this.remoteListPath(), { at: this.now().toISOString(), ids: [...ids] });
      } catch {
        // A cache.
      }
    };
    try {
      for (let page = 0; page < pages && !this.pastDeadline(); page += 1) {
        const url = this.apiBase + "/v1/code/sessions?limit=100" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
        const response = await this.fetch(url, { method: "GET", headers: { Authorization: "Bearer " + token, "anthropic-version": "2023-06-01" }, signal: this.requestSignal() });
        if (response.status !== 200) {
          break;
        }
        const body = await response.json();
        for (const session of body?.data ?? []) {
          if (typeof session?.id === "string" && /^cse_[A-Za-z0-9]{8,64}$/.test(session.id)) {
            ids.add(session.id);
          }
        }
        save(); // newest sessions come first: a hook stopped mid-way still keeps them
        cursor = body?.next_cursor ?? null;
        if (!cursor || !(body?.data ?? []).length) {
          break;
        }
      }
    } catch {
      // Keep what we had.
    }
    save();
    this.remoteMapCache = null;
    return { refreshed: true, count: ids.size };
  }

  /** The phone/web copy's current title, or null when it cannot be read. */
  async remoteTitle(remoteId) {
    if (this.pastDeadline()) {
      return null;
    }
    const { token } = this.accessToken();
    if (!token || typeof this.fetch !== "function") {
      return null;
    }
    try {
      const response = await this.fetch(this.apiBase + "/v1/code/sessions/" + remoteId, {
        method: "GET",
        headers: { Authorization: "Bearer " + token, "anthropic-version": "2023-06-01" },
        signal: this.requestSignal()
      });
      if (response.status !== 200) {
        return null;
      }
      const body = await response.json();
      const title = body?.title ?? body?.session?.title;
      return typeof title === "string" ? title : null;
    } catch {
      return null;
    }
  }

  /** The Claude Code sign-in token, read only here and never returned, logged or stored. */
  accessToken() {
    const credentials = readJson(this.credentialsPath, null);
    const oauth = credentials?.claudeAiOauth;
    if (!oauth?.accessToken) {
      return { token: null, reason: "no Claude Code sign-in on this machine" };
    }
    if (oauth.expiresAt && Number(oauth.expiresAt) <= this.now().getTime()) {
      return { token: null, reason: "Claude Code sign-in expired; open Claude Code once and run `astack session sync`" };
    }
    return { token: oauth.accessToken, reason: null };
  }

  async pushRemote(file, title) {
    const ids = this.remoteIds(file);
    if (!ids.length) {
      return { pushed: 0, failed: 0, remote: 0, reason: "local only" };
    }
    if (!this.config.sync_remote) {
      return { pushed: 0, failed: 0, remote: ids.length, reason: "sync_remote is off" };
    }
    const { token, reason } = this.accessToken();
    if (!token || typeof this.fetch !== "function") {
      return { pushed: 0, failed: ids.length, remote: ids.length, reason: reason ?? "no fetch" };
    }
    let pushed = 0;
    let failed = 0;
    let lastStatus = null;
    for (const id of ids) {
      if (this.pastDeadline()) {
        failed += 1;
        lastStatus = "deadline";
        continue;
      }
      try {
        const response = await this.fetch(this.apiBase + "/v1/code/sessions/" + id, {
          method: "PUT",
          headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ title }),
          signal: this.requestSignal()
        });
        lastStatus = response.status;
        response.status === 200 ? (pushed += 1) : (failed += 1);
      } catch {
        failed += 1;
        lastStatus = "network";
      }
    }
    return { pushed, failed, remote: ids.length, reason: failed ? "server answered " + lastStatus : null };
  }

  /** Push the current titles AStack wrote (latest per session) to their Remote Control copies. */
  async syncRemote({ project = null, all = false, session = null } = {}) {
    await this.refreshRemoteList({ maxAgeMs: 0 });
    const latest = new Map();
    for (const entry of this.history()) {
      latest.set(entry.id, entry);
    }
    const sessionId = session ? basename(this.resolve(session), ".jsonl") : null;
    const scope = sessionId ? null : new Set(this.projectDirectories({ project, all }).map((name) => name.toLowerCase()));
    const totals = { sessions: 0, localOnly: 0, pushed: 0, failed: 0, reasons: {} };
    for (const entry of latest.values()) {
      if (sessionId ? entry.id !== sessionId : !scope.has(String(entry.project).toLowerCase())) {
        continue;
      }
      const file = join(this.projectsRoot, entry.project, entry.id + ".jsonl");
      if (!existsSync(file)) {
        continue;
      }
      const current = this.titleOf(readFileSync(file, "utf8"), entry.id);
      if (current.title !== entry.newTitle) {
        if (current.source === "owner" || !this.healTitle(entry.id, file)) {
          continue; // renamed again by the owner since; theirs wins
        }
      }
      totals.sessions += 1;
      const result = await this.pushRemote(file, entry.newTitle);
      if (!result.remote) {
        totals.localOnly += 1;
      }
      totals.pushed += result.pushed;
      totals.failed += result.failed;
      if (result.failed && result.reason) {
        totals.reasons[result.reason] = (totals.reasons[result.reason] ?? 0) + 1;
      }
    }
    return totals;
  }

  // ------------------------------------------------------------- watching

  statePath(id) {
    return join(this.stateRoot, "sessions", id + ".json");
  }

  readState(id) {
    const state = readJson(this.statePath(id), null) ?? {};
    return {
      turns: Number(state.turns) || 0,
      firstAt: state.firstAt ?? null,
      namedTurn: Number.isFinite(state.namedTurn) ? state.namedTurn : null,
      firstNudges: Number(state.firstNudges) || 0,
      firstNudgedTurn: Number.isFinite(state.firstNudgedTurn) ? state.firstNudgedTurn : null,
      checked: Number(state.checked) || 0,
      ownerSeenTurn: Number.isFinite(state.ownerSeenTurn) ? state.ownerSeenTurn : null,
      reminderTurn: Number.isFinite(state.reminderTurn) ? state.reminderTurn : null,
      enforcedTurn: Number.isFinite(state.enforcedTurn) ? state.enforcedTurn : null,
      pushedTitle: typeof state.pushedTitle === "string" ? state.pushedTitle : null,
      pushTriedTurn: Number.isFinite(state.pushTriedTurn) ? state.pushTriedTurn : null,
      pushTriedTitle: typeof state.pushTriedTitle === "string" ? state.pushTriedTitle : null,
      pullTurn: Number.isFinite(state.pullTurn) ? state.pullTurn : null,
      listTried: state.listTried === true
    };
  }

  writeState(id, state) {
    try {
      writeJsonAtomic(this.statePath(id), state);
    } catch {
      // Watching is best effort; a session must never fail because of it.
    }
  }

  /** After a title is set (or confirmed): no first reminder, and no check that would come right after. */
  markNamed(id) {
    const state = this.readState(id);
    state.namedTurn = state.turns;
    state.checked = Math.max(state.checked, ...this.config.recheck_turns.filter((turn) => turn <= state.turns + this.config.retry_after_turns));
    this.writeState(id, state);
  }

  firstPossible(state) {
    const config = this.config;
    if (state.namedTurn !== null || state.firstNudges >= config.max_nudges) {
      return false;
    }
    if (state.firstNudgedTurn !== null && state.turns - state.firstNudgedTurn < config.retry_after_turns) {
      return false;
    }
    const minutes = state.firstAt ? (this.now().getTime() - Date.parse(state.firstAt)) / 60000 : 0;
    return state.turns >= config.first_after_turns || (state.turns > 1 && minutes >= config.first_after_minutes);
  }

  /**
   * A chat still without AStack's or the owner's title that has run for
   * first_after_minutes, with a first-title reminder left and none given in
   * this turn. The start is the prompt hook's firstAt, or the transcript's
   * first timestamp when the prompt hook never ran.
   */
  longUntitled(state, title, text) {
    const config = this.config;
    if (title.source === "astack" || title.source === "owner" || state.namedTurn !== null) {
      return false;
    }
    if (state.firstNudges >= config.max_nudges || state.enforcedTurn === state.turns || state.reminderTurn === state.turns) {
      return false;
    }
    if (state.firstNudgedTurn !== null && state.turns - state.firstNudgedTurn < config.retry_after_turns) {
      return false;
    }
    const started = Date.parse(state.firstAt ?? text.match(/"timestamp":"([^"]+)"/)?.[1] ?? "");
    return Number.isFinite(started) && (this.now().getTime() - started) / 60000 >= config.first_after_minutes;
  }

  /** The re-check point reached and not handled yet (one reminder each, no retries). */
  pendingCheckpoint(state) {
    const reached = this.config.recheck_turns.filter((turn) => state.turns >= turn && turn > state.checked && turn > (state.namedTurn ?? 0));
    return reached.length ? Math.max(...reached) : null;
  }

  /** Cheap test before reading the transcript: long chats run to many megabytes. */
  couldBeDue(state) {
    if (state.ownerSeenTurn !== null && state.turns - state.ownerSeenTurn < 10) {
      return false;
    }
    return this.firstPossible(state) || this.pendingCheckpoint(state) !== null;
  }

  /**
   * The naming step due at this prompt: "first" while the chat has no title of
   * AStack's or the owner's (repeated after retry_after_turns, at most
   * max_nudges times), then one "recheck" per configured turn.
   */
  dueStep(state, title) {
    if (title.source === "owner") {
      return null;
    }
    if (title.source !== "astack") {
      return this.firstPossible(state) ? { kind: "first" } : null;
    }
    const checkpoint = this.pendingCheckpoint(state);
    return checkpoint === null ? null : { kind: "recheck", checkpoint };
  }

  instruction(step, { id, title }) {
    const config = this.config;
    step = step?.kind ?? step;
    const language = LANGUAGE_NAMES[config.language] ?? config.language;
    const command = "node \"" + this.cli + "\" session title --session=" + id + " -- \"<title>\"";
    const lines = [];
    if (step === "first") {
      lines.push(
        "Session title due: this chat is " + (title.title ? "still on the automatic title «" + title.title + "»" : "untitled") + ".",
        "Before you finish this turn, give it a precise title so the owner can find and continue this chat later instead of opening a new one."
      );
    } else {
      lines.push(
        "Session title check: this chat is titled «" + title.title + "» and has grown since.",
        "If its main subject has changed, give it a better title now; if the title still fits, do nothing."
      );
    }
    lines.push(
      "Set it with the MCP tool astack_session_title (session=" + id + ") or `" + command + "`.",
      "Rules: «<subject> · <what is being done>»; plain " + language + ", 3–8 words, at most " + config.max_length + " characters; the subject is what the owner would search for (project, client, case, site or system).",
      "Legal work: the party or case label first, a court or case number only with a short label next to it and only if it appears in the chat; never an amount.",
      "Latin only for domains, repo names and IDs, never as the first or last word; no secrets. Do it quietly — no need to mention it unless asked."
    );
    if (config.hint) {
      lines.push("Project naming hint: " + config.hint);
    }
    return lines.join("\n");
  }

  /**
   * UserPromptSubmit hook for Claude Code. Returns the extra context for this
   * prompt, or null. Never throws: a failure here must not cost the owner a turn.
   */
  promptHook(payload = {}) {
    try {
      if (!this.config.enabled) {
        return null;
      }
      const id = String(payload.session_id ?? "");
      const file = payload.transcript_path ? String(payload.transcript_path) : null;
      if (!SESSION_ID.test(id) || !file) {
        return null;
      }
      const state = this.readState(id);
      state.turns += 1;
      state.firstAt ??= this.now().toISOString();
      // Claude Code writes the transcript after the first prompt: count that
      // prompt anyway, or one-prompt chats never reach a first title.
      if (!existsSync(file)) {
        this.writeState(id, state);
        return null;
      }
      const parts = [];
      if (state.turns === 1 && this.config.suggest_existing && payload.prompt) {
        const similar = this.find(cleanPrompt(payload.prompt), { project: basename(dirname(file)), limit: 3, exclude: id }).filter((hit) => hit.subjectHit || hit.score >= 3);
        if (similar.length) {
          parts.push(
            "Earlier chats in this project look like the same subject:",
            ...similar.map((hit) => "- «" + hit.title + "» (session " + hit.id.slice(0, 8) + ", last active " + hit.lastAt.slice(0, 10) + ")"),
            "If this request continues one of them, tell the owner in one line that they can continue it from the chat list under that title instead of a new chat; then carry on with the request."
          );
        }
      }
      // Read the transcript only when the counters say a step could be due:
      // long legal chats run to many megabytes and this runs on every prompt.
      if (this.couldBeDue(state)) {
        const title = this.titleOf(readFileSync(file, "utf8"), id);
        if (title.source === "owner") {
          state.ownerSeenTurn = state.turns; // look again in a few prompts, never for good
        } else {
          state.ownerSeenTurn = null;
          if (title.source === "astack" && state.namedTurn === null) {
            state.namedTurn = 0; // titled by AStack before this hook counted
          }
          const step = this.dueStep(state, title);
          if (step?.kind === "first") {
            state.firstNudges += 1;
            state.firstNudgedTurn = state.turns;
            state.reminderTurn = state.turns;
          } else if (step?.kind === "recheck") {
            state.checked = step.checkpoint;
          } else {
            // Nothing to ask at this point (reminders used up): move past it so
            // the transcript is not read again until the next point.
            state.checked = Math.max(state.checked, this.pendingCheckpoint(state) ?? 0);
          }
          if (step) {
            parts.push(this.instruction(step, { id, title }));
          }
        }
      }
      this.writeState(id, state);
      return parts.length ? parts.join("\n\n") : null;
    } catch {
      return null;
    }
  }

  /**
   * Claude Code Stop hook, at the end of every reply.
   *
   * 1. A first title was asked for in this turn and the agent did not set it:
   *    block the stop once with the exact command, so the chat is named in
   *    the same reply. Never twice in one turn, never while Claude Code is
   *    already continuing because of a stop hook.
   * 2. Phone/web copy: push a new AStack title; pull a title the owner set on
   *    the phone since our last push (it becomes the owner's title here).
   *
   * Returns { block: reason } or null. Never throws.
   */
  async stopHook(payload = {}) {
    // One budget for every network call in this hook, well inside its timeout.
    this.deadline = Date.now() + 12000;
    this.requestTimeoutMs = 4000;
    try {
      if (!this.config.enabled) {
        return null;
      }
      const id = String(payload.session_id ?? "");
      const file = payload.transcript_path ? String(payload.transcript_path) : null;
      if (!SESSION_ID.test(id) || !file || !existsSync(file)) {
        return null;
      }
      const state = this.readState(id);
      const history = this.history();
      const ours = this.ourTitles(history);
      let text = readFileSync(file, "utf8");
      let title = this.titleOf(text, id, ours);
      if (title.source === "ai" || title.source === "none") {
        const healed = this.healTitle(id, file, { history, current: title });
        if (healed) {
          text = readFileSync(file, "utf8");
          title = this.titleOf(text, id, this.ourTitles());
        }
      }
      if (
        state.reminderTurn !== null && state.reminderTurn === state.turns && state.enforcedTurn !== state.turns &&
        payload.stop_hook_active !== true && title.source !== "astack" && title.source !== "owner"
      ) {
        state.enforcedTurn = state.turns;
        this.writeState(id, state);
        const command = "node \"" + this.cli + "\" session title --session=" + id + " -- \"<title>\"";
        return {
          block: "Before finishing, set this chat's title (it is " + (title.title ? "still «" + title.title + "»" : "untitled") + "): call astack_session_title (session=" + id + ") or run `" + command + "`. " +
            "Shape «<subject> · <what is being done>», plain " + (LANGUAGE_NAMES[this.config.language] ?? this.config.language) + ", at most " + this.config.max_length + " characters; legal work: party or case label first. Then stop; say nothing about it."
        };
      }
      // A long chat with one or two prompts (a phone order, a scheduled run)
      // never reaches the prompt hook's turn count: name it at the end of a
      // reply once it has run first_after_minutes.
      if (payload.stop_hook_active !== true && this.longUntitled(state, title, text)) {
        state.firstNudges += 1;
        state.firstNudgedTurn = state.turns;
        state.reminderTurn = state.turns;
        state.enforcedTurn = state.turns;
        this.writeState(id, state);
        return { block: this.instruction("first", { id, title }) + "\nThen stop; say nothing about it." };
      }
      if (this.config.sync_remote && (title.source === "astack" || state.pushedTitle)) {
        await this.syncOne(id, file, title, state, { text, history });
      }
      this.writeState(id, state);
      return null;
    } catch {
      return null;
    } finally {
      this.deadline = null;
      this.requestTimeoutMs = null;
    }
  }

  /**
   * Claude Code sometimes rewrites a transcript from the title it holds in
   * memory, which drops a title AStack appended. When a chat is back on an
   * automatic or missing title, write back the latest title in the history:
   * AStack's, or the owner's when the latest record is an owner title AStack
   * restored or pulled from the phone (it stays the owner's). Returns the
   * title written, or null.
   */
  healTitle(id, file, { history = this.history(), current = null } = {}) {
    const latest = history.filter((entry) => entry.id === id).at(-1);
    if (!latest?.newTitle) {
      return null;
    }
    const now = current ?? this.titleOf(readFileSync(file, "utf8"), id);
    if (now.source !== "ai" && now.source !== "none") {
      return null;
    }
    appendTitle(file, id, latest.newTitle);
    return latest.newTitle;
  }

  /**
   * Push AStack's title to the phone copy, or take the owner's phone rename.
   * A rename is accepted only from a single linked copy, only after a push
   * that reached every copy, only when it is a valid title and not one of
   * Claude Code's automatic titles; it is recorded as the owner's.
   */
  async syncOne(id, file, title, state, { text = readFileSync(file, "utf8"), history = this.history() } = {}) {
    let remotes = this.remoteIds(file);
    if (!remotes.length && !state.listTried) {
      // A chat opened on the phone after the last list refresh: look once per chat.
      // Marked only when a refresh really ran; a still-fresh list is looked at again later.
      const refresh = await this.refreshRemoteList({ pages: 2 });
      state.listTried = refresh.refreshed;
      remotes = this.remoteIds(file);
    }
    if (!remotes.length) {
      return;
    }
    const latest = history.filter((entry) => entry.id === id).at(-1);
    if (state.pushedTitle && title.title === state.pushedTitle) {
      if (remotes.length !== 1 || (state.pullTurn !== null && state.turns - state.pullTurn < 3)) {
        return;
      }
      state.pullTurn = state.turns;
      const remoteTitle = await this.remoteTitle(remotes[0]);
      const clean = String(remoteTitle ?? "").replace(/\s+/g, " ").trim();
      const automatic = new Set([...text.matchAll(/"aiTitle":"((?:[^"\\]|\\.)*)"/g)].map((match) => {
        try {
          return JSON.parse('"' + match[1] + '"');
        } catch {
          return match[1];
        }
      }));
      if (clean && clean !== state.pushedTitle && !automatic.has(clean) && !this.titleProblem(clean)) {
        appendTitle(file, id, clean);
        mkdirSync(this.stateRoot, { recursive: true });
        appendFileSync(this.historyPath, JSON.stringify({
          at: this.now().toISOString(), batch: "remote-" + this.newBatch(), id, project: basename(dirname(file)),
          oldTitle: title.title, oldSource: title.source, newTitle: clean, restoredSource: "owner", reason: "remote-owner"
        }) + "\n");
        state.pushedTitle = clean;
      }
      return;
    }
    // Only AStack's own current title goes to the phone, never an owner's.
    if (title.source !== "astack" || latest?.newTitle !== title.title || latest?.restoredSource === "owner") {
      return;
    }
    // A failed push of the same title is retried every few replies, not every one.
    if (state.pushTriedTitle === title.title && state.pushTriedTurn !== null && state.turns - state.pushTriedTurn < 3) {
      return;
    }
    state.pushTriedTurn = state.turns;
    state.pushTriedTitle = title.title;
    const result = await this.pushRemote(file, title.title);
    if (result.pushed && !result.failed) {
      state.pushedTitle = title.title;
    }
  }

  // ------------------------------------------------------------- user hook

  /**
   * One prompt hook in ~/.claude/settings.json covers every chat on the
   * machine, including projects without AStack. A project that has its own
   * AStack prompt hook (and so its own naming hint) answers for itself; the
   * user hook then stays silent there, so no chat is counted twice.
   */
  userSettingsPath() {
    return join(this.home, ".claude", "settings.json");
  }

  userHookCommand(cli = this.cli, step = "prompt") {
    // The light entry point beside the CLI: it fires on every prompt and reply.
    const hook = String(cli).replace(/\\/g, "/").replace(/astack\.mjs$/, "astack-title-hook.mjs");
    return "node \"" + hook + "\" " + (step === "stop" ? USER_STOP_MARKER : USER_HOOK_MARKER);
  }

  userHookStatus() {
    const settings = readJson(this.userSettingsPath(), {});
    const commands = (event) => (settings?.hooks?.[event] ?? []).flatMap((group) => group?.hooks ?? []).map((hook) => String(hook?.command ?? ""));
    const prompt = commands("UserPromptSubmit").find((command) => command.includes(USER_HOOK_MARKER)) ?? null;
    const stop = commands("Stop").find((command) => command.includes(USER_STOP_MARKER)) ?? null;
    // Installed means both halves; a 3.6 install has only the prompt hook.
    return { installed: Boolean(prompt && stop), prompt: Boolean(prompt), stop: Boolean(stop), command: prompt, path: this.userSettingsPath() };
  }

  /** Add (or refresh) the user-level hook; every other setting and hook is kept. A backup is written first. */
  installUserHook({ cli = this.cli, dryRun = false, remove = false } = {}) {
    const hookFile = String(cli).replace(/astack\.mjs$/, "astack-title-hook.mjs");
    if (!remove && !existsSync(hookFile)) {
      throw new Error("The core at " + dirname(dirname(hookFile)) + " has no bin/astack-title-hook.mjs yet; update it first (astack update), or pass --cli.");
    }
    const path = this.userSettingsPath();
    let raw = null;
    let settings = {};
    if (existsSync(path)) {
      raw = readFileSync(path, "utf8");
      try {
        settings = JSON.parse(raw);
      } catch {
        throw new Error("~/.claude/settings.json is not valid JSON; fix it by hand first.");
      }
    }
    const hooks = { ...(settings.hooks ?? {}) };
    for (const [event, step, marker, timeout] of [["UserPromptSubmit", "prompt", USER_HOOK_MARKER, 15], ["Stop", "stop", USER_STOP_MARKER, 20]]) {
      const groups = (Array.isArray(hooks[event]) ? hooks[event] : [])
        .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !String(hook?.command ?? "").includes(marker)) }))
        .filter((group) => group.hooks.length);
      if (!remove) {
        groups.push({ hooks: [{ type: "command", command: this.userHookCommand(cli, step), timeout }] });
      }
      if (groups.length) {
        hooks[event] = groups;
      } else {
        delete hooks[event];
      }
    }
    const next = { ...settings, hooks };
    if (!Object.keys(hooks).length) {
      delete next.hooks;
    }
    const text = JSON.stringify(next, null, 2) + "\n";
    const changed = text !== raw;
    let backup = null;
    if (changed && !dryRun) {
      if (raw !== null) {
        backup = path + ".astack-backup-" + this.now().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
        writeFileSync(backup, raw);
      }
      writeJsonAtomicText(path, text);
    }
    return { path, changed, backup, installed: !remove };
  }

  // ------------------------------------------------------------- status

  status({ project = null, all = false } = {}) {
    const entries = this.index({ project, all });
    const counts = { total: entries.length, astack: 0, owner: 0, ai: 0, none: 0 };
    for (const entry of entries) {
      counts[entry.source] = (counts[entry.source] ?? 0) + 1;
    }
    const history = this.history();
    return {
      enabled: this.config.enabled,
      projects: this.projectDirectories({ project, all }),
      counts,
      lastBatch: history.at(-1)?.batch ?? null,
      renamed: history.filter((entry) => entry.reason !== "undo").length,
      config: this.config
    };
  }
}
