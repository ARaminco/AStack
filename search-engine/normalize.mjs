import { STOPWORDS } from "../lib/text.mjs";

/**
 * Search normalization for Persian, Arabic and English text.
 *
 * The same function runs at index time and at query time, so every spelling
 * variant a Persian writer produces lands on one form:
 *
 * - Arabic Yeh/Alef Maksura (ي ى) → Persian Yeh (ی), Arabic Kaf (ك) → Keheh (ک)
 * - Teh Marbuta and Heh with Yeh (ة ۀ) → Heh (ه), hamza-carrying Alef forms → ا, ؤ → و
 * - Persian (۰-۹) and Arabic-Indic (٠-٩) digits → ASCII digits
 * - ZWNJ, ZWJ and bidi marks → word break; Tatweel and harakat removed
 * - Arabic presentation forms folded by NFKC, Latin lower-cased
 *
 * ZWNJ deserves care: «میخواهم» is written with ZWNJ, with a space, or
 * joined. The ZWNJ becomes a word break (so «پروندهها» matches «پرونده»),
 * and `zwnjAliases` adds the joined spelling as an extra indexed term so a
 * query typed without the ZWNJ still finds it.
 */

const PERSIAN_DIGITS = "\u06f0\u06f1\u06f2\u06f3\u06f4\u06f5\u06f6\u06f7\u06f8\u06f9";
const ARABIC_DIGITS = "\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669";
const JOINERS = /[\u200b\u200c\u200d\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff\u00ad]/g;
const HARAKAT = /[\u064b-\u065f\u0670\u06d6-\u06ed]/g;
const TATWEEL = /\u0640/g;
// Letters and digits only: Arabic-script punctuation (، ؛ ؟ ٪ ٫ ۔) breaks words.
const WORD = /[0-9a-z\u00df-\u024f\u0620-\u064a\u066e-\u06d3\u06d5\u06ee\u06ef\u06fa-\u06fc\u06ff\u0750-\u077f\u08a0-\u08ff]+/g;

export function foldCharacters(text) {
  let value = String(text ?? "").normalize("NFKC");
  value = value.replace(/[\u06f0-\u06f9]/g, (digit) => String(PERSIAN_DIGITS.indexOf(digit)));
  value = value.replace(/[\u0660-\u0669]/g, (digit) => String(ARABIC_DIGITS.indexOf(digit)));
  return value
    .replace(/[\u064a\u0649\u06cc\u0626]/g, "\u06cc")
    .replace(/\u0643/g, "\u06a9")
    .replace(/[\u0629\u06c0\u06c1]/g, "\u0647")
    .replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627")
    .replace(/\u0624/g, "\u0648")
    .replace(HARAKAT, "")
    .replace(TATWEEL, "")
    .toLowerCase();
}

/** Normalized text with ZWNJ and friends turned into word breaks. */
export function normalizeForSearch(text) {
  return foldCharacters(text).replace(JOINERS, " ");
}

/** Tokens as the index sees them. */
export function searchTokens(text, { keepStopwords = false, minLength = 1 } = {}) {
  const tokens = normalizeForSearch(text).match(WORD) ?? [];
  return tokens.filter((token) => token.length >= minLength && (keepStopwords || !STOPWORDS.has(token)));
}

/**
 * Joined spellings of ZWNJ-compound words: «میخواهم» → «میخواهم». Indexed in
 * a side column so the joined form is searchable without changing the main
 * text.
 */
export function zwnjAliases(text) {
  const folded = foldCharacters(text);
  const aliases = new Set();
  for (const match of folded.matchAll(/[\u0600-\u06ff]+(?:[\u200c\u200d][\u0600-\u06ff]+)+/g)) {
    aliases.add(match[0].replace(/[\u200c\u200d]/g, ""));
  }
  return [...aliases].join(" ");
}

/** Text as stored in the full-text index (normalized body plus ZWNJ aliases). */
export function indexText(text) {
  const aliases = zwnjAliases(text);
  return normalizeForSearch(text) + (aliases ? " " + aliases : "");
}

/**
 * Query terms. Stopwords are dropped unless the query is nothing but
 * stopwords; duplicates are removed.
 */
export function queryTerms(text) {
  const all = searchTokens(text, { keepStopwords: true });
  const meaningful = all.filter((token) => !STOPWORDS.has(token));
  const chosen = meaningful.length ? meaningful : all;
  const aliases = searchTokens(zwnjAliases(text), { keepStopwords: true });
  return [...new Set([...chosen, ...aliases])];
}

/**
 * An FTS5 MATCH expression: terms OR-ed so partial matches still rank, with a
 * prefix match on longer terms to catch inflections («قرارداد» → «قراردادها»).
 */
export function ftsQuery(text) {
  const terms = queryTerms(text);
  if (!terms.length) {
    return null;
  }
  return terms.map((term) => '"' + term.replace(/"/g, "") + '"' + (term.length >= 3 ? "*" : "")).join(" OR ");
}
