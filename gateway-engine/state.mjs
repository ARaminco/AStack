import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Durable gateway state under `.astack/gateway/`.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write never leaves a
 * half JSON file that would reset cursors and replay old commands.
 */
export function readJson(path, fallback) {
  if (!existsSync(path)) {
    return structuredClone(fallback);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
  } catch {
    return structuredClone(fallback);
  }
}

export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + "." + process.pid + "." + Date.now() + ".tmp";
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(temporary, path);
  return value;
}

export const EMPTY_STATE = {
  version: 1,
  cursors: {},
  seen: {},
  prompts: [],
  outbox: [],
  sends: {},
  ignored: {}
};

export class GatewayState {
  constructor(directory) {
    this.directory = directory;
    this.path = join(directory, "state.json");
  }

  read() {
    return { ...structuredClone(EMPTY_STATE), ...readJson(this.path, EMPTY_STATE) };
  }

  write(state) {
    return writeJsonAtomic(this.path, state);
  }

  update(mutator) {
    const state = this.read();
    const result = mutator(state);
    this.write(state);
    return result;
  }
}

/**
 * A process-exclusive lock file. A lock held by a process that no longer
 * exists, or older than `staleMs`, is taken over.
 */
export function acquireLock(path, { staleMs = 10 * 60 * 1000 } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = openSync(path, "wx");
      writeSync(handle, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      closeSync(handle);
      return { path, release: () => rmSync(path, { force: true }) };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      const holder = readJson(path, {});
      const age = Date.now() - (existsSync(path) ? statSync(path).mtimeMs : 0);
      if (holder.pid && holder.pid !== process.pid && processAlive(holder.pid) && age < staleMs) {
        return null;
      }
      rmSync(path, { force: true });
    }
  }
  return null;
}

export function processAlive(pid) {
  if (!pid || !Number.isInteger(Number(pid))) {
    return false;
  }
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
