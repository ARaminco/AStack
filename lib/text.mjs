import { createHash } from "node:crypto";

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "have", "has", "was", "were", "are", "you", "your",
  "our", "not", "but", "all", "any", "can", "will", "should", "would", "please", "make", "need", "want", "using",
  "use", "used", "get", "got", "let", "its", "his", "her", "their", "them", "they", "who", "how", "why", "what",
  "when", "where", "which", "than", "then", "there", "here", "about", "also", "just", "one", "two", "new", "old",
  "را", "از", "با", "به", "که", "این", "آن", "برای", "های", "یک", "در", "تا", "هم", "بر", "می", "شود",
  "شده", "کرد", "کند", "کنیم", "باید", "است", "هست", "بود", "بودن", "شد", "ما", "شما", "من", "او", "ولی", "اما",
  "اگر", "چون", "یا", "و", "دو", "سه", "خود", "همه", "نیز", "روی", "توی", "درباره", "طور", "مورد", "بکن",
  "بکنه", "بشه", "میشه", "خیلی", "الان"
]);

const TRANSLITERATION = {
  "ا": "a", "آ": "a", "ب": "b", "پ": "p", "ت": "t", "ث": "s", "ج": "j", "چ": "ch",
  "ح": "h", "خ": "kh", "د": "d", "ذ": "z", "ر": "r", "ز": "z", "ژ": "zh", "س": "s", "ش": "sh", "ص": "s",
  "ض": "z", "ط": "t", "ظ": "z", "ع": "a", "غ": "gh", "ف": "f", "ق": "gh", "ک": "k", "گ": "g", "ل": "l",
  "م": "m", "ن": "n", "و": "v", "ه": "h", "ی": "y", "ئ": "y", "ؤ": "o"
};

const ZERO_WIDTH = /[​‌‍‎‏﻿]/g;
const HARAKAT = /[ً-ْٰ]/g;

export function foldDigits(text) {
  let value = String(text ?? "");
  for (let index = 0; index < 10; index += 1) {
    value = value.split(PERSIAN_DIGITS[index]).join(String(index)).split(ARABIC_DIGITS[index]).join(String(index));
  }
  return value;
}

export function normalizeText(text) {
  return foldDigits(text)
    .replace(/[يی]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/ة/g, "ه")
    .replace(/[أإآ]/g, "ا")
    .replace(ZERO_WIDTH, " ")
    .replace(HARAKAT, "")
    .toLowerCase();
}

export function tokenize(text, { keepStopwords = false, minLength = 2 } = {}) {
  const normalized = normalizeText(text);
  const raw = normalized.split(/[^0-9a-z؀-ۿ]+/).filter(Boolean);
  return raw.filter((token) => token.length >= minLength && (keepStopwords || !STOPWORDS.has(token)));
}

export function uniqueTokens(text, options = {}) {
  return [...new Set(tokenize(text, options))];
}

export function jaccard(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size && !b.size) {
    return 1;
  }
  let shared = 0;
  for (const item of a) {
    if (b.has(item)) {
      shared += 1;
    }
  }
  return shared / (a.size + b.size - shared);
}

export function estimateTokens(text) {
  const value = String(text ?? "");
  if (!value) {
    return 0;
  }
  let wide = 0;
  for (const char of value) {
    if (char.codePointAt(0) > 0x7f) {
      wide += 1;
    }
  }
  const ascii = value.length - wide;
  return Math.ceil(ascii / 4 + wide / 1.9);
}

export function transliterate(text) {
  let out = "";
  for (const char of normalizeText(text)) {
    out += TRANSLITERATION[char] ?? char;
  }
  return out;
}

export function slugify(text, { fallback = "item", maxLength = 48 } = {}) {
  const base = transliterate(text)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return base || fallback;
}

export function hashId(...parts) {
  return createHash("sha1").update(parts.map((part) => String(part)).join(" ")).digest("hex");
}

export function shortHash(...parts) {
  return hashId(...parts).slice(0, 12);
}

export function redactSecrets(text) {
  return String(text ?? "")
    .replace(/(authorization|api[_-]?key|token|secret|password|passwd|cookie|bearer)(["'\s:=]+)([^\s"',;]{4,})/gi, "$1$2[redacted]")
    .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted-jwt]");
}

const INJECTION_PATTERNS = [
  /ignore (all )?(previous|prior|above) instructions/i,
  /disregard (the )?(system|previous) (prompt|instructions)/i,
  /you are now (a|an|the)/i,
  /reveal (your )?(system prompt|instructions|credentials|password)/i,
  /send (the )?(password|credentials|token|cookie)/i,
  /دستورات قبلی را نادیده بگیر/,
  /رمز عبور را ارسال کن/
];

/**
 * External text (a web page, an inbound message, a scanned document) is data,
 * never instruction. Anything shaped like an attempt to command the system is
 * quarantined before it can reach memory, a skill or another agent.
 */
export function sanitizeExternalContent(text, { maxLength = 4000 } = {}) {
  const value = redactSecrets(String(text ?? "")).slice(0, maxLength);
  const flags = [];
  let cleaned = value;
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(cleaned)) {
      flags.push(String(pattern));
      cleaned = cleaned.replace(pattern, "[quarantined-instruction]");
    }
  }
  return { text: cleaned, injectionSuspected: flags.length > 0, flags };
}

export { STOPWORDS, INJECTION_PATTERNS };
