import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { extensionFor, multipart, request } from "../http.mjs";

/**
 * Telegram Bot API with long polling.
 *
 *   getUpdates  (offset cursor, long poll)    sendMessage / sendDocument
 *   getFile + /file/bot<token>/<path>         getMe (health)
 *
 * The bot token lives in the request path, so URLs are never logged and
 * errors name only the API method. Owners are Telegram user ids; a private
 * chat's id equals the user's id, so replies go back to that id.
 */
export class TelegramChannel {
  static id = "telegram";

  constructor({ id = "telegram", config = {}, context }) {
    this.id = id;
    this.kind = "telegram";
    this.mode = "poll";
    this.config = config;
    this.context = context;
    this.maxChars = config.max_chars ?? 3500;
  }

  get apiBase() {
    return String(this.config.api_base ?? "https://api.telegram.org").replace(/\/+$/, "");
  }

  configured() {
    const missing = [];
    if (!this.config.token) {
      missing.push("gateway.channels." + this.id + ".token (credential://telegram/bot)");
    }
    return { ok: missing.length === 0, missing };
  }

  normalizeId(value) {
    return String(value ?? "").trim().replace(/^@/, "");
  }

  aliases(value) {
    return new Set([this.normalizeId(value)].filter(Boolean));
  }

  token(purpose) {
    return this.context.secret(this.config.token ?? "credential://telegram/bot", "telegram " + purpose);
  }

  async call(method, payload = {}, { timeoutMs = 30000, signal = null, form = null } = {}) {
    const url = this.apiBase + "/bot" + this.token(method) + "/" + method;
    this.context.assertHost(this.apiBase);
    const response = await request({
      url,
      method: "POST",
      body: form ? form.body : payload,
      headers: form ? { "content-type": form.contentType } : {},
      timeoutMs,
      signal,
      label: "telegram " + method
    });
    const body = response.json();
    if (!body?.ok) {
      throw new Error("telegram " + method + " -> " + response.status + ": " + String(body?.description ?? "no description").slice(0, 200));
    }
    return body.result;
  }

  async health() {
    const me = await this.call("getMe", {}, { timeoutMs: 10000 });
    return { ok: Boolean(me?.id), detail: me?.username ? "@" + me.username : "bot" };
  }

  async poll({ cursor = null, timeoutS = 0, signal = null } = {}) {
    const payload = { timeout: Math.max(0, Math.min(50, Number(timeoutS) || 0)), allowed_updates: ["message"] };
    if (cursor?.offset) {
      payload.offset = cursor.offset;
    }
    const updates = await this.call("getUpdates", payload, { timeoutMs: (payload.timeout + 15) * 1000, signal });
    let offset = cursor?.offset ?? 0;
    const messages = [];
    for (const update of updates ?? []) {
      offset = Math.max(offset, Number(update.update_id) + 1);
      const message = this.toInbound(update.message);
      if (message) {
        messages.push(message);
      }
    }
    return { messages, cursor: { offset } };
  }

  toInbound(raw) {
    if (!raw?.message_id || !raw.chat) {
      return null;
    }
    const voice = raw.voice ?? raw.audio ?? null;
    return {
      id: String(raw.chat.id) + ":" + raw.message_id,
      chatId: String(raw.chat.id),
      senderIds: raw.from?.id ? [String(raw.from.id)] : [],
      isGroup: raw.chat.type !== "private",
      text: raw.text ?? raw.caption ?? "",
      quotedId: raw.reply_to_message ? String(raw.chat.id) + ":" + raw.reply_to_message.message_id : null,
      timestamp: Number(raw.date ?? 0),
      voice: voice ? { ref: voice.file_id, mime: voice.mime_type ?? "audio/ogg" } : null,
      unsupported: !raw.text && !raw.caption && !voice ? "media" : null,
      fromMe: Boolean(raw.from?.is_bot)
    };
  }

  /**
   * Message ids are per chat, so the gateway stores `<chat>:<message>`.
   */
  splitId(id) {
    const value = String(id ?? "");
    const at = value.lastIndexOf(":");
    return at === -1 ? Number(value) : Number(value.slice(at + 1));
  }

  async sendText(target, text, { quoted = null } = {}) {
    const result = await this.call("sendMessage", {
      chat_id: String(target),
      text,
      link_preview_options: { is_disabled: true },
      ...(quoted ? { reply_parameters: { message_id: this.splitId(quoted), allow_sending_without_reply: true } } : {})
    });
    return { id: String(result.chat?.id ?? target) + ":" + result.message_id };
  }

  async sendFile(target, path, { caption = null } = {}) {
    const form = multipart({ chat_id: String(target), caption: caption ?? undefined }, [{ field: "document", path }]);
    const result = await this.call("sendDocument", {}, { form, timeoutMs: 120000 });
    return { id: String(result.chat?.id ?? target) + ":" + result.message_id };
  }

  async downloadVoice(message, directory) {
    const file = await this.call("getFile", { file_id: message.voice.ref });
    if (!file?.file_path) {
      throw new Error("telegram getFile returned no path");
    }
    const response = await request({
      url: this.apiBase + "/file/bot" + this.token("download") + "/" + file.file_path,
      timeoutMs: 60000,
      label: "telegram file download"
    });
    if (response.status >= 400) {
      throw new Error("telegram file download -> " + response.status);
    }
    const path = join(directory, "telegram-" + String(message.id).replace(/[^A-Za-z0-9_-]/g, "_") + extensionFor(message.voice.mime));
    writeFileSync(path, response.body);
    return { path, mime: message.voice.mime, temporary: true };
  }
}
