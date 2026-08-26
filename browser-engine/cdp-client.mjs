/**
 * A minimal Chrome DevTools Protocol client built on the WebSocket that ships
 * with Node. No driver, no browser automation dependency: AStack talks to the
 * browser the same way a devtools window does.
 */
export class CdpClient {
  constructor(webSocketUrl, { timeoutMs = 30000 } = {}) {
    this.url = webSocketUrl;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  connect() {
    if (typeof WebSocket === "undefined") {
      return Promise.reject(
        new Error(
          "This Node.js build has no global WebSocket, which the browser operator needs. " +
            "Node 22 or newer is required for browser sessions; everything else in AStack runs on Node 20."
        )
      );
    }
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      const timer = setTimeout(() => reject(new Error("CDP connection timed out: " + this.url)), this.timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        this.socket = socket;
        resolve(this);
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("CDP connection failed: " + this.url));
      });
      socket.addEventListener("close", () => {
        for (const [, entry] of this.pending) {
          entry.reject(new Error("CDP connection closed"));
        }
        this.pending.clear();
      });
      socket.addEventListener("message", (event) => this.handleMessage(String(event.data)));
    });
  }

  handleMessage(raw) {
    let message = null;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new Error(message.error.message ?? "CDP error"));
        return;
      }
      entry.resolve(message.result);
      return;
    }
    if (message.method) {
      for (const handler of this.listeners.get(message.method) ?? []) {
        handler(message.params ?? {});
      }
    }
  }

  on(method, handler) {
    const handlers = this.listeners.get(method) ?? [];
    handlers.push(handler);
    this.listeners.set(method, handlers);
    return () => {
      this.listeners.set(method, (this.listeners.get(method) ?? []).filter((entry) => entry !== handler));
    };
  }

  once(method, { timeoutMs = this.timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error("Timed out waiting for " + method));
      }, timeoutMs);
      const off = this.on(method, (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  send(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    if (!this.socket || this.socket.readyState !== 1) {
      return Promise.reject(new Error("CDP socket is not open"));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("CDP command timed out: " + method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, { awaitPromise = true, returnByValue = true } = {}) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue,
      userGesture: true
    });
    if (result.exceptionDetails) {
      throw new Error("page error: " + (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text));
    }
    return result.result?.value;
  }

  close() {
    if (this.socket && this.socket.readyState === 1) {
      this.socket.close();
    }
    this.socket = null;
  }
}

export async function listTargets(port) {
  const response = await fetch("http://127.0.0.1:" + port + "/json/list", { signal: AbortSignal.timeout(5000) });
  if (!response.ok) {
    throw new Error("Cannot list browser targets on port " + port);
  }
  return response.json();
}

export async function openTarget(port, url = "about:blank") {
  const endpoint = "http://127.0.0.1:" + port + "/json/new?" + encodeURIComponent(url);
  for (const method of ["PUT", "GET"]) {
    try {
      const response = await fetch(endpoint, { method, signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        return response.json();
      }
    } catch {
      continue;
    }
  }
  throw new Error("Cannot open a new browser tab on port " + port);
}

export async function attachToPage(port, { url = null, timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await listTargets(port);
    const pages = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
    const target = url ? pages.find((page) => page.url.startsWith(url)) ?? pages[0] : pages[0];
    if (target) {
      const client = new CdpClient(target.webSocketDebuggerUrl);
      await client.connect();
      return { client, target };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("No page target became available on port " + port);
}
