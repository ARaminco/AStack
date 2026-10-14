/**
 * Exfiltration guard.
 *
 * Every value the secret broker resolves is remembered here, in process memory
 * only, for the life of the process. Anything about to be written somewhere a
 * human or another agent can read — an audit record, a log line, a runner
 * transcript, a sandbox's output, an A2A response — passes through
 * `redactResolvedSecrets` first, so a secret that leaks into a tool's output is
 * replaced by its reference before it reaches disk or the network.
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
