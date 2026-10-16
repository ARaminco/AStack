import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { redactCredentialWords, redactLabelledBase32, redactTokenShapes } from "../lib/redact.mjs";
import { estimateTokens, INJECTION_PATTERNS } from "../lib/text.mjs";
import { isUnattended } from "../trust-engine/approvals.mjs";

export const DEFAULT_BLOCK_LIMIT = 1500;
export const MAX_BLOCK_LIMIT = 8000;

const SCOPE = /^(owner|system|(agent|project|case|role|team|entity):[a-z0-9][a-z0-9._-]{0,63})$/;
const LABEL = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Active memory: small, named, size-limited blocks that are always in context.
 *
 * The facet store is long-term (archival) memory: large, searchable, recalled
 * on demand. Blocks are the working set an agent carries into every turn — the
 * owner's standing facts, an agent's persona and goals, the state of one case.
 * An agent edits its own blocks (append, replace, set) and the edits are
 * versioned: every change is a new line in an append-only JSONL file, so a
 * block's history and any earlier version stay answerable and restorable.
 *
 * A block never grows past its limit. An append that would overflow moves the
 * oldest lines into the facet store (bound to the block's scope) before it is
 * applied, so nothing is lost; it only leaves the active window.
 */
export class MemoryBlocks {
  constructor(root, { clock, facets = null } = {}) {
    this.root = root;
    this.directory = join(root, ".astack", "memory", "blocks");
    this.path = join(this.directory, "blocks.jsonl");
    this.clock = clock ?? (() => new Date());
    this.facets = facets;
    this.cache = null;
  }

  now() {
    return this.clock().toISOString();
  }

  static parseId(id) {
    const value = String(id ?? "").trim();
    const slash = value.lastIndexOf("/");
    const scope = slash > 0 ? value.slice(0, slash) : "";
    const label = slash > 0 ? value.slice(slash + 1) : "";
    if (!SCOPE.test(scope) || !LABEL.test(label)) {
      throw new Error(
        "Invalid block id: " + value + ". Use <scope>/<label>, scope owner, system or agent|project|case|role|team|entity:<id>, label lowercase (e.g. case:2026-003/state)"
      );
    }
    return { id: scope + "/" + label, scope, label };
  }

  static validScope(scope) {
    return SCOPE.test(String(scope ?? ""));
  }

  versions() {
    if (!existsSync(this.path)) {
      return [];
    }
    const raw = readFileSync(this.path, "utf8");
    if (this.cache?.raw === raw) {
      return this.cache.lines;
    }
    const lines = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = JSON.parse(line);
        if (entry?.id) {
          lines.push(entry);
        }
      } catch {
        // A torn line is skipped, never fatal: the versions around it survive.
      }
    }
    this.cache = { raw, lines };
    return lines;
  }

  latest() {
    const map = new Map();
    for (const entry of this.versions()) {
      map.set(entry.id, entry);
    }
    return map;
  }

  get(id) {
    const { id: key } = MemoryBlocks.parseId(id);
    const entry = this.latest().get(key);
    return entry && !entry.deleted ? entry : null;
  }

  list({ scope = null, scopes = null } = {}) {
    const wanted = scopes ?? (scope ? [scope] : null);
    return [...this.latest().values()]
      .filter((entry) => !entry.deleted)
      .filter((entry) => !wanted || wanted.includes(entry.scope))
      .sort((a, b) => scopeOrder(a.scope) - scopeOrder(b.scope) || a.id.localeCompare(b.id));
  }

  history(id) {
    const { id: key } = MemoryBlocks.parseId(id);
    return this.versions().filter((entry) => entry.id === key);
  }

  write(entry) {
    mkdirSync(this.directory, { recursive: true });
    appendFileSync(this.path, JSON.stringify(entry) + "\n", "utf8");
    this.cache = null;
    return entry;
  }

  guard(value) {
    const text = String(value ?? "").replace(/\r\n?/g, "\n");
    if (looksSecret(text)) {
      throw new Error("Refused: the text looks like it contains a secret (password, token, card or account number). Secrets are never stored in memory.");
    }
    if (looksLikeInstruction(text)) {
      throw new Error("Refused: the text reads like an instruction to override the system or skip an approval. Active memory is always in context, so it only holds facts.");
    }
    return text;
  }

  /**
   * Read-only blocks change only with force, and force is the owner's: an
   * unattended run or an MCP call can never use it.
   */
  checkWritable(current, { force = false, id = null } = {}) {
    const latest = current ?? (id ? this.history(id).at(-1) ?? null : null);
    if (!latest?.readOnly) {
      return;
    }
    if (!force) {
      throw new Error("Block " + latest.id + " is read-only. Only the owner can change it (CLI with --force).");
    }
    if (process.env.ASTACK_MCP === "1" || isUnattended()) {
      throw new Error("Block " + latest.id + " is read-only; --force is refused in unattended runs and over MCP.");
    }
  }

  /**
   * Create a block or replace its whole value.
   */
  set(id, value, { limit = null, description = null, readOnly = null, managed = null, source = "manual", force = false } = {}) {
    const parsed = MemoryBlocks.parseId(id);
    const current = this.get(parsed.id);
    this.checkWritable(current, { force });
    const text = this.guard(String(value ?? "")).trim();
    if (!text) {
      throw new Error("Refused: an empty value would wipe " + parsed.id + ". To retire the block use: astack memory block remove " + parsed.id);
    }
    const cap = clampLimit(limit ?? current?.limit ?? DEFAULT_BLOCK_LIMIT);
    if (text.length > cap) {
      throw new Error("Block " + parsed.id + " is limited to " + cap + " characters; the new value has " + text.length + ". Shorten it or raise --limit.");
    }
    if (current && current.value === text && current.limit === cap && (description === null || description === current.description) && (readOnly === null || readOnly === current.readOnly)) {
      return { block: current, changed: false, evicted: [] };
    }
    const block = this.write({
      id: parsed.id,
      scope: parsed.scope,
      label: parsed.label,
      version: (current?.version ?? this.lastVersion(parsed.id)) + 1,
      value: text,
      limit: cap,
      description: description ?? current?.description ?? null,
      readOnly: readOnly ?? current?.readOnly ?? false,
      managed: managed ?? current?.managed ?? false,
      at: this.now(),
      source
    });
    return { block, changed: true, evicted: [] };
  }

  /**
   * Add a line. When the block would overflow, its oldest lines move to the
   * long-term store first.
   */
  append(id, text, { source = "manual", force = false, limit = null } = {}) {
    const parsed = MemoryBlocks.parseId(id);
    const current = this.get(parsed.id);
    this.checkWritable(current, { force });
    const addition = this.guard(String(text ?? "").trim());
    if (!addition) {
      throw new Error("Nothing to append");
    }
    const cap = clampLimit(limit ?? current?.limit ?? DEFAULT_BLOCK_LIMIT);
    if (addition.length > cap) {
      throw new Error("The text (" + addition.length + " characters) is larger than the whole block (" + cap + "). Store it with memory remember instead.");
    }
    const lines = current?.value ? current.value.split("\n") : [];
    const evicted = [];
    while (lines.length && [...lines, addition].join("\n").length > cap) {
      evicted.push(lines.shift());
    }
    const archived = evicted.length ? this.archive(parsed, evicted, source) : null;
    const value = [...lines, addition].join("\n");
    const block = this.write({
      id: parsed.id,
      scope: parsed.scope,
      label: parsed.label,
      version: (current?.version ?? this.lastVersion(parsed.id)) + 1,
      value,
      limit: cap,
      description: current?.description ?? null,
      readOnly: current?.readOnly ?? false,
      managed: current?.managed ?? false,
      at: this.now(),
      source
    });
    return { block, changed: true, evicted, archived };
  }

  /**
   * Exact replacement: the old text must occur exactly once. An empty new text
   * deletes the passage.
   */
  replace(id, oldText, newText, { source = "manual", force = false } = {}) {
    const parsed = MemoryBlocks.parseId(id);
    const current = this.get(parsed.id);
    if (!current) {
      throw new Error("Unknown block: " + parsed.id);
    }
    this.checkWritable(current, { force });
    const needle = String(oldText ?? "").replace(/\r\n?/g, "\n");
    if (!needle) {
      throw new Error("The text to replace is empty");
    }
    const occurrences = current.value.split(needle).length - 1;
    if (occurrences !== 1) {
      throw new Error(occurrences === 0
        ? "The text to replace was not found in " + parsed.id + ". Read the block first (memory block show)."
        : "The text to replace occurs " + occurrences + " times in " + parsed.id + "; include more of it so it is unique.");
    }
    const replacement = this.guard(String(newText ?? ""));
    const value = current.value.replace(needle, () => replacement).replace(/\n{3,}/g, "\n\n").trim();
    if (value.length > current.limit) {
      throw new Error("The result would be " + value.length + " characters; block " + parsed.id + " is limited to " + current.limit + ".");
    }
    const block = this.write({ ...current, version: current.version + 1, value, at: this.now(), source });
    return { block, changed: value !== current.value, evicted: [] };
  }

  /**
   * Retire a block. The tombstone is a new version: history stays readable and
   * `restore` brings any earlier value back.
   */
  remove(id, { source = "manual", force = false } = {}) {
    const parsed = MemoryBlocks.parseId(id);
    const current = this.get(parsed.id);
    if (!current) {
      throw new Error("Unknown block: " + parsed.id);
    }
    this.checkWritable(current, { force });
    this.write({ ...current, version: current.version + 1, deleted: true, at: this.now(), source });
    return current;
  }

  restore(id, version, { source = "manual", force = false } = {}) {
    const parsed = MemoryBlocks.parseId(id);
    const target = this.history(parsed.id).find((entry) => entry.version === Number(version) && !entry.deleted);
    if (!target) {
      throw new Error("Block " + parsed.id + " has no version " + version);
    }
    const current = this.get(parsed.id);
    this.checkWritable(current, { force, id: parsed.id });
    const owner = target.source === "memory-reflect" ? target.source : source;
    const block = this.write({ ...target, version: this.lastVersion(parsed.id) + 1, at: this.now(), source: owner, restoredBy: source, restoredFrom: target.version, deleted: undefined });
    return { block, changed: true, evicted: [] };
  }

  lastVersion(id) {
    return this.history(id).reduce((max, entry) => Math.max(max, entry.version ?? 0), 0);
  }

  archive(parsed, lines, source) {
    if (!this.facets) {
      return null;
    }
    const binding = scopeBinding(parsed.scope);
    const record = this.facets.append("semantic", {
      title: "Archived from active memory " + parsed.id,
      body: lines.join("\n"),
      project: binding.project,
      entities: binding.entities,
      tags: ["block:" + parsed.id, "evicted"],
      importance: 0.5,
      source: "block-eviction:" + source
    });
    return record.id;
  }

  /**
   * Render blocks as a context section inside a token budget. Scopes are
   * rendered in a fixed order (owner, system, project, case, team, role,
   * agent) and a block that does not fit is named, never silently dropped.
   */
  render({ scopes = null, budget = 1200 } = {}) {
    const blocks = this.list({ scopes });
    const lines = [];
    const omitted = [];
    let used = 0;
    for (const block of blocks) {
      const header = "### " + block.id + " (" + block.value.length + "/" + block.limit + (block.readOnly ? ", read-only" : "") + ")";
      const body = block.value.split("\n").filter((line) => line.trim());
      const cost = estimateTokens([header, ...body].join("\n"));
      if (used + cost > budget) {
        omitted.push(block.id);
        continue;
      }
      used += cost;
      lines.push(header, ...body);
    }
    if (omitted.length) {
      lines.push("(not shown, over budget: " + omitted.join(", ") + "; `astack memory block show <id>`)");
    }
    return { lines, tokens: used, blocks: blocks.length, rendered: blocks.length - omitted.length, omitted };
  }

  stats() {
    const blocks = this.list();
    return {
      blocks: blocks.length,
      versions: this.versions().length,
      characters: blocks.reduce((sum, block) => sum + block.value.length, 0),
      scopes: [...new Set(blocks.map((block) => block.scope))]
    };
  }
}

