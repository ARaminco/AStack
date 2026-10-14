import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { redact } from "../redact.mjs";
import { chunkText, fingerprintOf, firstLine, sha, toPosix, walk } from "./util.mjs";

/**
 * Past agent sessions for this workspace only.
 *
 * - Claude Code: ~/.claude/projects/<slug of the project root>/*.jsonl
 * - Codex:       ~/.codex/sessions/**\/rollout-*.jsonl whose session_meta.cwd
 *                is one of the project roots
 *
 * Only human-readable turns are indexed: the user's own words and the
 * assistant's text replies. Tool calls, tool results, thinking blocks,
 * injected reminders and instruction files are left out. One document per
 * turn (a user message plus the assistant text that answered it).
 */
export const id = "sessions";
// Bump when parsing changes: every unit of this source is then re-read.
export const version = 2;

// Blocks injected by the harness rather than typed by the user.
const INJECTED = /<(system-reminder|browser_instruction|command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|environment_context|user_instructions|ide_selection|ide_opened_file|task-notification|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr|permissions instructions|INSTRUCTIONS)>[\s\S]*?<\/\1>/g;
const MAX_TURN_TEXT = 4800;

export function claudeSlug(path) {
  return String(path).replace(/[^a-zA-Z0-9]/g, "-");
}

export function cleanUserText(text) {
  let value = String(text ?? "").replace(INJECTED, " ").replace(/<\/?[a-z_-]+>/g, " ").trim();
  // Codex IDE wrappers ("# Context from my IDE setup:", "# Files mentioned by
  // the user:"): keep only the request, not the open tabs or file lists.
  const marker = "## My request for Codex:";
  const at = value.lastIndexOf(marker);
  if (at !== -1 && /^# /.test(value)) {
    value = value.slice(at + marker.length).trim();
  }
  if (!value) {
    return "";
  }
  // Instruction files pasted in by the runtime, not typed by the owner.
  if (/^(# AGENTS\.md instructions|# CLAUDE\.md|Caveat: The messages below)/.test(value)) {
    return "";
  }
  return value;
}

function sameRoot(a, b) {
  const norm = (value) => toPosix(resolve(String(value))).replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

export function units({ home, projectRoots, config = {} }) {
  const result = [];
  if (!home) {
    return result;
  }
  if (config.claude !== false) {
    const projects = join(home, ".claude", "projects");
    if (existsSync(projects)) {
      const names = readdirSync(projects);
      for (const root of projectRoots) {
        const wanted = claudeSlug(root).toLowerCase();
        const match = names.find((name) => name.toLowerCase() === wanted);
        if (!match) {
          continue;
        }
        const directory = join(projects, match);
        for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".jsonl")).sort()) {
          const path = join(directory, name);
          result.push({
            key: "claude/" + match + "/" + name,
            fingerprint: fingerprintOf(path),
            read: () => withHash(parseClaudeSession(readFileSync(path, "utf8"), { path }))
          });
        }
      }
    }
  }
  if (config.codex !== false) {
    const directory = join(home, ".codex", "sessions");
    for (const path of walk(directory, (name) => name.endsWith(".jsonl"))) {
      result.push({
        key: "codex/" + toPosix(relative(directory, path)),
        fingerprint: fingerprintOf(path),
        read: () => {
          const cwd = codexCwd(path);
          if (!cwd || !projectRoots.some((root) => sameRoot(root, cwd))) {
            return { hash: "other-project", docs: [] };
          }
          return withHash(parseCodexSession(readFileSync(path, "utf8"), { path }));
        }
      });
    }
  }
  return result;
}

function withHash(docs) {
  return { hash: sha(JSON.stringify(docs.map((doc) => [doc.id, doc.text.length]))), docs };
}

function codexCwd(path) {
  // session_meta is the first line; read just enough of the file to find it.
  let descriptor;
  try {
    descriptor = openSync(path, "r");
    const buffer = Buffer.alloc(256 * 1024);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, length).toString("utf8").split("\n")[0];
    const record = JSON.parse(line);
    return record?.payload?.cwd ?? null;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function textParts(content, types) {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter((part) => types.includes(part?.type) && typeof part.text === "string").map((part) => part.text);
}

function turnsToDocs(turns, { runtime, sessionId, title, path }) {
  const docs = [];
  const label = title || firstLine(turns[0]?.user ?? "", 80) || sessionId;
  turns.forEach((turn, index) => {
    const assistant = turn.assistant.join("\n\n");
    const body = ("Owner: " + turn.user + (assistant ? "\n\nAssistant: " + assistant : "")).slice(0, MAX_TURN_TEXT);
    const chunks = chunkText(redact(body));
    chunks.forEach((chunk, part) => {
      docs.push({
        id: "sessions:" + runtime + ":" + sessionId + ":" + (index + 1) + (chunks.length > 1 ? "." + (part + 1) : ""),
        kind: runtime,
        title: redact(label) + " · " + firstLine(redact(turn.user), 70),
        path: toPosix(path),
        date: turn.at ?? null,
        text: chunk,
        meta: { session: sessionId, runtime, turn: index + 1, group: runtime + ":" + sessionId + ":" + (index + 1), user: redact(turn.user).slice(0, 600) }
      });
    });
  });
  return docs;
}

/** Parse a Claude Code transcript into turn documents. */
export function parseClaudeSession(text, { path = "session.jsonl" } = {}) {
  let sessionId = basename(path).replace(/\.jsonl$/, "");
  let title = null;
  const turns = [];
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.sessionId) {
      sessionId = record.sessionId;
    }
    if (record.type === "ai-title" && record.aiTitle) {
      title = String(record.aiTitle);
      continue;
    }
    if (record.isSidechain || record.isMeta) {
      continue;
    }
    if (record.type === "user" && record.message?.role === "user") {
      const userText = textParts(record.message.content, ["text"]).map(cleanUserText).filter(Boolean).join("\n").trim();
      if (!userText) {
        continue;
      }
      current = { user: userText, assistant: [], at: record.timestamp ?? null };
      turns.push(current);
      continue;
    }
    if (record.type === "assistant" && current) {
      const reply = textParts(record.message?.content, ["text"]).join("\n").trim();
      if (reply) {
        current.assistant.push(reply);
      }
    }
  }
  return turnsToDocs(turns, { runtime: "claude", sessionId, title, path });
}

/** Parse a Codex rollout file into turn documents. */
export function parseCodexSession(text, { path = "rollout.jsonl" } = {}) {
  let sessionId = basename(path).replace(/\.jsonl$/, "");
  const turns = [];
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record.payload ?? {};
    if (record.type === "session_meta") {
      sessionId = payload.id ?? payload.session_id ?? sessionId;
      continue;
    }
    if (record.type !== "response_item" || payload.type !== "message") {
      continue;
    }
    if (payload.role === "user") {
      const userText = textParts(payload.content, ["input_text"]).map(cleanUserText).filter(Boolean).join("\n").trim();
      if (!userText) {
        continue;
      }
      current = { user: userText, assistant: [], at: record.timestamp ?? null };
      turns.push(current);
    } else if (payload.role === "assistant" && current) {
      const reply = textParts(payload.content, ["output_text"]).join("\n").trim();
      if (reply) {
        current.assistant.push(reply);
      }
    }
  }
  return turnsToDocs(turns, { runtime: "codex", sessionId, title: null, path });
}
