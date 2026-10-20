import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigurationEngine } from "../configuration-engine/configuration.mjs";

export const economyDirectory = (home = homedir()) => join(home, ".astack", "economy");

export function readJson(path, fallback = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      if (!existsSync(path)) {
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  return fallback;
}

export function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp";
  try {
    writeFileSync(temporary, JSON.stringify(value) + "\n", "utf8");
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) {
      unlinkSync(temporary);
    }
  }
}

/** Short cross-process lock: live hook updates must not lose another agent. */
export function updateJson(path, update) {
  mkdirSync(dirname(path), { recursive: true });
  const lock = path + ".lock";
  let descriptor;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      descriptor = openSync(lock, "wx");
      break;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      try {
        if (Date.now() - statSync(lock).mtimeMs > 600000) {
          unlinkSync(lock);
        }
      } catch {
        // Another writer may already have released it.
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  if (descriptor === undefined) {
    throw new Error("Economy cache is busy");
  }
  try {
    const value = update(readJson(path));
    atomicJson(path, value);
    return value;
  } finally {
    closeSync(descriptor);
    unlinkSync(lock);
  }
}

export function appendLedger(directory, entry) {
  mkdirSync(directory, { recursive: true });
  appendFileSync(join(directory, "ledger.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf8");
}

export function mergeConfig(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (["__proto__", "constructor", "prototype"].includes(key)) {
      continue;
    }
    result[key] = value && typeof value === "object" && !Array.isArray(value)
      ? mergeConfig(result[key] ?? {}, value) : value;
  }
  return result;
}

export function readEconomyConfig(root) {
  return mergeConfig(new ConfigurationEngine(root).section("economy", {}), readJson(join(root, ".astack", "economy", "state.json")));
}

export function tail(path, bytes) {
  if (!path || !existsSync(path)) {
    return "";
  }
  const size = statSync(path).size;
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(bytes, size));
    readSync(descriptor, buffer, 0, buffer.length, Math.max(0, size - bytes));
    const text = buffer.toString("utf8");
    return size > bytes ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(descriptor);
  }
}

/** Read bounded lines without retaining image payloads or incomplete records. */
export function scanLines(path, offset, visit, maxLine = 2 * 1024 * 1024) {
  const descriptor = openSync(path, "r");
  const chunk = Buffer.alloc(64 * 1024);
  let position = offset;
  let complete = offset;
  let parts = [];
  let length = 0;
  let dropping = false;
  try {
    let count;
    while ((count = readSync(descriptor, chunk, 0, chunk.length, position)) > 0) {
      let start = 0;
      for (let index = 0; index < count; index += 1) {
        if (chunk[index] !== 10) {
          continue;
        }
        const piece = chunk.subarray(start, index);
        if (!dropping && length + piece.length < maxLine) {
          parts.push(Buffer.from(piece));
          visit(Buffer.concat(parts).toString("utf8"));
        }
        complete = position + index + 1;
        parts = [];
        length = 0;
        dropping = false;
        start = index + 1;
      }
      const piece = chunk.subarray(start, count);
      length += piece.length;
      if (length >= maxLine) {
        dropping = true;
        parts = [];
      } else if (!dropping && piece.length) {
        parts.push(Buffer.from(piece));
      }
      position += count;
    }
    return complete;
  } finally {
    closeSync(descriptor);
  }
}
