#!/usr/bin/env node
/**
 * AStack WhatsApp linked-device bridge.
 *
 * A standalone process that holds one WhatsApp linked-device session through
 * Baileys and exposes a loopback-only HTTP API to the AStack gateway:
 *
 *   GET  /health                 state, instance id, queue length
 *   GET  /status                 health plus the pairing QR while pairing
 *   GET  /messages?wait=<s>      long poll: drain accepted inbound messages
 *   POST /send                   { chatId, text, replyTo? }
 *   POST /send-media             { chatId, filePath, caption?, fileName? } (file inside outbox/ or media/ only)
 *   POST /shutdown               graceful exit
 *
 * Every request must come to a loopback Host and carry the shared token in
 * `x-astack-bridge-token`. Only owners (and owners inside allowlisted groups)
 * are ever queued; strangers are counted and dropped without storing content.
 * The bridge writes only to owners and allowlisted groups.
 *
 * Installed on demand by `astack gateway whatsapp setup` into
 * `.astack/gateway/bridge/app/`; never part of the AStack core's dependencies.
 * Design and safety behaviour ported from Hermes Agent (MIT,
 * NousResearch/hermes-agent: scripts/whatsapp-bridge/).
 *
 * Usage: node bridge.mjs --dir <bridge dir> --port <port> [--pair-only] [--self-test]
 */
import { createServer } from "node:http";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { allowedTarget, classifyInbound, createBackoff, createOutboundTracker, parseList, sendablePath, toJid } from "./lib/gate.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const index = args.indexOf("--" + name);
  return index !== -1 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
};

const DIR = arg("dir", join(process.cwd(), "bridge-data"));
const PORT = Number(arg("port", "8790"));
const PAIR_ONLY = args.includes("--pair-only");
const SELF_TEST = args.includes("--self-test");
const AUTH_DIR = join(DIR, "auth");
const MEDIA_DIR = join(DIR, "media");
// The only folders /send-media reads from: the gateway stages outgoing files
// in outbox/, inbound voice notes land in media/.
const OUTBOX_DIR = join(DIR, "outbox");
const STATUS_PATH = join(DIR, "status.json");
const LOCK_PATH = join(DIR, "bridge.lock");
const TOKEN = process.env.ASTACK_BRIDGE_TOKEN ?? "";
const INSTANCE = process.env.ASTACK_BRIDGE_INSTANCE ?? randomBytes(8).toString("hex");
const ALLOWED_USERS = parseList(process.env.ASTACK_WA_ALLOWED_USERS);
const ALLOWED_GROUPS = parseList(process.env.ASTACK_WA_ALLOWED_GROUPS);
const MAX_QUEUE = 200;
const SEND_TIMEOUT_MS = 60000;

function log(line) {
  process.stdout.write(new Date().toISOString() + " " + line + "\n");
}

function mask(value) {
  const raw = String(value ?? "");
  const [user, domain] = raw.split("@");
  return "…" + (user.replace(/\D/g, "").slice(-4) || user.slice(-4)) + (domain ? "@" + domain : "");
}

if (SELF_TEST) {
  // Proves the installed dependencies resolve, without opening a socket.
  const baileys = await import("@whiskeysockets/baileys");
  const qr = await import("qrcode-terminal");
  const ok = typeof baileys.makeWASocket === "function" && typeof baileys.useMultiFileAuthState === "function" && Boolean(qr.default ?? qr);
  process.stdout.write(JSON.stringify({ ok, baileys: typeof baileys.makeWASocket }) + "\n");
  process.exit(ok ? 0 : 1);
}

if (!TOKEN && !PAIR_ONLY) {
  log("refusing to start: ASTACK_BRIDGE_TOKEN is not set");
  process.exit(2);
}

mkdirSync(AUTH_DIR, { recursive: true });
mkdirSync(MEDIA_DIR, { recursive: true });
mkdirSync(OUTBOX_DIR, { recursive: true });

