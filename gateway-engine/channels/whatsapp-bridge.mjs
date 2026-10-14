import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import { request } from "../http.mjs";
import { expandWhatsAppAliases, normalizeWhatsAppId } from "../identity.mjs";
import { readJson } from "../state.mjs";

/**
 * WhatsApp through AStack's own linked-device bridge (Baileys), installed on
 * demand with `astack gateway whatsapp setup` and paired with
 * `astack gateway whatsapp pair`.
 *
 * The bridge listens on 127.0.0.1 only and every call carries the random
 * shared token from `.astack/gateway/bridge/bridge.json`. That address is
 * fixed by AStack, never taken from configuration, which is why this channel
 * does not go through the network allowlist used for remote gateways.
 *
 * The bridge already drops strangers and refuses non-owner targets; the
 * gateway checks both again (defence in depth), resolving phone <-> LID
 * aliases from the mapping files Baileys keeps in the auth directory.
 */
export class WhatsAppBridgeChannel {
  static id = "whatsapp-bridge";

  constructor({ id = "whatsapp-bridge", config = {}, context }) {
    this.id = id;
    this.kind = "whatsapp";
    this.mode = "poll";
    this.config = config;
    this.context = context;
    this.directory = context.bridgeDirectory;
    this.authDirectory = join(this.directory, "auth");
    this.maxChars = config.max_chars ?? 1500;
  }

  connection() {
    return readJson(join(this.directory, "bridge.json"), {});
  }

  configured() {
    const connection = this.connection();
    const missing = [];
    if (!connection.token || !connection.port) {
      missing.push("bridge not set up: astack gateway whatsapp setup");
    }
    return { ok: missing.length === 0, missing };
  }

  normalizeId(value) {
    return normalizeWhatsAppId(value);
  }

  aliases(value) {
    return expandWhatsAppAliases(value, this.authDirectory);
  }

  async call(method, path, { body = null, timeoutMs = 30000, signal = null } = {}) {
    const connection = this.connection();
    if (!connection.token || !connection.port) {
      throw new Error("whatsapp bridge is not set up (astack gateway whatsapp setup)");
    }
    const response = await request({
      url: "http://127.0.0.1:" + Number(connection.port) + path,
      method,
      body,
      headers: { "x-astack-bridge-token": connection.token },
      timeoutMs,
      signal,
      label: "bridge " + method + " " + path.split("?")[0]
    });
    if (response.status >= 400) {
      throw new Error("bridge " + path.split("?")[0] + " -> " + response.status + ": " + String(response.json()?.error ?? "").slice(0, 200));
    }
    return response.json() ?? {};
  }

  async health() {
    const body = await this.call("GET", "/health", { timeoutMs: 5000 });
    return { ok: body.state === "connected", detail: String(body.state ?? "unknown") };
  }

  async poll({ cursor = null, timeoutS = 0, signal = null } = {}) {
    const wait = Math.max(0, Math.min(25, Number(timeoutS) || 0));
    const body = await this.call("GET", "/messages?wait=" + wait, { timeoutMs: (wait + 10) * 1000, signal });
    const messages = (body.messages ?? []).map((raw) => ({
      id: String(raw.id),
      chatId: String(raw.chatId ?? ""),
      senderIds: [raw.senderId, raw.senderAltId, raw.isGroup ? null : raw.chatId].filter(Boolean).map(String),
      isGroup: Boolean(raw.isGroup),
      text: String(raw.text ?? ""),
      quotedId: raw.quotedId ?? null,
      timestamp: Number(raw.timestamp ?? 0),
      voice: raw.voice?.path ? { path: raw.voice.path, mime: raw.voice.mime ?? "audio/ogg" } : null,
      unsupported: raw.unsupported ?? null,
      forwarded: Boolean(raw.forwarded),
      fromMe: false
    }));
    return { messages, cursor };
  }

  async sendText(target, text, { quoted = null } = {}) {
    const body = await this.call("POST", "/send", { body: { chatId: String(target), text, ...(quoted ? { replyTo: quoted } : {}) } });
    return { id: body.id ?? null };
  }

  /**
   * The bridge only sends files from its own outbox folder, so the file is
   * copied there first and removed once the bridge has answered.
   */
  async sendFile(target, path, { caption = null, filename = null } = {}) {
    const outbox = join(this.directory, "outbox");
    mkdirSync(outbox, { recursive: true });
    const name = basename(String(path)).replace(/[^\w.\-]+/g, "_").slice(-120) || "file";
    const staged = join(outbox, randomBytes(6).toString("hex") + "-" + name);
    copyFileSync(path, staged);
    try {
      const body = await this.call("POST", "/send-media", { body: { chatId: String(target), filePath: staged, caption, fileName: filename ?? basename(String(path)) }, timeoutMs: 120000 });
      return { id: body.id ?? null };
    } finally {
      rmSync(staged, { force: true });
    }
  }

  async downloadVoice(message) {
    // The bridge already saved the note next to its session; it is ours to delete.
    return { path: message.voice.path, mime: message.voice.mime, temporary: true };
  }
}
