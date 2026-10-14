import { redactSecretsStrict } from "./text.mjs";

/**
 * One-line descriptions of Claude Code tool calls, shared by the console's
 * conversation view (tool chips) and the astack MCP permission tool (the
 * approval the owner decides). Everything is strict-redacted: tool inputs
 * routinely carry pasted credentials.
 */

const TARGET_KEYS = {
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"],
  NotebookRead: ["notebook_path"],
  Bash: ["command"],
  PowerShell: ["command"],
  BashOutput: ["bash_id"],
  KillShell: ["shell_id"],
  Grep: ["pattern", "path"],
  Glob: ["pattern", "path"],
  LS: ["path"],
  WebFetch: ["url"],
  WebSearch: ["query"],
  Task: ["description"],
  Agent: ["description"],
  Skill: ["skill", "command"],
  TodoWrite: [],
  ExitPlanMode: []
};

function clip(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/** `Bash` + `{ command: "git status" }` → `git status`. */
export function toolTarget(name, input = {}, max = 120) {
  const tool = String(name ?? "");
  const value = input && typeof input === "object" ? input : {};
  if (tool === "TodoWrite" && Array.isArray(value.todos)) {
    return value.todos.length + " items";
  }
  const keys = TARGET_KEYS[tool] ?? ["file_path", "path", "command", "url", "query", "pattern", "description", "name", "id"];
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null && value[key] !== "") {
      return redactSecretsStrict(clip(value[key], max));
    }
  }
  const first = Object.entries(value).find(([, entry]) => typeof entry === "string" && entry);
  return first ? redactSecretsStrict(clip(first[1], max)) : "";
}

/**
 * A bounded, redacted copy of a tool input for display and approval records:
 * long strings are clipped, nesting is capped, secrets are masked.
 */
export function toolInputPreview(input, { maxString = 800, depth = 0 } = {}) {
  if (input === null || input === undefined) {
    return null;
  }
  if (typeof input === "string") {
    const text = input.length > maxString ? input.slice(0, maxString) + "… (" + input.length + " chars)" : input;
    return redactSecretsStrict(text);
  }
  if (typeof input === "number" || typeof input === "boolean") {
    return input;
  }
  if (depth > 3) {
    return "…";
  }
  if (Array.isArray(input)) {
    const list = input.slice(0, 20).map((entry) => toolInputPreview(entry, { maxString: Math.min(maxString, 300), depth: depth + 1 }));
    return input.length > 20 ? [...list, "… " + (input.length - 20) + " more"] : list;
  }
  if (typeof input === "object") {
    const out = {};
    for (const [key, value] of Object.entries(input).slice(0, 30)) {
      out[key] = /secret|password|passwd|token|cookie|credential|api[_-]?key|authorization/i.test(key) && typeof value === "string" ? "[redacted]" : toolInputPreview(value, { maxString, depth: depth + 1 });
    }
    return out;
  }
  return String(input);
}

/** Tools that only read: shown low risk on a permission card. */
export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "LS", "NotebookRead", "WebSearch", "TodoWrite", "BashOutput"];