function sendableFile(filePath) {
  return sendablePath(filePath, [OUTBOX_DIR, MEDIA_DIR]);
}

// --------------------------------------------------------------- one bridge
// Two sockets on the same credentials fight over the session and WhatsApp
// logs both out. The lock names its pid; a dead holder is taken over.
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = openSync(LOCK_PATH, "wx");
      writeSync(handle, String(process.pid));
      closeSync(handle);
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      const holder = Number(readFileSync(LOCK_PATH, "utf8").trim());
      if (holder && holder !== process.pid && alive(holder)) {
        return false;
      }
      rmSync(LOCK_PATH, { force: true });
    }
  }
  return false;
}

if (!acquireLock()) {
  log("another bridge already holds " + LOCK_PATH + "; exiting");
  process.exit(3);
}
const releaseLock = () => {
  try {
    if (readFileSync(LOCK_PATH, "utf8").trim() === String(process.pid)) {
      rmSync(LOCK_PATH, { force: true });
    }
  } catch {
    // already gone
  }
};
process.on("exit", releaseLock);

// ------------------------------------------------------------------- status
let state = "starting";
let currentQr = null;
let me = null;
const counters = { accepted: 0, ignored: 0, echoes: 0, sent: 0, refused: 0 };

function writeStatus() {
  const body = { state, qr: currentQr, me: me ? mask(me) : null, pid: process.pid, instance: INSTANCE, port: PORT, counters, updatedAt: new Date().toISOString() };
  const temporary = STATUS_PATH + "." + process.pid + ".tmp";
  writeFileSync(temporary, JSON.stringify(body, null, 2), "utf8");
  renameSync(temporary, STATUS_PATH);
}

// ---------------------------------------------------------------- whatsapp
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = await import("@whiskeysockets/baileys");
const qrcode = (await import("qrcode-terminal")).default;

const silentLogger = {
  level: "silent",
  child() {
    return silentLogger;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {}
};

const outbound = createOutboundTracker(512);
const inboundStore = new Map();
const queue = [];
const waiters = new Set();
const backoff = createBackoff({ baseMs: 1000, maxMs: 60000 });
let sock = null;
let stopping = false;
let sendChain = Promise.resolve();

function rememberInbound(msg) {
  inboundStore.set(msg.key.id, msg);
  while (inboundStore.size > 512) {
    inboundStore.delete(inboundStore.keys().next().value);
  }
}

function unwrap(content) {
  let current = content ?? {};
  for (let index = 0; index < 8; index += 1) {
    const next = current.ephemeralMessage?.message ?? current.viewOnceMessage?.message ?? current.viewOnceMessageV2?.message ?? current.documentWithCaptionMessage?.message;
    if (!next) {
      break;
    }
    current = next;
  }
  return current;
}

async function resolveVersion() {
  try {
    const result = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("version fetch timed out")), 15000))
    ]);
    return result?.version ?? null;
  } catch {
    return null;
  }
}

function enqueue(event) {
  queue.push(event);
  while (queue.length > MAX_QUEUE) {
    queue.shift();
  }
  for (const wake of waiters) {
    wake();
  }
}

