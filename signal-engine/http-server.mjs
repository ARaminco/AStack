import { createServer } from "node:http";
import { RateLimiter, assertBindable } from "../lib/net.mjs";

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
  constructor(engine, { port = 8787, host = "127.0.0.1", log = console.log, processImmediately = true, rateLimit = 60, allowRemote = false, maxTracked = 5000 } = {}) {
    this.engine = engine;
    this.port = Number(port);
    this.host = host;
    this.log = log;
    this.processImmediately = processImmediately;
    this.rateLimit = rateLimit;
    // A non-loopback bind needs signals.server.allow_remote: true (or
    // `astack signal serve --allow-remote`).
    this.allowRemote = allowRemote === true;
    // Bounded: a flood of addresses cannot grow memory without limit.
    this.limiter = new RateLimiter({ limit: rateLimit, windowMs: 60 * 1000, maxEntries: maxTracked });
    this.hits = this.limiter.hits;
    this.server = null;
  }

  allowRate(address) {
    return this.limiter.allow(address);
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
      // The detail goes to the log, never to the sender.
      this.log("[signal] processing " + event.id + " failed: " + error.message);
      send(500, { ok: false, id: event.id, error: "internal error" });
    }
  }

  start() {
    try {
      assertBindable(this.host, { allowRemote: this.allowRemote, setting: "signals.server.allow_remote" });
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      this.server = createServer((request, response) => {
        this.handle(request, response).catch((error) => {
          this.log("[signal] request failed: " + error.message);
          if (!response.headersSent) {
            response.writeHead(500, { "content-type": "application/json" });
          }
          response.end(JSON.stringify({ ok: false, error: "internal error" }));
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
