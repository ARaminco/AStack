import { foldDigits, redactSecrets } from "../lib/text.mjs";

/**
 * Chat formatting for the owner's phone.
 *
 * Messages are short, plain and one item per line. Tables never survive the
 * trip (WhatsApp and Telegram render them as noise), digits are Latin so
 * numbers read the same in every script, and bidi control characters are
 * stripped: an isolate (U+2066..U+2069) inside a WhatsApp message shows up
 * as a box on some phones and breaks copy and paste of numbers.
 */

// U+2066..U+2069 are the isolates; U+202A..U+202E are embeddings and
// overrides, which can visually reorder a number. ZWNJ (U+200C) is kept: it is
// part of correct Persian spelling.
const BIDI_CONTROLS = /[⁦-⁩‪-‮]/g;

export function stripBidiControls(text) {
  return String(text ?? "").replace(BIDI_CONTROLS, "");
}

export function hasBidiControls(text) {
  return /[⁦-⁩‪-‮]/.test(String(text ?? ""));
}

/**
 * Turn a Markdown table into labelled lines and drop separator rows, so a
 * report written for a terminal still reads on a phone.
 */
export function flattenTables(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const out = [];
  let header = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(trimmed)) {
      continue;
    }
    if (trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 1) {
      const cells = trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
      if (!header) {
        header = cells;
        continue;
      }
      const parts = cells.map((cell, index) => (header[index] ? header[index] + ": " + cell : cell)).filter((part) => part.trim());
      out.push("- " + parts.join(" | "));
      continue;
    }
    header = null;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Everything that leaves through a channel passes through here.
 */
export function formatForChat(text, { maxLineLength = 400 } = {}) {
  let value = stripBidiControls(redactSecrets(foldDigits(String(text ?? ""))));
  value = flattenTables(value);
  value = value
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .map((line) => (line.length > maxLineLength ? line.slice(0, maxLineLength - 1) + "…" : line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return value;
}

/**
 * Split long output into messages that fit the channel, on line boundaries
 * first and word boundaries second. Each part after the first is labelled so
 * the owner can tell the pieces belong together; the label keeps the number in
 * the middle of the line.
 */
export function splitMessage(text, { maxChars = 1500, label = (index, total) => "بخش " + index + " از " + total } = {}) {
  const value = String(text ?? "");
  if (value.length <= maxChars) {
    return value ? [value] : [];
  }
  const budget = Math.max(50, maxChars - 24);
  const parts = [];
  let current = "";
  const push = () => {
    if (current.trim()) {
      parts.push(current.trim());
    }
    current = "";
  };
  for (const line of value.split("\n")) {
    if (line.length > budget) {
      push();
      let rest = line;
      while (rest.length > budget) {
        let cut = rest.lastIndexOf(" ", budget);
        if (cut < budget / 2) {
          cut = budget;
        }
        parts.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      current = rest;
      continue;
    }
    if ((current ? current.length + 1 : 0) + line.length > budget) {
      push();
    }
    current = current ? current + "\n" + line : line;
  }
  push();
  if (parts.length <= 1) {
    return parts;
  }
  return parts.map((part, index) => label(index + 1, parts.length) + "\n" + part);
}

/**
 * Mask an identifier for display: enough to recognise it, not enough to dial.
 */
export function maskId(value) {
  const raw = String(value ?? "");
  const [user, domain] = raw.split("@");
  const tail = user.replace(/\D/g, "").slice(-4) || user.slice(-4);
  return "…" + tail + (domain ? "@" + domain : "");
}
