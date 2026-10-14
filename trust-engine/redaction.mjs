/**
 * Exfiltration guard.
 *
 * Every value the secret broker resolves *in this process* is remembered here,
 * in process memory only, for the life of the process. Callers that opt in
 * pass their output through `redactResolvedSecrets` before it is written, so a
 * resolved secret that leaks into that output is replaced by its reference.
 *
 * What it covers (the callers, as of 3.0): audit records (trust-engine/
 * audit.mjs), runner run records, prompts and transcripts (runner-engine),
 * gateway messages (gateway-engine sendNow), sandbox output, board hand-offs
 * and A2A responses. Anything else — console logs, ad hoc files, other
 * engines — is NOT scrubbed unless it calls this module itself.
 *
 * Limits, stated plainly:
 * - Only values resolved through `runtime.secrets` in the same process are
 *   known. A value a child process (Claude Code, Codex, a script) reads on its
 *   own, or one resolved by another AStack process, is never registered here.
 * - Values shorter than 6 characters are not tracked (they would scrub
 *   ordinary words and numbers).
 * - Only the plain, base64, base64url, URL-encoded and JSON-escaped forms are
 *   matched; any other transformation of a secret passes through.
 * It is a last line of defence, not a substitute for never printing secrets.
 * The pattern redactors (`redactSecrets` / `redactSecretsStrict` in
 * lib/text.mjs) catch secrets by shape, independently of this registry.
 *
 * The registry never persists and never exposes the values it holds.
 */

// Shorter values would scrub ordinary words and numbers from every log line.
const MIN_LENGTH = 6;
const resolved = new Map();

function variants(value) {
  const forms = new Set([value]);
  try {
    forms.add(Buffer.from(value, "utf8").toString("base64"));
    forms.add(Buffer.from(value, "utf8").toString("base64url"));
    forms.add(encodeURIComponent(value));
    forms.add(JSON.stringify(value).slice(1, -1));
  } catch {
    // A value that cannot be encoded is still redacted in its plain form.
  }
  return [...forms].filter((form) => form.length >= MIN_LENGTH);
}

/**
 * Remember a resolved value so later output can be scrubbed of it. Values that
 * are too short to redact without destroying ordinary text are ignored.
 */
export function rememberResolvedSecret(value, label = "credential") {
  const text = String(value ?? "");
  if (text.length < MIN_LENGTH) {
    return false;
  }
  resolved.set(text, String(label));
  return true;
}

export function forgetResolvedSecret(value) {
  return resolved.delete(String(value ?? ""));
}

export function resolvedSecretCount() {
  return resolved.size;
}

/**
 * Replace every resolved secret (plain, base64, URL-encoded, JSON-escaped) in a
 * string with `[redacted:<reference>]`. Extra values can be passed for a value
 * that was never resolved through the broker.
 */
export function redactResolvedSecrets(text, extraValues = []) {
  if (text === null || text === undefined) {
    return text;
  }
  let output = String(text);
  const entries = [...resolved.entries(), ...extraValues.filter(Boolean).map((value) => [String(value), "credential"])];
  // Longest first, so a value that contains another is replaced whole.
  entries.sort((a, b) => b[0].length - a[0].length);
  for (const [value, label] of entries) {
    for (const form of variants(value)) {
      if (output.includes(form)) {
        output = output.split(form).join("[redacted:" + label + "]");
      }
    }
  }
  return output;
}

/**
 * The same guard for structured data: every string inside an object or array
 * is scrubbed. Returns a new value; the input is not modified.
 */
export function redactResolvedDeep(value, extraValues = []) {
  if (typeof value === "string") {
    return redactResolvedSecrets(value, extraValues);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactResolvedDeep(entry, extraValues));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactResolvedDeep(entry, extraValues)]));
  }
  return value;
}
