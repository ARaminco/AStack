/**
 * Nothing secret enters the search index.
 *
 * Files whose names look like they hold credentials are never read (the same
 * rule interop-engine/memory-sources.mjs applies to legacy memory), and every
 * piece of text passes through assignment redaction, the JWT shape and a set
 * of well-known provider token shapes before it is stored.
 *
 * The token shapes, the Persian and short credential keywords (رمز، پسورد،
 * گذرواژه، کلمه عبور، کد تایید، کد ورود، توکن, pass, pwd, pin, otp, 2fa, cvv),
 * card numbers and IBANs live in lib/redact.mjs, shared with the runner and
 * the gateway.
 *
 * Why not lib/text.mjs redactSecrets directly: it also fires on prose
 * ("Token Budgets" becomes "Token [redacted]"), which would cripple search
 * over documentation. Search keeps its keyword list and JWT shape but needs
 * an assignment (":" or "=") before it redacts a value.
 */

import { redactCredentialWords, redactTokenShapes } from "../lib/redact.mjs";

// Mirrors SECRET_NAME in interop-engine/memory-sources.mjs, plus key material.
export const SECRET_FILE = /(credential|secret|password|passwd|token|api[-_]?key|\.env(\.|$)|\.pem$|\.key$|\.p12$|\.pfx$|id_rsa|id_ed25519)/i;

const ASSIGNMENT = /\b(authorization|api[_-]?key|access[_-]?key|token|secret|client[_-]?secret|password|passwd|pwd|cookie)(\s*["']?\s*[:=]\s*["']?)([^\s"',;]{4,})/gi;
const JWT = /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

export function isSecretFile(name) {
  return SECRET_FILE.test(String(name ?? "").split(/[\\/]/).pop());
}

export function redact(text) {
  const value = String(text ?? "").replace(ASSIGNMENT, "$1$2[redacted]").replace(JWT, "[redacted-jwt]");
  // Provider token shapes are shared with the runner and gateway
  // (lib/redact.mjs); Persian and short credential words, card numbers and
  // IBANs are redacted last.
  return redactCredentialWords(redactTokenShapes(value, { opaque: true, hex: true }));
}
