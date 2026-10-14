import { createServer } from "node:http";

const MAX_BODY_BYTES = 3 * 1024 * 1024;

/**
 * The gateway's own inbound HTTP listener, for channels that push (the
 * WhatsApp Cloud API webhook). It binds to 127.0.0.1 by default; exposing it
 * publicly (a tunnel or reverse proxy with TLS) is the owner's deliberate step.
 *
 *   GET  /gateway/<channel>/webhook   subscription handshake
 *   POST /gateway/<channel>/webhook   signed delivery, acknowledged first
 *   GET  /gateway/health
 */
export class GatewayListener {
  constructor(engine, { host = "127.0.0.1", port = 8788, log = () => {}, rateLimit = 120 } = {}) {
    this.engine = engine;
    this.host = host;
    this.port = Number(port);
    this.log = log;
    this.rateLimit = rateLimit;
    this.hits = new Map();
    this.server = null;
    this.pending = new Set();
  }

  allowRate(address) {
    const now = Date.now();
    const entry = this.hits.get(address) ?? { count: 0, since: now };
    if (now - entry.since > 60000) {
      entry.count = 0;
      entry.since = now;
    }
    entry.count += 1;
    this.hits.set(address, entry);
    return entry.count <= this.rateLimit;
  }

  readBody(request) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      request.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error("payload too large"));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => resolve(Buffer.concat(chunks)));
      request.on("error", reject);
    });
  }

  async handle(request, response) {
    const send = (status, body, type = "application/json; charset=utf-8") => {
      response.writeHead(status, { "content-type": type });
      response.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (!this.allowRate(request.socket.remoteAddress ?? "unknown")) {
      send(429, { ok: false });
      return;
    }
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/gateway/health") {
      send(200, { ok: true });
      return;
    }
    const match = /^\/gateway\/([a-z0-9-]+)\/webhook$/.exec(url.pathname);
    if (!match || !this.engine.enabledChannels().includes(match[1])) {
      send(404, { ok: false, error: "unknown endpoint" });
      return;
    }
    const channel = this.engine.channel(match[1]);
    if (typeof channel.handleWebhook !== "function") {
      send(404, { ok: false, error: "channel has no webhook" });
      return;
    }
    if (request.method === "GET") {
      const verdict = channel.handleVerify(url.searchParams);
      send(verdict.status, verdict.body, verdict.contentType ?? "text/plain; charset=utf-8");
      return;
    }
    if (request.method !== "POST") {
      send(405, { ok: false });
      return;
    }
    let raw;
    try {
      raw = await this.readBody(request);
    } catch {
      send(413, { ok: false });
      return;
    }
    const result = channel.handleWebhook(raw, request.headers);
    if (result.status !== 200) {
      this.log("[gateway] " + match[1] + " webhook rejected: " + (result.reason ?? result.status));
      send(result.status, { ok: false });
      return;
    }
    send(200, { ok: true });
    const work = this.engine.ingest(match[1], result.messages);
    this.pending.add(work);
    work.finally(() => this.pending.delete(work));
  }

  async drain() {
    await Promise.allSettled([...this.pending]);
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((request, response) => {
        this.handle(request, response).catch((error) => {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, error: error.message }));
        });
      });
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.port = this.server.address().port;
        resolve(this);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve(false);
        return;
      }
      this.server.close(() => resolve(true));
    });
  }
}
