import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open as openAsync } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { redactSecretsStrict } from "../lib/text.mjs";
import { cleanUserText } from "../search-engine/sources/sessions.mjs";
import { SessionTitles } from "../interop-engine/session-titles.mjs";

/**
 * Projects and sessions hub: every project folder under `<claude home>/projects`
 * and the Claude Code sessions (transcripts) inside it, with owner metadata
 * (pin, archive, tags), titles, search and 7-day token usage.
 *
 * Transcripts can be hundreds of megabytes, so a list card is built from the
 * head and the tail of a file only and cached by (mtime, size). Titles follow
 * the AStack session-title engine (the same records `astack session title`
 * writes), so a rename here reaches the phone like any other.
 */

export class ProjectsError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{7,80}$/;
const SLUG = /^[A-Za-z0-9._-]{1,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_NAME = /^agent-[A-Za-z0-9_-]{1,64}$/;
const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 256 * 1024;
const MAX_HEAD_BYTES = 2 * 1024 * 1024;
const BACK_BLOCK = 1024 * 1024;
const BACK_BLOCKS = 3;
const LIVE_MS = 2 * 60 * 1000;
const USAGE_DAYS = 7;
const USAGE_CHUNK = 4 * 1024 * 1024;
const MAX_USAGE_FILE = 400 * 1024 * 1024;
const MAX_LINE = 64 * 1024 * 1024;
// A first line (a pasted screenshot) longer than the head window is read whole, up to this size.
const MAX_BIG_HEAD = 16 * 1024 * 1024;
const LINE_SCAN_CHUNK = 1024 * 1024;
// Cold summaries are built in slices of this many milliseconds, so the server keeps answering.
const WARM_SLICE_MS = 12;
// Prefilters only: the parsed record decides. The optional space covers hand-formatted JSON.
const TITLE_RECORDS = /"type":\s*"(custom-title|ai-title|summary)"/;
const MESSAGE_RECORDS = /"type":\s*"(user|assistant)"/;
const SORTS = new Set(["updated", "started", "turns"]);
const COLOR = /^(#[0-9a-fA-F]{3,8}|[a-z]{3,16})$/;
const MAX_TAGS = 12;
const MAX_TAG_LENGTH = 32;

function readRange(path, start, length) {
  const handle = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(handle, buffer, 0, length, start);
    return buffer.subarray(0, read);
  } finally {
    closeSync(handle);
  }
}

/**
 * Byte offset just after the newline that ends the line containing `from`,
 * scanned in chunks without decoding. `size` when the line runs to the end of
 * the file, null when it is longer than `limit` bytes from the start.
 */
function lineEndAfter(path, from, size, limit) {
  let position = from;
  while (position < size && position < limit) {
    const chunk = readRange(path, position, Math.min(LINE_SCAN_CHUNK, size - position));
    if (!chunk.length) {
      return size;
    }
    const at = chunk.indexOf(10);
    if (at !== -1) {
      return position + at + 1;
    }
    position += chunk.length;
  }
  return position >= size ? size : null;
}

function isPlain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function oneLine(text, max) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

/** Search folding: case, Arabic/Persian letter and digit variants, zero-width joiners. */
function fold(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[‌‍ـ]/g, "");
}

function userContent(content) {
  if (typeof content === "string") {
    return { text: cleanUserText(content), image: false, toolOnly: false };
  }
  if (!Array.isArray(content)) {
    return { text: "", image: false, toolOnly: false };
  }
  const texts = [];
  let image = false;
  let tools = 0;
  for (const block of content) {
    if (block?.type === "text") {
      texts.push(block.text ?? "");
    } else if (block?.type === "image") {
      image = true;
    } else if (block?.type === "tool_result") {
      tools += 1;
    }
  }
  return { text: cleanUserText(texts.join("\n\n")), image, toolOnly: tools > 0 && !texts.length };
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function dayOf(timestamp) {
  return String(timestamp ?? "").slice(0, 10);
}

/**
 * What a list card needs from the text of one slice of a transcript (head or
 * tail): the first real prompt, activity, titles and the bookkeeping fields.
 */
function readSlice(text, { agentFile = false } = {}) {
  const out = {
    sessionId: null,
    cwd: null,
    firstPrompt: "",
    firstAt: null,
    lastAt: null,
    model: null,
    gitBranch: null,
    customTitle: null,
    aiTitle: null,
    summary: null,
    users: 0,
    main: 0,
    side: 0
  };
  const lines = text.split("\n");
  for (const line of lines) {
    if (!line) {
      continue;
    }
    // The regexes only decide whether a line is worth parsing; a nested
    // {"type":"summary"} inside a tool input must not hide a real message.
    if (!TITLE_RECORDS.test(line) && !MESSAGE_RECORDS.test(line)) {
      if (!out.sessionId) {
        const found = /"sessionId":\s*"([^"]+)"/.exec(line);
        out.sessionId = found ? found[1] : null;
      }
      continue;
    }
    const entry = parseLine(line);
    if (!entry) {
      continue;
    }
    out.sessionId ??= entry.sessionId ?? null;
    if (entry.type === "custom-title" || entry.type === "ai-title" || entry.type === "summary") {
      if (entry.type === "custom-title" && entry.customTitle) {
        out.customTitle = String(entry.customTitle);
      } else if (entry.type === "ai-title" && entry.aiTitle) {
        out.aiTitle = String(entry.aiTitle);
      } else if (entry.type === "summary" && entry.summary) {
        out.summary = String(entry.summary);
      }
      continue;
    }
    if (entry.type !== "user" && entry.type !== "assistant") {
      continue;
    }
    if (entry.isSidechain && !agentFile) {
      out.side += 1;
      continue;
    }
    entry.isSidechain ? (out.side += 1) : (out.main += 1);
    out.cwd ??= entry.cwd ?? null;
    if (entry.timestamp) {
      out.firstAt ??= entry.timestamp;
      out.lastAt = entry.timestamp > (out.lastAt ?? "") ? entry.timestamp : out.lastAt;
    }
    if (entry.gitBranch) {
      out.gitBranch = entry.gitBranch;
    }
    if (entry.type === "assistant") {
      const model = entry.message?.model;
      if (model && !String(model).startsWith("<")) {
        out.model = String(model);
      }
      continue;
    }
    if (entry.isMeta || entry.isCompactSummary) {
      continue;
    }
    const { text: prompt, image, toolOnly } = userContent(entry.message?.content);
    if (toolOnly || (!prompt && !image)) {
      continue;
    }
    out.users += 1;
    if (!out.firstPrompt) {
      out.firstPrompt = prompt || "[image]";
    }
  }
  return out;
}

