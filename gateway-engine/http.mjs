import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * One small HTTP client on node:http / node:https, so the gateway has no
 * dependency and behaves the same on Node 20 and later.
 *
 * Errors never carry the URL: a Telegram bot token lives in the path and a
 * wapi token can sit in a query string, and error messages end up in logs.
 */
export function request({ url, method = "GET", headers = {}, body = null, timeoutMs = 30000, signal = null, label = null }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error("invalid URL for " + (label ?? "request")));
      return;
    }
    const send = parsed.protocol === "https:" ? httpsRequest : httpRequest;
    const payload = body === null || body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const finalHeaders = { ...headers };
    if (payload && !Object.keys(finalHeaders).some((key) => key.toLowerCase() === "content-type")) {
      finalHeaders["content-type"] = "application/json";
    }
    if (payload) {
      finalHeaders["content-length"] = String(payload.length);
    }
    const what = label ?? method + " " + parsed.host;
    const req = send(parsed, { method, headers: finalHeaders }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new Error(what + ": response too large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: buffer,
          text: () => buffer.toString("utf8"),
          json: () => {
            try {
              return JSON.parse(buffer.toString("utf8") || "null");
            } catch {
              return null;
            }
          }
        });
      });
      res.on("error", (error) => reject(new Error(what + ": " + error.message)));
    });
    const timer = setTimeout(() => req.destroy(new Error(what + ": timed out after " + Math.round(timeoutMs / 1000) + "s")), timeoutMs);
    const onAbort = () => req.destroy(new Error(what + ": aborted"));
    signal?.addEventListener?.("abort", onAbort, { once: true });
    req.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      // Node's own messages can quote the host but never the path.
      reject(new Error(String(error.message).startsWith(what) ? error.message : what + ": " + error.message));
    });
    req.on("close", () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    });
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

const MIME = {
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
  ".csv": "text/csv",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

export function mimeFor(path) {
  return MIME[extname(String(path)).toLowerCase()] ?? "application/octet-stream";
}

export function extensionFor(mime) {
  const clean = String(mime ?? "").split(";")[0].trim().toLowerCase();
  const found = Object.entries(MIME).find(([, value]) => value.split(";")[0] === clean);
  return found ? found[0] : ".bin";
}

/**
 * multipart/form-data from plain fields plus at most a few files.
 *   fields: { to: "...", caption: "..." }
 *   files:  [{ field: "file", path }] or [{ field, filename, buffer, mime }]
 */
export function multipart(fields = {}, files = []) {
  const boundary = "----astack" + randomBytes(12).toString("hex");
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) {
      continue;
    }
    parts.push(Buffer.from("--" + boundary + "\r\ncontent-disposition: form-data; name=\"" + name + "\"\r\n\r\n" + String(value) + "\r\n"));
  }
  for (const file of files) {
    const buffer = file.buffer ?? readFileSync(file.path);
    const filename = (file.filename ?? basename(file.path ?? "file")).replace(/["\r\n]/g, "_");
    const mime = file.mime ?? mimeFor(filename);
    parts.push(Buffer.from("--" + boundary + "\r\ncontent-disposition: form-data; name=\"" + file.field + "\"; filename=\"" + filename + "\"\r\ncontent-type: " + mime + "\r\n\r\n"));
    parts.push(buffer);
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from("--" + boundary + "--\r\n"));
  return { body: Buffer.concat(parts), contentType: "multipart/form-data; boundary=" + boundary };
}
