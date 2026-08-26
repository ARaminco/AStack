import { createServer } from "node:http";

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The inbound endpoint.
 *
 * One small HTTP listener, no framework, that any external tool can post to:
 * `POST /hooks/<hookId>?token=...` with an optional `x-astack-signature`
 * HMAC header. Requests are rate limited per address, size capped, verified,
 * normalized and queued; processing happens on the scheduler tick so a slow
 * reaction can never block the sender.
 */
export class SignalServer {
  constructor(engine, { port = 8787, host = "127.0.0.1", log = console.log, processImmediately = true, rateLimit = 60 } = {}) {
    this.engine = engine;
    this.port = Number(port);
    this.host = host;
    this.log = log;
    this.processImmediately = processImmediately;
    this.rateLimit = rateLimit;
    this.hits = new Map();
    this.server = null;
  }

  allowRate(address) {
    const now = Date.now();
    const window = 60 * 1000;
    const entry = this.hits.get(address) ?? { count: 0, since: now };
    if (now - entry.since > window) {
      entry.count = 0;
      entry.since = now;
    }
    entry.count += 1;
    this.hits.set(address, entry);
    return entry.count <= this.rateLimit;
  }

  readBody(request) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      request.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error("payload too large"));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      request.on("error", reject);
    });
  }

  async handle(request, response) {
    const address = request.socket.remoteAddress ?? "unknown";
    const url = new URL(request.url, "http://" + (request.headers.host ?? this.host));
    const send = (status, body) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };
    if (!this.allowRate(address)) {
      send(429, { ok: false, error: "rate limit exceeded" });
      return;
    }
    if (url.pathname === "/health") {
      send(200, { ok: true, status: this.engine.status() });
      return;
    }
    const match = /^\/hooks\/([a-z0-9-]+)$/i.exec(url.pathname);
    if (!match || request.method !== "POST") {
      send(404, { ok: false, error: "unknown endpoint" });
      return;
    }
    const hookId = match[1];
    if (!this.engine.exists(hookId)) {
      send(404, { ok: false, error: "unknown hook" });
      return;
    }
    let rawBody = "";
    try {
      rawBody = await this.readBody(request);
    } catch (error) {
      send(413, { ok: false, error: error.message });
      return;
    }
    const hook = this.engine.get(hookId);
    const verdict = this.engine.verify(hook, {
      rawBody,
      signature: request.headers["x-astack-signature"] ?? null,
      token: url.searchParams.get("token") ?? request.headers["x-astack-token"] ?? null,
      timestamp: request.headers["x-astack-timestamp"] ?? null
    });
    if (!verdict.ok) {
      this.log("[signal] rejected " + hookId + " from " + address + ": " + verdict.reason);
      send(401, { ok: false, error: verdict.reason });
      return;
    }
    let payload = {};
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      payload = { text: rawBody };
    }
    const event = this.engine.queue(this.engine.normalize(hook, payload));
    this.log("[signal] queued " + event.id + " from " + hookId + " (" + (event.domain ?? "no domain") + ")");
    if (!this.processImmediately) {
      send(202, { ok: true, id: event.id, state: event.state });
      return;
    }
    try {
      const processed = await this.engine.process(event);
      send(200, {
        ok: true,
        id: processed.id,
        domain: processed.domain,
        reactions: processed.reactions.map((reaction) => ({ action: reaction.action, ok: reaction.ok, summary: reaction.summary }))
      });
    } catch (error) {
      send(500, { ok: false, id: event.id, error: error.message });
    }
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
        this.log("signal server listening on http://" + this.host + ":" + this.port);
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