async function handleUpsert({ messages, type }) {
  if (type !== "notify" && type !== "append") {
    return;
  }
  for (const msg of messages ?? []) {
    if (!msg?.message || !msg.key?.remoteJid) {
      continue;
    }
    const chatId = msg.key.remoteJid;
    const senderId = msg.key.participant || chatId;
    const senderAltId = msg.key.participantAlt || msg.key.remoteJidAlt || null;
    const decision = classifyInbound({
      fromMe: Boolean(msg.key.fromMe),
      messageId: msg.key.id,
      chatId,
      senderId,
      senderAltId,
      allowedUsers: ALLOWED_USERS,
      allowedGroups: ALLOWED_GROUPS,
      authDirectory: AUTH_DIR,
      outbound
    });
    if (decision === "drop_echo") {
      counters.echoes += 1;
      continue;
    }
    if (decision !== "accept") {
      counters.ignored += 1;
      if (decision === "drop_stranger" || decision === "drop_group") {
        log("ignored " + decision + " chat=" + mask(chatId) + " sender=" + mask(senderId));
      }
      continue;
    }
    const content = unwrap(msg.message);
    const context = Object.values(content).find((value) => value && typeof value === "object" && value.contextInfo)?.contextInfo ?? {};
    let text = content.conversation ?? content.extendedTextMessage?.text ?? content.imageMessage?.caption ?? content.videoMessage?.caption ?? content.documentMessage?.caption ?? "";
    let voice = null;
    let unsupported = null;
    if (content.audioMessage) {
      try {
        const buffer = await downloadMediaMessage(msg, "buffer", {}, { logger: silentLogger, reuploadRequest: sock.updateMediaMessage });
        const path = join(MEDIA_DIR, String(msg.key.id).replace(/[^A-Za-z0-9_-]/g, "") + ".ogg");
        writeFileSync(path, buffer);
        voice = { path, mime: content.audioMessage.mimetype ?? "audio/ogg" };
      } catch (error) {
        unsupported = "voice-download-failed";
        log("voice download failed: " + error.message);
      }
    } else if (!text) {
      unsupported = Object.keys(content)[0] ?? "unknown";
    }
    rememberInbound(msg);
    counters.accepted += 1;
    enqueue({
      id: msg.key.id,
      chatId,
      senderId,
      senderAltId,
      isGroup: chatId.endsWith("@g.us"),
      text,
      quotedId: context.stanzaId ?? null,
      // WhatsApp marks forwarded messages; they never count as a decision.
      forwarded: Boolean(context.isForwarded || Number(context.forwardingScore ?? 0) > 0),
      timestamp: Number(msg.messageTimestamp?.low ?? msg.messageTimestamp ?? Math.floor(Date.now() / 1000)),
      voice,
      unsupported
    });
  }
}

async function startSocket() {
  const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const version = await resolveVersion();
  sock = makeWASocket({
    ...(version ? { version } : {}),
    auth,
    logger: silentLogger,
    printQRInTerminal: false,
    browser: ["AStack", "Chrome", "120.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    // Baileys 7 needs a getMessage for retry handshakes; a placeholder is enough.
    getMessage: async () => ({ conversation: "" })
  });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      state = "qr";
      currentQr = qr;
      writeStatus();
      if (PAIR_ONLY || process.stdout.isTTY) {
        process.stdout.write("\nScan this QR with WhatsApp > Linked devices on the BOT phone (not your personal account):\n\n");
        qrcode.generate(qr, { small: true }, (code) => process.stdout.write(code + "\n"));
      }
    }
    if (connection === "open") {
      state = "connected";
      currentQr = null;
      me = sock.user?.id ?? null;
      backoff.reset();
      writeStatus();
      log("connected as " + mask(me));
      if (PAIR_ONLY) {
        log("pairing complete; credentials saved");
        setTimeout(() => process.exit(0), 2000);
      }
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        state = "logged-out";
        writeStatus();
        log("logged out by WhatsApp; delete the auth directory and pair again");
        process.exit(1);
      }
      state = "reconnecting";
      writeStatus();
      if (!stopping) {
        const delay = code === 515 ? 1000 : backoff.next();
        log("connection closed (" + code + "); reconnecting in " + Math.round(delay / 1000) + "s");
        setTimeout(() => startSocket().catch((error) => log("reconnect failed: " + error.message)), delay);
      }
    }
  });
  sock.ev.on("messages.upsert", (event) => {
    handleUpsert(event).catch((error) => log("upsert failed: " + error.message));
  });
}

// One socket must never see overlapping sends: racing sendMessage calls can
// misroute in the protocol layer.
function enqueueSend(task) {
  const run = sendChain.then(task, task);
  sendChain = run.catch(() => {});
  return run;
}

