/**
 * Shared secret shapes.
 *
 * One list of credential patterns used by the search index
 * (search-engine/redact.mjs) and by everything AStack 3.0 writes to disk or
 * sends to a chat (runner prompts and outputs, gateway messages): provider key
 * prefixes, private key blocks, credentials inside URLs, bearer headers,
 * Persian and short credential keywords, payment card numbers and IBANs.
 *
 * `lib/text.mjs` `redactSecrets` keeps its own, older behaviour unchanged; the
 * strict variant there (`redactSecretsStrict`) layers these shapes on top.
 */

const DIGIT = "[0-9۰-۹٠-٩]";

// Provider keys with a recognisable prefix, key blocks, URL credentials and
// authorization headers. Precise: they almost never hit ordinary prose.
export const PROVIDER_TOKEN_SHAPES = [
  [/\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, "[redacted-key]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, "[redacted-key]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[redacted-key]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-key]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[redacted-key]"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "[redacted-key]"],
  // Telegram bot tokens: <bot id>:<35 characters>.
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, "[redacted-key]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted-private-key]"],
  // Credentials inside URLs: scheme://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, "$1[redacted]@"],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 [redacted]"]
];

// Heuristic shapes: long opaque strings that look like keys. They can hit
// ordinary identifiers, so callers choose whether to apply them.
export const OPAQUE_TOKEN_SHAPE = [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{32,}\b/g, "[redacted-token]"];
export const HEX_TOKEN_SHAPE = [/\b[a-f0-9]{40,}\b/g, "[redacted-hex]"];

// Persian credential words. The value is redacted after a ":" / "=" or when
// it carries a digit or a Latin letter, so «رمز عبور را فراموش کردم» stays.
const PERSIAN_KEYWORDS = "(رمز(?:[\\s\u200c]*(?:عبور|ورود|دوم|یکبار[\\s\u200c]*مصرف))?|پسورد|گذرواژه|کلمه[\\s\u200c]*(?:ی[\\s\u200c]*)?عبور|کد[\\s\u200c]*(?:تایید|تأیید|ورود|امنیتی|یکبار[\\s\u200c]*مصرف)|توکن)";
const PERSIAN_ASSIGNED = new RegExp(PERSIAN_KEYWORDS + "(\\s*[:=：]\\s*)([^\\s\"',;،؛]{2,})", "g");
const PERSIAN_INLINE = new RegExp(PERSIAN_KEYWORDS + "((?:\\s|\u200c)*(?:من|شما|اکانت|حساب)?(?:\\s|\u200c)*(?:است|هست|اینه|:)?(?:\\s|\u200c)*)((?=[^\\s\"',;،؛]*[0-9A-Za-z۰-۹٠-٩])[^\\s\"',;،؛]{3,})", "g");

// Short English credential words: only with an explicit assignment, so
// "pin the version" or "pass the test" is never touched.
const SHORT_ASSIGNED = /\b(pass(?:word|wd|code|phrase)?|pwd|pin(?:code)?|otp|2fa|mfa|cvv2?|cvc|security[_ -]?code|verification[_ -]?code)(\s*["']?\s*[:=]\s*["']?)([^\s"',;]{3,})/gi;

// 13 to 19 digit card numbers in 4-digit groups, and any run of 16 or more
// digits (card, account, Sheba numbers written without spaces).
const CARD_GROUPED = new RegExp("(?<!" + DIGIT + ")" + DIGIT + "{4}(?:[ -]" + DIGIT + "{4}){2}[ -]" + DIGIT + "{1,7}(?!" + DIGIT + ")", "g");
const LONG_NUMBER = new RegExp("(?<!" + DIGIT + ")" + DIGIT + "{16,}(?!" + DIGIT + ")", "g");
// IBAN: country code, check digits, then 11-30 alphanumerics, with or without
// 4-character groups. At least 8 digits after the prefix, so an upper-case
// sentence never matches.
const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g;

function countDigits(value) {
  return (String(value).match(new RegExp(DIGIT, "g")) ?? []).length;
}

/**
 * Persian and short credential keywords, card numbers and IBANs.
 */
export function redactCredentialWords(text) {
  return String(text ?? "")
    .replace(PERSIAN_ASSIGNED, "$1$2[redacted]")
    .replace(PERSIAN_INLINE, "$1$2[redacted]")
    .replace(SHORT_ASSIGNED, "$1$2[redacted]")
    .replace(IBAN, (match) => (countDigits(match.slice(4)) >= 8 ? "[redacted-iban]" : match))
    .replace(CARD_GROUPED, (match) => (countDigits(match) >= 13 ? "[redacted-card]" : match))
    .replace(LONG_NUMBER, "[redacted-number]");
}

/**
 * Provider token shapes, plus the opaque-string heuristics when asked for.
 */
export function redactTokenShapes(text, { opaque = true, hex = true } = {}) {
  let value = String(text ?? "");
  const shapes = [...PROVIDER_TOKEN_SHAPES, ...(opaque ? [OPAQUE_TOKEN_SHAPE] : []), ...(hex ? [HEX_TOKEN_SHAPE] : [])];
  for (const [pattern, replacement] of shapes) {
    value = value.replace(pattern, replacement);
  }
  return value;
}