// Instructions that would ride along in every context: role prefixes, and
// "always/automatically" or "without approval" next to an irreversible
// action, unless the line negates it ("never pay without approval" is a
// fact). Whitespace is collapsed first, so spacing and line breaks do not
// hide a known pattern.
const ROLE_PREFIX = /^\s*(system|assistant|developer)\s*:\s*(you |ignore |disregard |forget |always |never |do |must |send |approve |delete |publish |reveal |from now on)/im;
const ACTIONS = "(approve|pay|send|publish|submit|delete|transfer|wire|forward)";
const AUTO_ACTION = new RegExp("\\b(always|automatically|auto-?)\\b[^.\\n]{0,30}\\b" + ACTIONS + "\\b|\\b" + ACTIONS + "\\b[^.\\n]{0,40}\\bwithout (asking|approval|confirmation|permission|the owner)\\b", "i");
const AUTO_ACTION_FA = /(بدون|بی)\s*(تایید|تأیید|اجازه|هماهنگی)[^.\n]{0,40}(ارسال کن|بفرست|پرداخت کن|ثبت کن|منتشر کن|حذف کن|واریز کن)|(همیشه|خودکار)[^.\n]{0,30}(ارسال کن|بفرست|پرداخت کن|ثبت کن|منتشر کن|تایید کن|تأیید کن)/;
// "Always send … after owner approval" is a standing preference, not a bypass.
const GATED = /\b(after|with|once|upon|following|subject to)\b[^.\n]{0,25}\b(approv|confirm|sign-?off|review)/i;
const GATED_FA = /(بعد|پس) از (تایید|تأیید|اجازه)|با (تایید|تأیید|اجازه)/;
const UNGATED_FA = /(بدون|بی)\s*(تایید|تأیید|اجازه|هماهنگی)/;
const NEGATION = /\b(never|not|don't|do not|must not|no)\b|هرگز|نکن|نفرست|نباید|ممنوع/i;

/** True when a text reads like an instruction rather than a fact. */
export function looksLikeInstruction(text) {
  const raw = String(text ?? "");
  const collapsed = raw.replace(/\s+/g, " ");
  if (INJECTION_PATTERNS.some((pattern) => pattern.test(raw) || pattern.test(collapsed))) {
    return true;
  }
  if (ROLE_PREFIX.test(raw)) {
    return true;
  }
  // "after review … without approval" is not gated: a "without" phrase wins.
  return raw.split(/\n|(?<=[.!؟?])\s/).some((line) => ((AUTO_ACTION.test(line) && (!GATED.test(line) || /\bwithout (asking|approval|confirmation|permission)\b/i.test(line))) || (AUTO_ACTION_FA.test(line) && (UNGATED_FA.test(line) || !GATED_FA.test(line)))) && !NEGATION.test(line));
}

// English credential words only with an explicit assignment ("api_key=…",
// "token: …") and JWT shapes, so "token budget" or "password policy" stay.
const ASSIGNED_SECRET = /\b(api[_-]?key|access[_-]?token|token|secret|bearer|authorization|cookie|client[_-]?secret)\s*["']?\s*[:=]\s*["']?[^\s"',;]{6,}/i;
const JWT = /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;

/** True when a text carries something shaped like a credential or card. */
export function looksSecret(text) {
  const value = String(text ?? "");
  if (ASSIGNED_SECRET.test(value) || JWT.test(value)) {
    return true;
  }
  return redactCredentialWords(redactTokenShapes(redactLabelledBase32(value), { opaque: true, hex: false })) !== value;
}

/** The project and entity a scope binds archived records to. */
export function scopeBinding(scope) {
  const value = String(scope ?? "");
  if (value.startsWith("project:")) {
    return { project: value.slice(8), entities: [] };
  }
  if (value.startsWith("case:")) {
    return { project: null, entities: [value] };
  }
  if (value.startsWith("entity:")) {
    return { project: null, entities: [value.slice(7)] };
  }
  return { project: null, entities: [] };
}

function scopeOrder(scope) {
  const order = ["owner", "system", "project", "case", "entity", "team", "role", "agent"];
  const kind = String(scope).split(":")[0];
  const index = order.indexOf(kind);
  return index === -1 ? order.length : index;
}

function clampLimit(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) {
    return DEFAULT_BLOCK_LIMIT;
  }
  if (number < 100) {
    return 100;
  }
  return Math.min(MAX_BLOCK_LIMIT, number);
}
