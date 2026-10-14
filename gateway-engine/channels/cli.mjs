import { randomBytes } from "node:crypto";

/**
 * Loopback channel.
 *
 * Messages are injected with `receive()` and everything the gateway sends is
 * kept in `sent`. It exercises the whole pipeline — allowlist, dedup,
 * approvals, formatting, splitting — with no network, which is what the test
 * suite and `astack gateway test cli` use.
 */
export class CliChannel {
  static id = "cli";

  constructor({ id = "cli", config = {} } = {}) {
    this.id = id;
    this.kind = "cli";
    this.mode = "poll";
    this.config = config;
    this.inbox = [];
    this.sent = [];
    this.maxChars = config.max_chars ?? 1500;
  }

  configured() {
    return { ok: true, missing: [] };
  }

  normalizeId(value) {
    return String(value ?? "").trim().toLowerCase();
  }

  aliases(value) {
    return new Set([this.normalizeId(value)].filter(Boolean));
  }

  receive({ id = null, from, chatId = null, text = "", isGroup = false, quotedId = null, timestamp = null, voice = null }) {
    const message = {
      id: id ?? "cli-" + randomBytes(4).toString("hex"),
      chatId: chatId ?? from,
      senderIds: [from],
      isGroup,
      text,
      quotedId,
      timestamp: timestamp ?? Math.floor(Date.now() / 1000),
      voice,
      fromMe: false
    };
    this.inbox.push(message);
    return message;
  }

  async health() {
    return { ok: true, detail: "loopback" };
  }

  async poll({ cursor = null } = {}) {
    const messages = this.inbox.splice(0, this.inbox.length);
    return { messages, cursor };
  }

  async sendText(target, text, { quoted = null } = {}) {
    const id = "cli-out-" + randomBytes(4).toString("hex");
    this.sent.push({ id, to: target, text, quoted, files: [] });
    return { id };
  }

  async sendFile(target, path, { caption = null } = {}) {
    const id = "cli-out-" + randomBytes(4).toString("hex");
    this.sent.push({ id, to: target, text: caption ?? "", quoted: null, files: [path] });
    return { id };
  }

  async downloadVoice(message) {
    if (!message.voice?.path) {
      throw new Error("loopback voice notes need a local path");
    }
    return { path: message.voice.path, mime: message.voice.mime ?? "audio/ogg", temporary: false };
  }
}
