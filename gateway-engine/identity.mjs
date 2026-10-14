import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * WhatsApp identity helpers.
 *
 * One person can appear as a phone JID (`15551234567@s.whatsapp.net`), a
 * device-qualified JID (`15551234567:12@s.whatsapp.net`), a bare number with
 * or without `+`, or an opaque LID (`987654321@lid`) that hides the number.
 * Allowlists are written by people, in whatever form they had at hand, so every
 * comparison goes through the same normalisation and, when the linked-device
 * bridge has learnt the mapping, through LID <-> phone aliases.
 *
 * The alias walk is ported from Hermes Agent (MIT, NousResearch/hermes-agent:
 * scripts/whatsapp-bridge/allowlist.js and gateway/whatsapp_identity.py).
 */

const SAFE_IDENTIFIER = /^[A-Za-z0-9.+-]+$/;

/**
 * Strip JID, device and plus syntax down to the bare identifier.
 *   "6012:47@s.whatsapp.net" -> "6012", "6012@lid" -> "6012", "+6012" -> "6012"
 * Group JIDs keep their domain: a group is never the same thing as a person.
 */
export function normalizeWhatsAppId(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }
  if (raw.toLowerCase().endsWith("@g.us")) {
    return raw.toLowerCase();
  }
  const user = raw.replace(/^\+/, "").split("@")[0].split(":")[0];
  // A phone number typed with spaces, dashes or brackets is still a number.
  if (/^[\d\s().-]+$/.test(user)) {
    return user.replace(/\D/g, "");
  }
  return user.toLowerCase();
}

export function isGroupId(value) {
  return String(value ?? "").toLowerCase().endsWith("@g.us");
}

/**
 * Every identifier reachable from `identifier` through the bridge's
 * `lid-mapping-<id>.json` / `lid-mapping-<id>_reverse.json` files. Always
 * contains the normalised input itself.
 */
export function expandWhatsAppAliases(identifier, mappingDirectory = null) {
  const normalized = normalizeWhatsAppId(identifier);
  if (!normalized) {
    return new Set();
  }
  const resolved = new Set();
  const queue = [normalized];
  while (queue.length) {
    const current = queue.shift();
    // The identifier becomes part of a file name: refuse anything that could
    // walk out of the mapping directory.
    if (!current || resolved.has(current) || (!SAFE_IDENTIFIER.test(current) && !isGroupId(current))) {
      continue;
    }
    resolved.add(current);
    if (!mappingDirectory || isGroupId(current)) {
      continue;
    }
    for (const suffix of ["", "_reverse"]) {
      const path = join(mappingDirectory, "lid-mapping-" + current + suffix + ".json");
      if (!existsSync(path)) {
        continue;
      }
      try {
        const mapped = normalizeWhatsAppId(JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")));
        if (mapped && !resolved.has(mapped)) {
          queue.push(mapped);
        }
      } catch {
        continue;
      }
    }
  }
  return resolved;
}

/**
 * True when any alias of any of the candidate identifiers is on the list.
 * An empty list allows nobody: an open bot has to be configured on purpose,
 * and AStack does not offer that switch at all.
 */
export function matchesAllowlist(candidates, allowlist, mappingDirectory = null) {
  const allowed = new Set([...(allowlist ?? [])].map(normalizeWhatsAppId).filter(Boolean));
  if (!allowed.size) {
    return null;
  }
  for (const candidate of candidates ?? []) {
    for (const alias of expandWhatsAppAliases(candidate, mappingDirectory)) {
      if (allowed.has(alias)) {
        return alias;
      }
    }
  }
  return null;
}
