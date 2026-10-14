import { createHmac, timingSafeEqual } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { extensionFor, mimeFor, multipart, request } from "../http.mjs";
import { normalizeWhatsAppId } from "../identity.mjs";

/**
 * Official Meta WhatsApp Business Cloud API.
 *
 * Outbound: Graph API `/<version>/<phone number id>/messages` and `/media`.
 * Inbound:  a webhook on the gateway listener —
 *   GET  ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…  (subscription handshake)
 *   POST body signed with `X-Hub-Signature-256: sha256=<hmac of the raw body>`
 * The signature is checked over the raw bytes before any JSON parsing, with
 * the app secret, in constant time. Without an app secret or verify token the
 * endpoint refuses rather than accepting anything. Callbacks for another
 * phone number id (a shared Meta app) are ignored.
 *
 * Behaviour ported from Hermes Agent (MIT, NousResearch/hermes-agent:
 * gateway/platforms/whatsapp_cloud.py).
 *
 * Cloud API only delivers free-form messages inside the 24 hour window that
 * opens when the owner last wrote to the business number; outside it Meta
 * rejects the send (error 131047) and the gateway reports that honestly.
 */
const MEDIA_ID = /^[A-Za-z0-9._-]{1,128}$/;

export class WhatsAppCloudChannel {
  static id = "whatsapp-cloud";

  constructor({ id = "whatsapp-cloud", config = {}, context }) {
    this.id = id;
    this.kind = "whatsapp";
    this.mode = "webhook";
    this.config = config;
    this.context = context;
    this.maxChars = config.max_chars ?? 3500;
    this.counters = { accepted: 0, rejectedSignature: 0, foreign: 0 };
  }

  get graphBase() {
    return String(this.config.graph_base ?? "https://graph.facebook.com").replace(/\/+$/, "");
  }

  get version() {
    return String(this.config.api_version ?? "v21.0");
  }

  get phoneNumberId() {
    return String(this.config.phone_number_id ?? "");
  }

  webhookPath() {
    return "/gateway/" + this.id + "/webhook";
  }

  configured() {
    const missing = [];
    if (!this.phoneNumberId) {
      missing.push("gateway.channels." + this.id + ".phone_number_id");
    }
    for (const key of ["access_token", "app_secret", "verify_token"]) {
      if (!this.config[key]) {
        missing.push("gateway.channels." + this.id + "." + key + " (credential://whatsapp-cloud/" + key.replace("_", "-") + ")");
      }
    }
    return { ok: missing.length === 0, missing };
  }

  normalizeId(value) {
    return normalizeWhatsAppId(value);
  }

  aliases(value) {
    return new Set([this.normalizeId(value)].filter(Boolean));
  }

  graphUrl(path) {
    return this.graphBase + "/" + this.version + "/" + String(path).replace(/^\/+/, "");
  }

  async graph(method, url, { body = null, headers = {}, timeoutMs = 30000, label }) {
    this.context.assertHost(url);
    const token = this.context.secret(this.config.access_token, "whatsapp-cloud " + label);
    const response = await request({ url, method, body, headers: { authorization: "Bearer " + token, ...headers }, timeoutMs, label: "graph " + label });
    if (response.status >= 400) {
      const error = response.json()?.error ?? {};
      throw new Error("graph " + label + " -> " + response.status + (error.code ? " (code " + error.code + ")" : "") + ": " + String(error.message ?? "").slice(0, 200));
    }
    return response;
  }

  async health() {
    const response = await this.graph("GET", this.graphUrl(this.phoneNumberId + "?fields=display_phone_number,verified_name"), { label: "phone number", timeoutMs: 10000 });
    const body = response.json() ?? {};
    return { ok: Boolean(body.id ?? body.display_phone_number), detail: body.verified_name ? "verified" : "reachable" };
  }

  async poll({ cursor = null } = {}) {
    // Inbound arrives on the webhook; there is nothing to pull.
    return { messages: [], cursor };
  }

  /**
   * GET handshake. Returns { status, body, contentType }.
   */
  handleVerify(query) {
    const expected = this.config.verify_token ? this.safeSecret(this.config.verify_token, "verify token") : null;
    if (!expected) {
      return { status: 503, body: "verify_token not configured" };
    }
    if (query.get("hub.mode") !== "subscribe") {
      return { status: 400, body: "bad mode" };
    }
    if (!constantTimeEqual(query.get("hub.verify_token") ?? "", expected)) {
      return { status: 403, body: "verify_token mismatch" };
    }
    const challenge = query.get("hub.challenge") ?? "";
    if (!challenge) {
      return { status: 400, body: "missing challenge" };
    }
    return { status: 200, body: challenge, contentType: "text/plain" };
  }

  safeSecret(reference, purpose) {
    try {
      return this.context.secret(reference, "whatsapp-cloud " + purpose);
    } catch {
      return null;
    }
  }

  verifySignature(rawBody, header) {
    const secret = this.config.app_secret ? this.safeSecret(this.config.app_secret, "webhook signature") : null;
    if (!secret) {
      return { ok: false, status: 503, reason: "app_secret not configured" };
    }
    const value = String(header ?? "");
    if (!value.startsWith("sha256=")) {
      return { ok: false, status: 401, reason: "missing signature" };
    }
    const computed = createHmac("sha256", secret).update(rawBody).digest("hex");
    if (!constantTimeEqual(value.slice(7).trim().toLowerCase(), computed)) {
      return { ok: false, status: 401, reason: "invalid signature" };
    }
    return { ok: true };
  }