function sendWithTimeout(jid, payload, options = {}) {
  return enqueueSend(() => {
    let timer;
    return Promise.race([
      sock.sendMessage(jid, payload, options),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("send timed out")), SEND_TIMEOUT_MS);
      })
    ]).finally(() => clearTimeout(timer));
  });
}

// --------------------------------------------------------------------- http
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

function tokenMatches(value) {
  const a = Buffer.from(String(value ?? ""));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("payload too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    request.on("error", reject);
  });
}

function health() {
  return { ok: true, state, instance: INSTANCE, pid: process.pid, queue: queue.length, me: me ? mask(me) : null, counters };
}

const server = createServer(async (request, response) => {
  const send = (status, body) => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
  };
  const host = String(request.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOOPBACK.has(host)) {
    send(400, { error: "loopback hosts only" });
    return;
  }
  if (!tokenMatches(request.headers["x-astack-bridge-token"])) {
    send(401, { error: "bad token" });
    return;
  }
  const url = new URL(request.url, "http://127.0.0.1");
  try {
    if (request.method === "GET" && url.pathname === "/health") {
      send(200, health());
      return;
    }
    if (request.method === "GET" && url.pathname === "/status") {
      send(200, { ...health(), qr: currentQr });
      return;
    }
    if (request.method === "GET" && url.pathname === "/messages") {
      const wait = Math.max(0, Math.min(25, Number(url.searchParams.get("wait") ?? 0)));
      if (!queue.length && wait) {
        await new Promise((resolve) => {
          const done = () => {
            waiters.delete(done);
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(done, wait * 1000);
          waiters.add(done);
          request.on("close", done);
        });
      }
      send(200, { messages: queue.splice(0, queue.length) });
      return;
    }
    if (request.method === "POST" && (url.pathname === "/send" || url.pathname === "/send-media")) {
      if (!sock || state !== "connected") {
        send(503, { error: "not connected" });
        return;
      }
      const body = await readBody(request);
      const jid = toJid(body.chatId);
      if (!allowedTarget(jid, { allowedUsers: ALLOWED_USERS, allowedGroups: ALLOWED_GROUPS, authDirectory: AUTH_DIR })) {
        counters.refused += 1;
        send(403, { error: "target is not an allowlisted owner or group" });
        return;
      }
      let payload;
      if (url.pathname === "/send") {
        if (!body.text) {
          send(400, { error: "text is required" });
          return;
        }
        payload = { text: String(body.text) };
      } else {
        if (!body.filePath || !existsSync(body.filePath)) {
          send(404, { error: "file not found" });
          return;
        }
        const allowedPath = sendableFile(body.filePath);
        if (!allowedPath) {
          counters.refused += 1;
          send(403, { error: "only files in the bridge outbox or media folder can be sent" });
          return;
        }
        payload = { document: readFileSync(allowedPath), fileName: body.fileName ?? String(body.filePath).split(/[\\/]/).pop(), mimetype: body.mime ?? "application/octet-stream", caption: body.caption ?? undefined };
      }
      const quoted = body.replyTo ? inboundStore.get(body.replyTo) : null;
      const sent = await sendWithTimeout(jid, payload, quoted ? { quoted } : {});
      outbound.remember(sent?.key?.id);
      counters.sent += 1;
      send(200, { id: sent?.key?.id ?? null });
      return;
    }
    if (request.method === "POST" && url.pathname === "/shutdown") {
      send(200, { ok: true });
      shutdown(0);
      return;
    }
    send(404, { error: "unknown endpoint" });
  } catch (error) {
    log("request failed: " + error.message);
    send(500, { error: "internal error" });
  }
});

function shutdown(code) {
  stopping = true;
  state = "stopped";
  try {
    writeStatus();
  } catch {
    // best effort
  }
  try {
    sock?.end?.(undefined);
  } catch {
    // socket already closed
  }
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 3000).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

writeStatus();
if (!PAIR_ONLY) {
  server.listen(PORT, "127.0.0.1", () => log("bridge listening on 127.0.0.1:" + PORT + " (instance " + INSTANCE + ")"));
}
await startSocket();
