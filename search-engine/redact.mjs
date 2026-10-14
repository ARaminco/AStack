/**
 * Nothing secret enters the search index.
 *
 * Files whose names look like they hold credentials are never read (the same
 * rule interop-engine/memory-sources.mjs applies to legacy memory), and every
 * piece of text passes through assignment redaction, the JWT shape and a set
 * of well-known provider token shapes before it is stored.
 *
 * Why not lib/text.mjs redactSecrets directly: it also fires on prose
 * ("Token Budgets" becomes "Token [redacted]"), which would cripple search
 * over documentation. Search keeps its keyword list and JWT shape but needs
 * an assignment (":" or "=") before it redacts a value.
 */

// Mirrors SECRET_NAME in interop-engine/memory-sources.mjs, plus key material.
export const SECRET_FILE = /(credential|secret|password|passwd|token|api[-_]?key|\.env(\.|$)|\.pem$|\.key$|\.p12$|\.pfx$|id_rsa|id_ed25519)/i;

const ASSIGNMENT = /\b(authorization|api[_-]?key|access[_-]?key|token|secret|client[_-]?secret|password|passwd|pwd|cookie)(\s*["']?\s*[:=]\s*["']?)([^\s"',;]{4,})/gi;
const JWT = /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

const TOKEN_SHAPES = [
  // Provider keys with a recognisable prefix.
  [/\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, "[redacted-key]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, "[redacted-key]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[redacted-key]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-key]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[redacted-key]"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "[redacted-key]"],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, "[redacted-key]"],
  // Private key blocks.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted-private-key]"],
  // Credentials inside URLs: scheme://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, "$1[redacted]@"],
  // Bearer / Basic headers.
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 [redacted]"],
  // Long opaque strings (mixed digits, lower and upper case) that look like keys.
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{32,}\b/g, "[redacted-token]"],
  [/\b[a-f0-9]{40,}\b/g, "[redacted-hex]"]
];

export function isSecretFile(name) {
  return SECRET_FILE.test(String(name ?? "").split(/[\\/]/).pop());
}

export function redact(text) {
  let value = String(text ?? "").replace(ASSIGNMENT, "$1$2[redacted]").replace(JWT, "[redacted-jwt]");
  for (const [pattern, replacement] of TOKEN_SHAPES) {
    value = value.replace(pattern, replacement);
  }
  return value;
}
