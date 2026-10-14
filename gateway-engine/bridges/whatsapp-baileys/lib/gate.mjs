import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Pure safety logic of the linked-device bridge, kept free of Baileys so it is
 * unit tested in the AStack suite without installing anything.
 *
 * Ported from Hermes Agent (MIT, NousResearch/hermes-agent:
 * scripts/whatsapp-bridge/allowlist.js, outbound_ids.js and
 * owner_message_gate.js), adapted to AStack's stricter rules: only owners are
 * ever accepted, also inside an allowlisted group, and an empty allowlist
 * accepts nobody (there is no "*" switch).
 */

const SAFE_IDENTIFIER = /^[A-Za-z0-9.+-]+$/;

export function normalizeId(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }
  if (raw.toLowerCase().endsWith("@g.us")) {
    return raw.toLowerCase();
  }
  const user = raw.replace(/^\+/, "").split("@")[0].split(":")[0];
  if (/^[\d\s().-]+$/.test(user)) {
    return user.replace(/\D/g, "");
  }
  return user.toLowerCase();
}

export function parseList(value) {
  return new Set(String(value ?? "").split(",").map(normalizeId).filter(Boolean));
}

/**
 * Phone <-> LID aliases learnt by Baileys, read from the
 * `lid-mapping-<id>.json` and `lid-mapping-<id>_reverse.json` files it keeps in
 * the auth directory.
 */
export function expandAliases(identifier, authDirectory) {
  const start = normalizeId(identifier);
  const resolved = new Set();
  const queue = start ? [start] : [];
  while (queue.length) {
    const current = queue.shift();
    if (!current || resolved.has(current) || (!SAFE_IDENTIFIER.test(current) && !current.endsWith("@g.us"))) {
      continue;
    }
    resolved.add(current);
    if (!authDirectory || current.endsWith("@g.us")) {
      continue;
    }
    for (const suffix of ["", "_reverse"]) {
      const path = join(authDirectory, "lid-mapping-" + current + suffix + ".json");
      if (!existsSync(path)) {
        continue;
      }
      try {
        const mapped = normalizeId(JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")));
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

export function matchesAllowed(candidates, allowed, authDirectory) {
  if (!allowed || !allowed.size) {
    return false;
  }
  for (const candidate of candidates) {
    for (const alias of expandAliases(candidate, authDirectory)) {
      if (allowed.has(alias)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Bounded insertion-ordered set of ids this bridge sent, so an echo of our
 * own message is never read back as a command.
 */
export function createOutboundTracker(maxSize = 512) {
  const ids = new Set();
  return {
    remember(id) {
      if (!id) {
        return;
      }
      ids.add(id);
      while (ids.size > maxSize) {
        ids.delete(ids.values().next().value);
      }
    },
    has(id) {
      return Boolean(id) && ids.has(id);
    },
    size() {
      return ids.size;
    }
  };
}

/**
 * The bridge's intake decision for one upsert. Returns one of:
 *   drop_echo, drop_from_me, drop_status, drop_group, drop_stranger, accept
 * `fromMe` messages are never forwarded: the bridge is meant to run on its
 * own number, and what that number sends is the gateway's own output.
 */
export function classifyInbound({ fromMe, messageId, chatId, senderId, senderAltId = null, allowedUsers, allowedGroups, authDirectory = null, outbound = null }) {
  const chat = String(chatId ?? "");
  if (chat === "status@broadcast" || chat.endsWith("@broadcast") || chat.endsWith("@newsletter")) {
    return "drop_status";
  }
  if (fromMe) {
    return outbound?.has(messageId) ? "drop_echo" : "drop_from_me";
  }
  const sender = [senderId, senderAltId].filter(Boolean);
  if (chat.endsWith("@g.us")) {
    if (!allowedGroups?.has(normalizeId(chat))) {
      return "drop_group";
    }
    return matchesAllowed(sender, allowedUsers, authDirectory) ? "accept" : "drop_stranger";
  }
  return matchesAllowed([...sender, chat], allowedUsers, authDirectory) ? "accept" : "drop_stranger";
}

/**
 * Outbound gate: the bridge only ever writes to an owner or an allowlisted
 * group, whatever the caller asks for.
 */
export function allowedTarget(chatId, { allowedUsers, allowedGroups, authDirectory = null }) {
  const chat = String(chatId ?? "");
  if (chat.endsWith("@g.us")) {
    return Boolean(allowedGroups?.has(normalizeId(chat)));
  }
  return matchesAllowed([chat], allowedUsers, authDirectory);
}

/**
 * WhatsApp JID for an outbound target: a bare number becomes a phone JID,
 * a device-qualified JID loses its device part.
 */
export function toJid(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }
  if (raw.includes("@")) {
    const [user, domain] = raw.split("@");
    return user.split(":")[0] + "@" + domain;
  }
  const digits = raw.replace(/\D/g, "");
  return digits ? digits + "@s.whatsapp.net" : raw;
}

/**
 * Reconnect delays: exponential from `baseMs`, capped, reset after a good
 * connection.
 */
export function createBackoff({ baseMs = 1000, maxMs = 60000 } = {}) {
  let attempt = 0;
  return {
    next() {
      const delay = Math.min(maxMs, baseMs * 2 ** attempt);
      attempt += 1;
      return delay;
    },
    reset() {
      attempt = 0;
    }
  };
}
