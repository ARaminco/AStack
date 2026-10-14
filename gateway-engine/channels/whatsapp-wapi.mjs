import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { extensionFor, multipart, request } from "../http.mjs";
import { expandWhatsAppAliases, isGroupId, normalizeWhatsAppId } from "../identity.mjs";

/**
 * WhatsApp through a self-hosted wapi gateway (Whapi-compatible REST API).
 *
 * Inbound is polled from the gateway's message store — no public endpoint is
 * needed, and a restart resumes from the stored cursor:
 *   GET  /messages/list?from_me=false&time_from=<unix s>&sort=asc&count=100
 * Outbound and media:
 *   POST /messages/text   { to, body, quoted? }
 *   POST /messages/file   multipart: file, to, caption?, filename?
 *   GET  /media/{message id}      (voice note bytes)
 *   GET  /health                  (read-only connection state)
 * Every call carries `Authorization: Bearer <channel token>`; the token is a
 * `credential://` reference resolved only for the call.
 *
 * Run the gateway on a dedicated number. Messages the channel itself sent
 * (`from_me`) are never read back as commands.
 */
export class WapiChannel {
  static id = "whatsapp-wapi";

  constructor({ id = "whatsapp-wapi", config = {}, context }) {
    this.id = id;
    this.kind = "whatsapp";
    this.mode = "poll";
    this.config = config;
    this.context = context;
    this.maxChars = config.max_chars ?? 1500;
  }

  get baseUrl() {
    return String(this.config.base_url ?? "").replace(/\/+$/, "");
  }

  configured() {
    const missing = [];
    if (!this.baseUrl) {
      missing.push("gateway.channels." + this.id + ".base_url");
    }
    if (!this.config.token) {
      missing.push("gateway.channels." + this.id + ".token (credential://wapi/<name>)");
    }
    return { ok: missing.length === 0, missing };
  }

  normalizeId(value) {
    return normalizeWhatsAppId(value);
  }

  aliases(value) {
    return expandWhatsAppAliases(value, null);
  }

  async call(method, path, { body = null, headers = {}, timeoutMs = 30000, label = null } = {}) {
    const url = this.baseUrl + path;
    this.context.assertHost(url);
    const token = this.context.secret(this.config.token, "wapi " + (label ?? path.split("?")[0]));
    const response = await request({
      url,
      method,
      body,
      headers: { authorization: "Bearer " + token, accept: "application/json", ...headers },
      timeoutMs,
      label: "wapi " + method + " " + path.split("?")[0].replace(/\/[^/]{16,}$/, "/:id")
    });
    if (response.status >= 400) {
      const error = response.json()?.error?.message ?? response.text().slice(0, 200);
      throw new Error("wapi " + method + " " + path.split("?")[0] + " -> " + response.status + ": " + error);
    }
    return response;
  }

  async health() {
    const response = await this.call("GET", "/health", { label: "health", timeoutMs: 10000 });
    const body = response.json() ?? {};
    return { ok: String(body.status ?? "").toLowerCase() === "connected", detail: String(body.status ?? "unknown") };
  }

  /**
   * One page of inbound messages newer than the cursor. `time_from` is
   * inclusive, so the boundary message comes back again and is dropped by
   * the gateway's dedup on message id.
   */
  async poll({ cursor = null } = {}) {
    const now = Math.floor(this.context.now().getTime() / 1000);
    const since = Number(cursor?.ts ?? now);
    const query = "?from_me=false&sort=asc&count=" + (this.config.page_size ?? 100) + "&time_from=" + since;
    const response = await this.call("GET", "/messages/list" + query, { label: "list" });
    const list = response.json()?.messages ?? [];
    let latest = since;
    const messages = [];
    for (const raw of list) {
      const message = this.toInbound(raw);
      if (!message) {
        continue;
      }
      latest = Math.max(latest, message.timestamp);
      messages.push(message);
    }
    return { messages, cursor: { ts: latest } };
  }

  toInbound(raw) {
    if (!raw?.id || raw.from_me) {
      return null;
    }
    const chatId = String(raw.chat_id ?? "");
    const isGroup = isGroupId(chatId) || raw.chat_type === "group";
    const senderIds = [raw.from, raw.from_phone, raw.from_jid].filter(Boolean).map(String);
    if (!isGroup && chatId) {
      senderIds.push(chatId);
    }
    const media = raw.voice ?? raw.audio ?? null;
    const caption = raw.image?.caption ?? raw.document?.caption ?? raw.video?.caption ?? null;
    return {
      id: String(raw.id),
      chatId,
      senderIds: [...new Set(senderIds)],
      isGroup,
      text: raw.text?.body ?? caption ?? "",
      quotedId: raw.context?.quoted_id ?? null,
      timestamp: Number(raw.timestamp ?? 0),
      voice: raw.type === "voice" || raw.type === "audio" ? { ref: String(raw.id), mime: media?.mimetype ?? "audio/ogg" } : null,
      unsupported: !raw.text?.body && !caption && !["voice", "audio"].includes(raw.type) ? raw.type ?? "unknown" : null,
      // wapi exposes WhatsApp's forwarded flag in a few spellings.
      forwarded: Boolean(raw.forwarded || raw.is_forwarded || raw.isForwarded || raw.context?.forwarded || raw.context?.is_forwarded || Number(raw.forwarding_score ?? raw.context?.forwarding_score ?? 0) > 0),
      fromMe: false
    };
  }

  async sendText(target, text, { quoted = null } = {}) {
    const response = await this.call("POST", "/messages/text", {
      body: { to: String(target), body: text, ...(quoted ? { quoted } : {}), no_link_preview: true },
      label: "send text"
    });
    return { id: response.json()?.message?.id ?? null };
  }

  async sendFile(target, path, { caption = null, filename = null } = {}) {
    const form = multipart({ to: String(target), caption: caption ?? undefined, filename: filename ?? undefined }, [{ field: "file", path }]);
    const response = await this.call("POST", "/messages/file", {
      body: form.body,
      headers: { "content-type": form.contentType },
      timeoutMs: 120000,
      label: "send file"
    });
    return { id: response.json()?.message?.id ?? null };
  }

  async downloadVoice(message, directory) {
    const response = await this.call("GET", "/media/" + encodeURIComponent(message.voice.ref), { timeoutMs: 60000, label: "media" });
    const mime = String(response.headers["content-type"] ?? message.voice.mime ?? "audio/ogg");
    const path = join(directory, "wapi-" + String(message.id).replace(/[^A-Za-z0-9_-]/g, "") + extensionFor(mime));
    writeFileSync(path, response.body);
    return { path, mime, temporary: true };
  }
}
