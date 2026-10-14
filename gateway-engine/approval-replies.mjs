import { randomInt } from "node:crypto";
import { foldDigits } from "../lib/text.mjs";

/**
 * Reading an owner's yes or no off a chat message.
 *
 * A message counts as a decision only when, once the short code is taken out,
 * nothing but a decision word is left. "بفرست" is an approval; "بفرست به
 * سارا" is a new request and must never approve anything. Which approval it
 * answers is decided by the caller (quote, then code, then a single pending
 * prompt) — this module never guesses.
 */

export const APPROVE_WORDS = ["بفرست", "ارسال کن", "تایید", "تأیید", "approve", "approved"];
export const DENY_WORDS = ["نه", "رد", "deny", "denied", "reject"];

// No 0/O, 1/I/L: the code is read off a phone screen and typed back.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_TOKEN = /^[a-hjkmnp-z2-9]{4}$/i;

export function newApprovalCode(existing = new Set()) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    let code = "";
    for (let index = 0; index < 4; index += 1) {
      code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    if (!existing.has(code)) {
      return code;
    }
  }
  throw new Error("Could not allocate a unique approval code");
}

function normalize(text) {
  return foldDigits(String(text ?? ""))
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[‌‍‎‏⁦-⁩]/g, " ")
    .replace(/[!.،,؛;:?؟«»"'()\[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const APPROVE = new Set(APPROVE_WORDS.map(normalize));
const DENY = new Set(DENY_WORDS.map(normalize));

/**
 * Parse a reply. Returns null when the message is not a decision at all.
 *   { decision: "approve" | "deny", code: "K7Q2" | null }
 */
export function parseDecision(text) {
  const raw = String(text ?? "").trim();
  if (!raw || raw.length > 60) {
    return null;
  }
  let body = raw;
  const slash = /^\/(approve|deny|تایید|رد)\b\s*(.*)$/i.exec(foldDigits(body));
  if (slash) {
    body = slash[1] + " " + slash[2];
  }
  let code = null;
  const kept = [];
  for (const token of normalize(body).split(" ")) {
    const bare = token.replace(/^#/, "");
    if (!code && CODE_TOKEN.test(bare) && !APPROVE.has(bare) && !DENY.has(bare)) {
      code = bare.toUpperCase();
      continue;
    }
    kept.push(token);
  }
  const rest = kept.join(" ").trim();
  if (APPROVE.has(rest)) {
    return { decision: "approve", code };
  }
  if (DENY.has(rest)) {
    return { decision: "deny", code };
  }
  return null;
}
