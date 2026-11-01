// Owner order (2026-11-01): no commit or pull request ever names Claude or
// another AI. Commits are made as the owner's own git identity; AI co-author
// trailers, "Generated with" footers and AI author identities are removed or
// refused everywhere AStack touches git.

/** A trailer or footer line that credits an AI tool. */
const AI_LINE = [
  /^\s*co-authored-by:.*\b(claude|anthropic|codex|openai|chatgpt|copilot|gemini|cursor(?:agent)?)\b/i,
  /^\s*co-authored-by:.*@(anthropic\.com|openai\.com)\s*>?\s*$/i,
  /^\s*(🤖\s*)?generated (with|by) \[?(claude|codex|chatgpt|copilot)/i,
  /^\s*(signed-off-by|assisted-by|helped-by):.*\b(claude|anthropic)\b/i
];

/** An author/committer identity that is an AI tool, not a person. */
const AI_IDENTITY = /\b(claude|anthropic)\b|noreply@anthropic\.com|@anthropic\.com/i;

export function isAiAttributionLine(line) {
  return AI_LINE.some((pattern) => pattern.test(String(line ?? "")));
}

export function hasAiAttribution(text) {
  return String(text ?? "").split(/\r?\n/).some(isAiAttributionLine);
}

/** Removes AI credit lines and the blank lines they leave at the end. */
export function stripAiAttribution(text) {
  const source = String(text ?? "");
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const kept = source.split(/\r?\n/).filter((line) => !isAiAttributionLine(line));
  while (kept.length && kept[kept.length - 1].trim() === "") {
    kept.pop();
  }
  return kept.join(eol) + (source.endsWith("\n") ? eol : "");
}

export function isAiIdentity(value) {
  return AI_IDENTITY.test(String(value ?? ""));
}

/**
 * Text of a shell command that would write AI credit into git history or a
 * pull request: an attribution line in a commit/PR/tag message, or an AI
 * author or committer identity. Returns a reason, or null.
 */
export function aiAttributionInCommand(command) {
  const text = String(command ?? "");
  const writesGit = /\bgit\b[^\n|;&]*\b(commit|tag|notes|merge|rebase|cherry-pick|am)\b|\bgh\s+(pr|release)\s+(create|edit)\b/i.test(text)
    || /\bgit\s+(-c\s+\S+\s+)*config\b[^\n|;&]*\buser\.(name|email)\b/i.test(text);
  if (!writesGit) {
    return null;
  }
  if (text.split(/\r?\n|\\n/).some(isAiAttributionLine) || /co-authored-by:[^\n"']*(claude|anthropic)/i.test(text) || /generated with \[?claude code/i.test(text)) {
    return "AI attribution in a commit or pull request message — commit as the owner, without naming Claude";
  }
  const identity = text.match(/--author[=\s]+("[^"]*"|'[^']*'|\S+)/i)?.[1]
    ?? text.match(/\buser\.(?:name|email)[=\s]+("[^"]*"|'[^']*'|\S+)/i)?.[1]
    ?? text.match(/\bGIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL)=("[^"]*"|'[^']*'|\S+)/)?.[1];
  if (identity && isAiIdentity(identity)) {
    return "AI author or committer identity — commits are made as the owner";
  }
  return null;
}

export const COMMIT_MSG_MARKER = "astack:no-ai-attribution";

/**
 * The commit-msg hook body: strips AI credit lines from the message and
 * refuses a commit whose author or committer is an AI identity. Works for
 * every tool that commits (Claude Code, Codex, IDEs) because git runs it.
 */
export function commitMsgHookBlock(nodeScript) {
  return [
    "# >>> " + COMMIT_MSG_MARKER + " (managed by AStack; owner order: no AI names in git)",
    "astack_msg=\"" + nodeScript.replace(/\\/g, "/") + "\"",
    "if [ -f \"$astack_msg\" ]; then node \"$astack_msg\" \"$1\" || exit 1; fi",
    "# <<< " + COMMIT_MSG_MARKER
  ].join("\n");
}

/** Inserts or refreshes the managed block in an existing hook, or makes a new one. */
export function plannedCommitMsgHook(current, nodeScript) {
  const block = commitMsgHookBlock(nodeScript);
  if (current === null || current === undefined || !current.trim()) {
    return "#!/bin/sh\n" + block + "\n";
  }
  const pattern = new RegExp("# >>> " + COMMIT_MSG_MARKER + "[\\s\\S]*?# <<< " + COMMIT_MSG_MARKER);
  if (pattern.test(current)) {
    return current.replace(pattern, block);
  }
  const lines = current.split("\n");
  const at = lines[0].startsWith("#!") ? 1 : 0;
  lines.splice(at, 0, block);
  return lines.join("\n");
}