export class ProjectsHub {
  constructor({
    claudeHome,
    metaPath,
    clock = null,
    chatProjects = () => [],
    titles = null,
    titlesHome = null,
    titlesRoot = null,
    titlesConfig = {},
    fetchImpl = null,
    syncRemote = true,
    log = () => {}
  } = {}) {
    if (!claudeHome) {
      throw new Error("ProjectsHub needs claudeHome");
    }
    if (!metaPath) {
      throw new Error("ProjectsHub needs metaPath");
    }
    this.claudeHome = resolve(claudeHome);
    this.projectsRoot = join(this.claudeHome, "projects");
    this.metaPath = metaPath;
    this.clock = clock ?? (() => new Date());
    this.chatProjects = chatProjects;
    this.log = log;
    this.syncRemote = syncRemote;
    this.titles = titles ?? new SessionTitles({
      home: titlesHome ?? homedir(),
      projectsRoot: this.projectsRoot,
      stateRoot: titlesRoot,
      credentialsPath: join(this.claudeHome, ".credentials.json"),
      config: titlesConfig,
      clock: this.clock,
      fetchImpl
    });
    this.summaries = new Map();
    this.projectPaths = new Map();
    this.usageFiles = new Map();
    this.meta = null;
    this.metaKey = "";
    this.metaCorrupt = false;
    this.warming = new Map();
    this.ours = { key: "", value: new Map() };
  }

  now() {
    return this.clock().getTime();
  }

  // -------------------------------------------------------------- metadata

  loadMeta() {
    let key = "none";
    try {
      const stat = statSync(this.metaPath);
      key = stat.mtimeMs + ":" + stat.size;
    } catch {
      key = "none";
    }
    if (this.meta && key === this.metaKey) {
      return this.meta;
    }
    let data = null;
    let unreadable = null;
    if (key !== "none") {
      try {
        // A leading byte order mark (Notepad, PowerShell 5.1) is not an error.
        const parsed = JSON.parse(readFileSync(this.metaPath, "utf8").replace(/^﻿/, ""));
        if (!isPlain(parsed)) {
          throw new Error("the top level is not an object");
        }
        for (const field of ["sessions", "projects"]) {
          if (parsed[field] !== undefined && !isPlain(parsed[field])) {
            throw new Error(field + " is not an object");
          }
        }
        data = parsed;
      } catch (error) {
        unreadable = String(error?.message ?? error);
      }
    }
    // A file that exists but cannot be read is never silently replaced: the
    // next write keeps a copy of it first.
    this.metaCorrupt = unreadable !== null;
    if (unreadable !== null) {
      this.log("[console] projects-meta.json is unreadable (" + unreadable + "); a copy is kept before the next write");
    }
    this.meta = {
      version: 1,
      sessions: data?.sessions ?? {},
      projects: data?.projects ?? {}
    };
    this.metaKey = key;
    return this.meta;
  }