  /**
   * POST webhook. Returns { status, messages } — the caller acknowledges
   * first and processes after, because Meta retries a slow or failed answer
   * for days and would multiply the work.
   */
  handleWebhook(rawBody, headers = {}) {
    const verdict = this.verifySignature(rawBody, headers["x-hub-signature-256"]);
    if (!verdict.ok) {
      if (verdict.status === 401) {
        this.counters.rejectedSignature += 1;
      }
      return { status: verdict.status, reason: verdict.reason, messages: [] };
    }
    let payload = null;
    try {
      payload = JSON.parse(Buffer.from(rawBody).toString("utf8"));
    } catch {
      return { status: 400, reason: "invalid JSON", messages: [] };
    }
    if (payload?.object !== "whatsapp_business_account") {
      return { status: 200, messages: [] };
    }
    const messages = [];
    for (const entry of payload.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        if (change?.field !== "messages" || typeof change.value !== "object") {
          continue;
        }
        const metadata = change.value.metadata ?? {};
        const ourNumber = String(metadata.phone_number_id ?? "") === this.phoneNumberId;
        const ourAccount = !this.config.waba_id || String(entry.id ?? "") === String(this.config.waba_id);
        if (!ourNumber || !ourAccount) {
          if ((change.value.messages ?? []).length) {
            this.counters.foreign += 1;
          }
          continue;
        }
        for (const raw of change.value.messages ?? []) {
          const message = this.toInbound(raw);
          if (message) {
            messages.push(message);
          }
        }
      }
    }
    this.counters.accepted += messages.length;
    return { status: 200, messages };
  }

  toInbound(raw) {
    if (!raw?.id || !raw.from) {
      return null;
    }
    const from = String(raw.from);
    const media = raw.audio ?? null;
    const caption = raw.image?.caption ?? raw.document?.caption ?? raw.video?.caption ?? null;
    const text = raw.text?.body ?? raw.button?.text ?? raw.interactive?.button_reply?.title ?? caption ?? "";
    return {
      id: String(raw.id),
      chatId: from,
      senderIds: [from],
      isGroup: false,
      text,
      quotedId: raw.context?.id ?? null,
      timestamp: Number(raw.timestamp ?? 0),
      voice: media?.id ? { ref: String(media.id), mime: media.mime_type ?? "audio/ogg" } : null,
      unsupported: !text && !media ? raw.type ?? "unknown" : null,
      fromMe: false
    };
  }

  envelope(to, type, block, quoted) {
    return {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: String(to).replace(/\D/g, ""),
      type,
      [type]: block,
      ...(quoted ? { context: { message_id: quoted } } : {})
    };
  }

  async sendText(target, text, { quoted = null } = {}) {
    const response = await this.graph("POST", this.graphUrl(this.phoneNumberId + "/messages"), {
      body: this.envelope(target, "text", { preview_url: false, body: text }, quoted),
      label: "send text"
    });
    return { id: response.json()?.messages?.[0]?.id ?? null };
  }

  async sendFile(target, path, { caption = null, filename = null } = {}) {
    const mime = mimeFor(path);
    const form = multipart({ messaging_product: "whatsapp", type: mime }, [{ field: "file", path, mime }]);
    const upload = await this.graph("POST", this.graphUrl(this.phoneNumberId + "/media"), {
      body: form.body,
      headers: { "content-type": form.contentType },
      timeoutMs: 120000,
      label: "media upload"
    });
    const mediaId = upload.json()?.id;
    if (!mediaId) {
      throw new Error("graph media upload returned no id");
    }
    const name = filename ?? String(path).split(/[\\/]/).pop();
    const response = await this.graph("POST", this.graphUrl(this.phoneNumberId + "/messages"), {
      body: this.envelope(target, "document", { id: mediaId, filename: name, ...(caption ? { caption } : {}) }, null),
      label: "send document"
    });
    return { id: response.json()?.messages?.[0]?.id ?? null };
  }

  /**
   * Two steps: the media id resolves to a short-lived URL, which still needs
   * the bearer token.
   */
  async downloadVoice(message, directory) {
    const mediaId = String(message.voice.ref);
    if (!MEDIA_ID.test(mediaId)) {
      throw new Error("refusing a malformed media id");
    }
    const meta = (await this.graph("GET", this.graphUrl(mediaId), { label: "media lookup" })).json() ?? {};
    if (!meta.url) {
      throw new Error("graph media lookup returned no url");
    }
    const blob = await this.graph("GET", meta.url, { label: "media download", timeoutMs: 60000 });
    const mime = meta.mime_type ?? message.voice.mime;
    const path = join(directory, "cloud-" + mediaId.replace(/[^A-Za-z0-9_-]/g, "") + extensionFor(mime));
    writeFileSync(path, blob.body);
    return { path, mime, temporary: true };
  }
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signWebhookBody(rawBody, secret) {
  return "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
}