  /**
   * Write the whole store atomically. The in-memory copy changes only after the
   * rename succeeded, so a failed write (Windows can hold the file for a moment)
   * never looks saved. An unreadable file is copied aside before it is replaced.
   */
  saveMeta(next) {
    mkdirSync(dirname(this.metaPath), { recursive: true });
    if (this.metaCorrupt) {
      const stamp = new Date(this.now()).toISOString().replace(/[-:.]/g, "").slice(0, 15);
      try {
        copyFileSync(this.metaPath, this.metaPath + ".corrupt-" + stamp + "-" + randomBytes(3).toString("hex"));
      } catch {
        throw new ProjectsError(500, "projects-meta.json is unreadable and could not be backed up; fix or move it aside");
      }
    }
    const temporary = this.metaPath + "." + process.pid + "." + randomBytes(4).toString("hex") + ".tmp";
    let lastError = null;
    try {
      writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n");
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          this.renameImpl(temporary, this.metaPath);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          // Windows holds the target for a moment (antivirus, indexer, sync client): wait and retry.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30 * (attempt + 1));
        }
      }
    } catch (error) {
      lastError = error;
    }
    if (lastError) {
      rmSync(temporary, { force: true });
      throw lastError;
    }
    this.meta = next;
    this.metaCorrupt = false;
    try {
      const stat = statSync(this.metaPath);
      this.metaKey = stat.mtimeMs + ":" + stat.size;
    } catch {
      this.metaKey = "";
    }
  }

  /** The rename step, replaceable in tests to simulate a locked file. */
  renameImpl(from, to) {
    renameSync(from, to);
  }

  /** A deep copy of the store to change; it becomes the store only once it is saved. */
  editableMeta() {
    return structuredClone(this.loadMeta());
  }

  // ------------------------------------------------------------- projects

  /** Project folders grouped by lower-cased name (Windows drive letters appear in both cases). */
  projectGroups() {
    let names = [];
    try {
      names = readdirSync(this.projectsRoot);
    } catch {
      return new Map();
    }
    const groups = new Map();
    for (const name of names.sort()) {
      const directory = join(this.projectsRoot, name);
      try {
        if (!statSync(directory).isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }
      const key = name.toLowerCase();
      groups.set(key, [...(groups.get(key) ?? []), directory]);
    }
    return groups;
  }

  groupOf(project) {
    const id = String(project ?? "");
    if (!SLUG.test(id)) {
      throw new ProjectsError(400, "invalid project id");
    }
    const directories = this.projectGroups().get(id.toLowerCase());
    if (!directories) {
      throw new ProjectsError(404, "project not found");
    }
    return { id: id.toLowerCase(), directories };
  }

  /** Top-level transcript files of a project (agent files included, flagged). */
  transcriptFiles(directories) {
    const files = [];
    for (const directory of directories) {
      let names = [];
      try {
        names = readdirSync(directory);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) {
          continue;
        }
        const id = name.slice(0, -6);
        const agent = AGENT_NAME.test(id);
        if (!agent && !UUID.test(id)) {
          continue;
        }
        const path = join(directory, name);
        let stat;
        try {
          stat = statSync(path);
        } catch {
          continue;
        }
        if (stat.isFile()) {
          files.push({ path, directory, id, agent, stat });
        }
      }
    }
    return files;
  }

  projectPath(key, files) {
    const known = this.projectPaths.get(key);
    if (known) {
      return known;
    }
    const newest = files.filter((file) => !file.agent).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, 5);
    for (const file of newest) {
      try {
        const text = readRange(file.path, 0, Math.min(file.stat.size, HEAD_BYTES)).toString("utf8");
        const found = /"cwd":\s*("(?:[^"\\]|\\.)*")/.exec(text);
        if (found) {
          const path = JSON.parse(found[1]);
          if (path) {
            this.projectPaths.set(key, path);
            return path;
          }
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  chatKeys() {
    let list = [];
    try {
      list = this.chatProjects() ?? [];
    } catch {
      list = [];
    }
    return new Set(list.map((path) => resolve(String(path)).toLowerCase()));
  }

  projects() {
    const meta = this.loadMeta();
    const chat = this.chatKeys();
    const now = this.now();
    const list = [];
    for (const [key, directories] of this.projectGroups()) {
      const files = this.transcriptFiles(directories);
      this.pruneSummaries(directories, files);
      // The same rule as the default session list: no empty files, sidechains or archived chats.
      const chats = files.filter((file) => this.isChat(file));
      const sessions = chats.filter((file) => meta.sessions[file.id]?.archived !== true);
      const path = this.projectPath(key, files);
      const own = meta.projects[key] ?? {};
      let updated = 0;
      let live = 0;
      for (const file of chats) {
        updated = Math.max(updated, file.stat.mtimeMs);
        if (now - file.stat.mtimeMs < LIVE_MS) {
          live += 1;
        }
      }
      list.push({
        id: key,
        name: redactSecretsStrict(path ? basename(path) || path : key),
        path: path ? redactSecretsStrict(path) : null,
        label: own.label ? redactSecretsStrict(own.label) : null,
        color: own.color ?? null,
        pinned: own.pinned === true,
        sessions: sessions.length,
        live,
        updatedAt: updated ? new Date(updated).toISOString() : null,
        chatEnabled: path ? chat.has(resolve(path).toLowerCase()) : false
      });
    }
    list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")) || a.id.localeCompare(b.id));
    return list;
  }

  setProjectMeta(id, patch = {}) {
    const { id: key } = this.groupOf(id);
    const meta = this.editableMeta();
    const own = { ...(meta.projects[key] ?? {}) };
    if (patch.pinned !== undefined) {
      own.pinned = strictBool(patch.pinned, "pinned");
    }
    if (patch.label !== undefined) {
      if (patch.label !== null && typeof patch.label !== "string") {
        throw new ProjectsError(400, "label is a string");
      }
      const label = String(patch.label ?? "").replace(/\s+/g, " ").trim();
      if (label.length > 60) {
        throw new ProjectsError(400, "label is at most 60 characters");
      }
      label ? (own.label = label) : delete own.label;
    }
    if (patch.color !== undefined) {
      if (patch.color !== null && typeof patch.color !== "string") {
        throw new ProjectsError(400, "color is a hex value like #ff8800 or a colour name");
      }
      const color = String(patch.color ?? "").trim();
      if (color && !COLOR.test(color)) {
        throw new ProjectsError(400, "color is a hex value like #ff8800 or a colour name");
      }
      color ? (own.color = color) : delete own.color;
    }
    if (own.pinned || own.label || own.color) {
      meta.projects[key] = own;
    } else {
      delete meta.projects[key];
    }
    this.saveMeta(meta);
    return this.projects().find((project) => project.id === key);
  }

  // ------------------------------------------------------------- sessions

  /** Raw list-card facts of one transcript, cached by (mtime, size). */
  summaryOf(file) {
    const key = file.stat.mtimeMs + ":" + file.stat.size;
    const cached = this.summaries.get(file.path);
    if (cached?.key === key) {
      return cached.value;
    }
    const value = this.summarize(file);
    this.summaries.set(file.path, { key, value });
    return value;
  }

  /** A real chat of its own: not an empty file (queue operations only), not a sidechain. */
  isChat(file) {
    if (file.agent) {
      return false;
    }
    try {
      const raw = this.summaryOf(file);
      return !raw.empty && !raw.sidechain;
    } catch {
      return false;
    }
  }

  /** Forget the summaries of transcripts that left these folders, so the cache follows the disk. */
  pruneSummaries(directories, files) {
    const present = new Set(files.map((file) => file.path));
    for (const path of this.summaries.keys()) {
      if (directories.includes(dirname(path)) && !present.has(path)) {
        this.summaries.delete(path);
      }
    }
  }

  /**
   * Build the list-card summaries that are missing, in short slices that give
   * the event loop back in between. The first listing after a restart reads
   * the head and tail of every transcript; done inside one request it would
   * stall the whole server (chat streams, events, logins). A route awaits this
   * first, so the synchronous listing that follows only meets cached files.
   */
  warm({ project = null, sidechains = "0" } = {}) {
    const groups = project ? [this.groupOf(project)] : [...this.projectGroups()].map(([id, directories]) => ({ id, directories }));
    const withAgents = truthy(sidechains);
    const key = (project ? groups[0].id : "*") + (withAgents ? "+agents" : "");
    const running = this.warming.get(key);
    if (running) {
      return running;
    }
    const job = (async () => {
      let sliceStart = performance.now();
      const yieldNow = async () => {
        if (performance.now() - sliceStart >= WARM_SLICE_MS) {
          await new Promise((done) => setImmediate(done));
          sliceStart = performance.now();
        }
      };
      let built = 0;
      for (const group of groups) {
        const files = this.transcriptFiles(group.directories);
        this.pruneSummaries(group.directories, files);
        await yieldNow();
        for (const file of files) {
          if (file.agent && !withAgents) {
            continue;
          }
          const cached = this.summaries.get(file.path);
          if (cached?.key === file.stat.mtimeMs + ":" + file.stat.size) {
            continue;
          }
          try {
            this.summaryOf(file);
            built += 1;
          } catch {
            // unreadable now; the listing skips it the same way
          }
          await yieldNow();
        }
      }
      return built;
    })().finally(() => this.warming.delete(key));
    this.warming.set(key, job);
    return job;
  }

  summarize(file) {
    const size = file.stat.size;
    const agentFile = file.agent;
    const whole = size <= HEAD_BYTES + TAIL_BYTES;
    // The head ends on a line boundary: `end` is a byte offset, not a string length.
    const readHead = (length) => {
      const buffer = readRange(file.path, 0, Math.min(length, size));
      if (buffer.length >= size) {
        return { text: buffer.toString("utf8"), end: buffer.length };
      }
      const end = buffer.lastIndexOf(10) + 1;
      return { text: buffer.subarray(0, end).toString("utf8"), end };
    };
    let window = whole ? size : HEAD_BYTES;
    let headRead = readHead(window);
    let head = readSlice(headRead.text, { agentFile });
    // A first prompt longer than the head window: widen it, up to a cap.
    while (!head.firstPrompt && headRead.end < size && window < MAX_HEAD_BYTES) {
      window = Math.min(size, window * 4);
      headRead = readHead(window);
      head = readSlice(headRead.text, { agentFile });
    }
    // Still no prompt and the window ends inside a line: a pasted screenshot can make the
    // first line larger than the cap. Find where it ends without decoding it, then read on.
    let giantBytes = 0;
    if (!head.firstPrompt && headRead.end < size) {
      const lineEnd = lineEndAfter(file.path, headRead.end, size, MAX_BIG_HEAD);
      if (lineEnd !== null && lineEnd < MAX_BIG_HEAD) {
        giantBytes = lineEnd - headRead.end;
        headRead = readHead(Math.min(size, lineEnd + HEAD_BYTES));
        head = readSlice(headRead.text, { agentFile });
      }
    }
    const headEnd = headRead.end;
    // The tail starts on a line boundary too, so no line falls between head and tail.
    let tail = null;
    let tailStart = size;
    if (headEnd < size) {
      const from = Math.max(headEnd, size - TAIL_BYTES);
      let buffer;
      if (from > headEnd) {
        // One byte earlier tells whether `from` is already the start of a line.
        buffer = readRange(file.path, from - 1, size - from + 1);
        const newline = buffer[0] === 10 ? 0 : buffer.indexOf(10);
        const skip = newline === -1 ? buffer.length : newline + 1;
        tailStart = from - 1 + skip;
        buffer = buffer.subarray(skip);
      } else {
        buffer = readRange(file.path, headEnd, size - headEnd);
        tailStart = headEnd;
      }
      if (buffer.length) {
        tail = readSlice(buffer.toString("utf8"), { agentFile });
      }
    }
    const gap = tailStart > headEnd;
    let customTitle = tail?.customTitle ?? head.customTitle;
    let aiTitle = tail?.aiTitle ?? head.aiTitle;
    let summary = tail?.summary ?? head.summary;
    // A rename long before the tail: look back a few blocks through the unread middle.
    if (!customTitle && gap) {
      const back = this.titlesBefore(file, tailStart, headEnd);
      customTitle = back.customTitle ?? customTitle;
      aiTitle = aiTitle ?? back.aiTitle;
      summary = summary ?? back.summary;
    }
    const last = tail ?? head;
    const users = head.users + (tail?.users ?? 0);
    const sampled = headEnd + (size - tailStart);
    const exact = !gap;
    // The oversized first line is one prompt: its bytes say nothing about how dense the rest of the chat is.
    const turns = exact ? users : Math.max(users, Math.round((users / Math.max(1, sampled - giantBytes)) * (size - giantBytes)));
    const sidechain = agentFile || (head.side > 0 && head.main === 0) || (Boolean(tail) && head.main === 0 && tail.main === 0 && tail.side > 0);
    const parent = sidechain && head.sessionId && head.sessionId !== file.id ? head.sessionId : null;
    return {
      customTitle,
      aiTitle,
      summary,
      // Cards and search use 200 characters; the cache keeps a little more, not a whole pasted log.
      firstPrompt: oneLine(head.firstPrompt, 400),
      startedAt: head.firstAt ?? null,
      lastAt: last.lastAt ?? head.lastAt ?? null,
      turns,
      turnsApprox: !exact,
      model: tail?.model ?? head.model ?? null,
      gitBranch: tail?.gitBranch ?? head.gitBranch ?? null,
      cwd: head.cwd ?? tail?.cwd ?? null,
      sidechain,
      parent,
      empty: head.main + (tail?.main ?? 0) === 0 && !sidechain
    };
  }

  /**
   * Titles in the unread middle of a file, newest block first. Blocks overlap on
   * the line a block boundary cuts, so a record on a seam is read whole by the
   * block above it; `end` and `floor` are line boundaries.
   */
  titlesBefore(file, end, floor = 0) {
    const found = { customTitle: null, aiTitle: null, summary: null };
    let upper = end;
    for (let block = 0; block < BACK_BLOCKS && upper > floor; block += 1) {
      const start = Math.max(floor, upper - BACK_BLOCK);
      const raw = readRange(file.path, start, upper - start);
      let cut = 0;
      if (start > floor) {
        const newline = raw.indexOf(10);
        cut = newline === -1 ? raw.length : newline + 1;
      }
      const text = raw.subarray(cut).toString("utf8");
      if (text.includes("-title\"") || text.includes("\"summary\"")) {
        const slice = readSlice(text, { agentFile: file.agent });
        found.customTitle ??= slice.customTitle;
        found.aiTitle ??= slice.aiTitle;
        found.summary ??= slice.summary;
      }
      if (found.customTitle) {
        break;
      }
      // The next block ends where this one's first whole line starts (the cut line belongs to it).
      upper = start > floor && start + cut < upper ? start + cut : start;
    }
    return found;
  }

  ourTitles() {
    let key = "none";
    try {
      const stat = statSync(this.titles.historyPath);
      key = stat.mtimeMs + ":" + stat.size;
    } catch {
      key = "none";
    }
    if (this.ours.key !== key) {
      this.ours = { key, value: this.titles.ourTitles() };
    }
    return this.ours.value;
  }

  /** AStack or owner title first, then Claude's summary, then its generated title, then the first prompt. */
  titleOf(id, raw, ours) {
    if (raw.customTitle) {
      const info = ours.get(id);
      const astack = info && info.owner !== raw.customTitle && info.titles.has(raw.customTitle);
      return { title: raw.customTitle, source: astack ? "astack" : "owner" };
    }
    if (raw.summary) {
      return { title: raw.summary, source: "summary" };
    }
    if (raw.aiTitle) {
      return { title: raw.aiTitle, source: "ai" };
    }
    if (raw.firstPrompt) {
      return { title: raw.firstPrompt, source: "prompt" };
    }
    return { title: "", source: "none" };
  }

  hasSubagents(file) {
    const folder = join(file.directory, file.id, "subagents");
    if (!existsSync(folder)) {
      return false;
    }
    try {
      return readdirSync(folder).some((name) => name.endsWith(".jsonl"));
    } catch {
      return false;
    }
  }

  item(file, project, ours, meta, chat) {
    const raw = this.summaryOf(file);
    const { title, source } = this.titleOf(file.id, raw, ours);
    const own = meta.sessions[file.id] ?? {};
    const updatedAt = new Date(file.stat.mtimeMs).toISOString();
    return {
      id: file.id,
      project: project.id,
      projectName: project.name,
      title: redactSecretsStrict(oneLine(title, source === "prompt" ? 100 : 140)) || file.id.slice(0, 8),
      titleSource: source,
      firstPrompt: redactSecretsStrict(oneLine(raw.firstPrompt, 200)),
      startedAt: raw.startedAt,
      updatedAt,
      turns: raw.turns,
      turnsApprox: raw.turnsApprox,
      model: raw.model,
      gitBranch: raw.gitBranch && raw.gitBranch !== "HEAD" ? raw.gitBranch : null,
      sizeBytes: file.stat.size,
      hasSubagents: file.agent ? false : this.hasSubagents(file),
      live: this.now() - file.stat.mtimeMs < LIVE_MS,
      sidechain: raw.sidechain,
      parent: raw.parent,
      pinned: own.pinned === true,
      archived: own.archived === true,
      tags: Array.isArray(own.tags) ? own.tags.map((tag) => redactSecretsStrict(tag)) : [],
      chatEnabled: chat
    };
  }

  /** Sessions of one project (or of all when no project is given), filtered, sorted and paged. */
  sessions({ project = null, q = "", tag = "", archived = "0", pinned = "", live = "", sort = "updated", page = 1, size = 30, sidechains = "0" } = {}, { privateView = false } = {}) {
    const groups = project ? [this.groupOf(project)] : [...this.projectGroups()].map(([id, directories]) => ({ id, directories }));
    const meta = this.loadMeta();
    const ours = this.ourTitles();
    const chat = this.chatKeys();
    const wantArchived = truthy(archived);
    const wantTag = fold(tag).trim();
    const tokens = fold(q).split(/\s+/).filter(Boolean);
    const order = SORTS.has(sort) ? sort : "updated";
    const all = [];
    for (const group of groups) {
      const files = this.transcriptFiles(group.directories);
      this.pruneSummaries(group.directories, files);
      const path = this.projectPath(group.id, files);
      const info = { id: group.id, name: redactSecretsStrict(path ? basename(path) || path : group.id) };
      const enabled = path ? chat.has(resolve(path).toLowerCase()) : false;
      for (const file of files) {
        if (file.agent && !truthy(sidechains)) {
          continue;
        }
        let entry;
        try {
          if (this.summaryOf(file).empty) {
            continue;
          }
          entry = this.item(file, info, ours, meta, enabled);
        } catch {
          continue;
        }
        if (entry.sidechain && !truthy(sidechains)) {
          continue;
        }
        if (entry.archived !== wantArchived) {
          continue;
        }
        if (isSet(pinned) && entry.pinned !== truthy(pinned)) {
          continue;
        }
        if (isSet(live) && entry.live !== truthy(live)) {
          continue;
        }
        if (wantTag && !entry.tags.some((value) => fold(value) === wantTag)) {
          continue;
        }
        if (tokens.length) {
          // A private view never searches what it does not show (title, prompt, folder name): a match would leak the hidden text.
          const shown = privateView ? [] : [entry.title, entry.firstPrompt, entry.projectName];
          const hay = fold([...shown, entry.tags.join(" "), meta.projects[group.id]?.label ?? "", entry.id].join(" "));
          if (!tokens.every((token) => hay.includes(token))) {
            continue;
          }
        }
        all.push(entry);
      }
    }
    const key = (entry) => (order === "turns" ? entry.turns : order === "started" ? String(entry.startedAt ?? "") : entry.updatedAt);
    all.sort((a, b) => {
      if (a.pinned !== b.pinned) {
        return Number(b.pinned) - Number(a.pinned);
      }
      const left = key(a);
      const right = key(b);
      const diff = typeof left === "number" ? right - left : String(right).localeCompare(String(left));
      return diff || a.id.localeCompare(b.id);
    });
    const perPage = Math.min(100, Math.max(1, Number(size) || 30));
    const pages = Math.max(1, Math.ceil(all.length / perPage));
    const current = Math.min(pages, Math.max(1, Number(page) || 1));
    const items = all.slice((current - 1) * perPage, current * perPage);
    return { items: privateView ? items.map(privateSession) : items, total: all.length, page: current, pages, size: perPage };
  }

  locate(id) {
    const value = String(id ?? "");
    if (!SESSION_NAME.test(value)) {
      throw new ProjectsError(400, "invalid session id");
    }
    for (const [key, directories] of this.projectGroups()) {
      for (const directory of directories) {
        const path = join(directory, value + ".jsonl");
        if (existsSync(path)) {
          const stat = statSync(path);
          return { project: key, directories, file: { path, directory, id: value, agent: AGENT_NAME.test(value), stat } };
        }
      }
    }
    throw new ProjectsError(404, "session not found");
  }

  session(id) {
    const found = this.locate(id);
    const files = this.transcriptFiles(found.directories);
    const path = this.projectPath(found.project, files);
    const info = { id: found.project, name: redactSecretsStrict(path ? basename(path) || path : found.project) };
    const enabled = path ? this.chatKeys().has(resolve(path).toLowerCase()) : false;
    const entry = this.item(found.file, info, this.ourTitles(), this.loadMeta(), enabled);
    const raw = this.summaryOf(found.file);
    const cwd = raw.cwd ?? path;
    return {
      ...entry,
      subagents: this.subagentsOf(found.file),
      resume: { command: "claude --resume " + found.file.id, cwd: cwd ? redactSecretsStrict(cwd) : null }
    };
  }

  subagentsOf(file) {
    const folder = join(file.directory, file.id, "subagents");
    let names = [];
    try {
      names = readdirSync(folder);
    } catch {
      return [];
    }
    return names.filter((name) => name.endsWith(".jsonl") && AGENT_NAME.test(name.slice(0, -6))).slice(0, 200).map((name) => {
      const agent = name.slice(0, -6);
      let meta = {};
      try {
        meta = JSON.parse(readFileSync(join(folder, agent + ".meta.json"), "utf8"));
      } catch {
        meta = {};
      }
      let size = 0;
      try {
        size = statSync(join(folder, name)).size;
      } catch {
        size = 0;
      }
      return {
        id: agent,
        type: meta.agentType ? redactSecretsStrict(String(meta.agentType).slice(0, 60)) : null,
        description: meta.description ? redactSecretsStrict(oneLine(meta.description, 120)) : null,
        sizeBytes: size
      };
    });
  }

  setSessionMeta(id, patch = {}) {
    const found = this.locate(id);
    const meta = this.editableMeta();
    const own = { ...(meta.sessions[found.file.id] ?? {}) };
    if (patch.pinned !== undefined) {
      own.pinned = strictBool(patch.pinned, "pinned");
    }
    if (patch.archived !== undefined) {
      own.archived = strictBool(patch.archived, "archived");
    }
    if (patch.tags !== undefined) {
      own.tags = cleanTags(patch.tags);
    }
    if (own.pinned || own.archived || own.tags?.length) {
      meta.sessions[found.file.id] = { ...(own.pinned ? { pinned: true } : {}), ...(own.archived ? { archived: true } : {}), ...(own.tags?.length ? { tags: own.tags } : {}) };
    } else {
      delete meta.sessions[found.file.id];
    }
    this.saveMeta(meta);
    return this.session(found.file.id);
  }

  /**
   * Rename through the session-title engine: the same record `astack session
   * title` appends, so the title survives, shows in `claude --resume` and is
   * pushed to the phone copy (Remote Control) when there is one.
   */
  async rename(id, title) {
    const found = this.locate(id);
    if (found.file.agent) {
      throw new ProjectsError(400, "a sub-agent transcript has no title of its own");
    }
    let result;
    try {
      result = this.titles.setTitle(found.file.id, title, { force: true, runtime: "console", reason: "manual" });
    } catch (error) {
      throw new ProjectsError(400, redactSecretsStrict(String(error.message ?? error)));
    }
    let remote = null;
    // session_titles.sync_remote: false means no call to Anthropic at all (syncRemote lists the account's sessions first).
    if (this.syncRemote && this.titles.config?.sync_remote !== false && result.status === "renamed") {
      try {
        remote = await Promise.race([
          this.titles.syncRemote({ session: found.file.id }),
          new Promise((done) => setTimeout(() => done(null), 5000).unref())
        ]);
      } catch {
        remote = null;
      }
    }
    return { ...this.session(found.file.id), rename: { status: result.status, remote } };
  }

  // ---------------------------------------------------------------- usage

  /** Tokens per day over the last 7 days (UTC days), read lazily and incrementally per transcript. */
  async usage({ project } = {}) {
    const { directories } = this.groupOf(project);
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const days = [];
    for (let back = USAGE_DAYS - 1; back >= 0; back -= 1) {
      days.push(new Date(Date.parse(today + "T00:00:00Z") - back * 86400000).toISOString().slice(0, 10));
    }
    const first = days[0];
    const oldest = Date.parse(first + "T00:00:00Z") - 86400000;
    const candidates = [];
    for (const file of this.transcriptFiles(directories)) {
      candidates.push(file);
      if (!file.agent && file.stat.mtimeMs >= oldest) {
        const folder = join(file.directory, file.id, "subagents");
        let names = [];
        try {
          names = readdirSync(folder);
        } catch {
          names = [];
        }
        for (const name of names) {
          if (name.endsWith(".jsonl")) {
            try {
              const path = join(folder, name);
              candidates.push({ path, directory: folder, id: name.slice(0, -6), agent: true, stat: statSync(path) });
            } catch {
              continue;
            }
          }
        }
      }
    }
    const messages = new Map();
    let scanned = 0;
    let skipped = 0;
    let anonymous = 0;
    const kept = new Set();
    for (const file of candidates) {
      if (file.stat.mtimeMs < oldest) {
        continue;
      }
      if (file.stat.size > MAX_USAGE_FILE) {
        skipped += 1;
        continue;
      }
      const record = await this.scanUsage(file, first);
      kept.add(file.path);
      scanned += 1;
      for (const [key, value] of record.messages) {
        if (value.day < first) {
          // The window only moves forward: a day that left it is never needed again.
          record.messages.delete(key);
          continue;
        }
        // A resumed chat repeats earlier replies: one message counts once.
        messages.set(key.startsWith("anon:") ? "anon:" + file.path + ":" + (anonymous += 1) : key, value);
      }
    }
    // Forget the per-file scans of this project that left the window or the disk.
    for (const path of [...this.usageFiles.keys()]) {
      if (!kept.has(path) && directories.some((directory) => path.startsWith(directory + sep))) {
        this.usageFiles.delete(path);
      }
    }
    const table = new Map(days.map((date) => [date, { date, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }]));
    for (const [, value] of messages) {
      const row = table.get(value.day);
      if (row) {
        row.input += value.input;
        row.output += value.output;
        row.cacheRead += value.cacheRead;
        row.cacheWrite += value.cacheWrite;
      }
    }
    const rows = [...table.values()];
    const total = rows.reduce((sum, row) => ({ input: sum.input + row.input, output: sum.output + row.output, cacheRead: sum.cacheRead + row.cacheRead, cacheWrite: sum.cacheWrite + row.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    return { project: this.groupOf(project).id, days: rows, total, files: scanned, skipped, timezone: "UTC" };
  }

  async scanUsage(file, firstDay = "") {
    let entry = this.usageFiles.get(file.path);
    if (entry && entry.size === file.stat.size && entry.mtimeMs === file.stat.mtimeMs) {
      return entry;
    }
    // Transcripts are append-only: continue where the last scan stopped.
    if (!entry || file.stat.size < entry.offset) {
      entry = { size: 0, mtimeMs: 0, offset: 0, messages: new Map(), counter: 0 };
    }
    const handle = await openAsync(file.path, "r");
    try {
      let position = entry.offset;
      let carry = Buffer.alloc(0);
      const buffer = Buffer.alloc(USAGE_CHUNK);
      while (position < file.stat.size) {
        const { bytesRead } = await handle.read(buffer, 0, USAGE_CHUNK, position);
        if (!bytesRead) {
          break;
        }
        position += bytesRead;
        const data = carry.length ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : Buffer.from(buffer.subarray(0, bytesRead));
        const end = data.lastIndexOf(10);
        if (end === -1) {
          carry = data.length > MAX_LINE ? Buffer.alloc(0) : data;
          continue;
        }
        collectUsage(data.subarray(0, end).toString("latin1"), entry, firstDay);
        carry = data.subarray(end + 1);
        entry.offset = position - carry.length;
      }
    } finally {
      await handle.close();
    }
    entry.size = file.stat.size;
    entry.mtimeMs = file.stat.mtimeMs;
    this.usageFiles.set(file.path, entry);
    return entry;
  }
}

function collectUsage(text, entry, firstDay = "") {
  for (const line of text.split("\n")) {
    if (!line.includes("\"usage\":{") || !line.includes("\"type\":\"assistant\"")) {
      continue;
    }
    const at = line.indexOf("\"usage\":{");
    const block = line.slice(at, at + 700);
    const number = (name) => {
      const found = new RegExp("\"" + name + "\":(\\d+)").exec(block);
      return found ? Number(found[1]) : 0;
    };
    const stamp = /"timestamp":"(\d{4}-\d{2}-\d{2})/.exec(line);
    if (!stamp || stamp[1] < firstDay) {
      continue;
    }
    const id = /"id":"(msg_[A-Za-z0-9_]+)"/.exec(line);
    const key = id ? id[1] : "anon:" + (entry.counter += 1);
    entry.messages.set(key, {
      day: stamp[1],
      input: number("input_tokens"),
      output: number("output_tokens"),
      cacheRead: number("cache_read_input_tokens"),
      cacheWrite: number("cache_creation_input_tokens")
    });
  }
}

/**
 * The internet listener's view: ids, counts, timestamps, model and the
 * owner's own organising metadata (pin, archive, tags, label, colour). Titles,
 * first prompts, branches, sub-agent descriptions and file paths stay on this
 * machine, because prompts can carry private material.
 */
export function privateProject(project) {
  // The folder name can be a client or case name that is not in the id: show the owner's label, else the id.
  return project ? { ...project, name: project.label ?? project.id, path: null, private: true } : project;
}

export function privateSession(entry) {
  if (!entry) {
    return entry;
  }
  const view = { ...entry, title: null, titleSource: null, firstPrompt: null, gitBranch: null, projectName: entry.project ?? null, private: true };
  if (Array.isArray(entry.subagents)) {
    view.subagents = entry.subagents.map((agent) => ({ ...agent, description: null }));
  }
  if (entry.resume) {
    view.resume = { ...entry.resume, cwd: null };
  }
  return view;
}

function truthy(value) {
  return value === true || value === 1 || value === "1" || value === "true" || value === "yes";
}

/** For stored flags: anything that is not clearly yes or no is a mistake, not a silent "no". */
function strictBool(value, name) {
  if (truthy(value)) {
    return true;
  }
  if (value === false || value === 0 || value === "0" || value === "false" || value === "no" || value === null || value === "") {
    return false;
  }
  throw new ProjectsError(400, name + " is true or false");
}

function isSet(value) {
  return value !== undefined && value !== null && value !== "";
}

function cleanTags(value) {
  if (value !== null && value !== undefined && typeof value !== "string" && !Array.isArray(value)) {
    throw new ProjectsError(400, "tags are a list of strings");
  }
  if (Array.isArray(value) && value.some((item) => typeof item !== "string")) {
    throw new ProjectsError(400, "tags are a list of strings");
  }
  const list =Array.isArray(value) ? value : String(value ?? "").split(",");
  const tags = [];
  for (const raw of list) {
    const tag = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!tag) {
      continue;
    }
    if (tag.length > MAX_TAG_LENGTH || /[\u0000-\u001f\u007f]/.test(tag)) {
      throw new ProjectsError(400, "a tag is at most " + MAX_TAG_LENGTH + " characters, without control characters");
    }
    if (!tags.some((existing) => fold(existing) === fold(tag))) {
      tags.push(tag);
    }
  }
  if (tags.length > MAX_TAGS) {
    throw new ProjectsError(400, "at most " + MAX_TAGS + " tags per session");
  }
  return tags;
}
