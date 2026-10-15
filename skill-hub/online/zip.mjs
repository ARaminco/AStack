import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

/**
 * Minimal, defensive ZIP reader (stored and deflate entries only) for skill
 * archives downloaded from a registry.
 *
 * It refuses encrypted and ZIP64 archives, skips symbolic links, rejects any
 * entry whose path is absolute or climbs out of the target folder, and caps
 * the entry count and the total unpacked size. It only writes bytes: nothing
 * extracted is executed or loaded.
 *
 * Entries are also skipped when a segment is git metadata in any case
 * (`.git`, `.GIT.`, `git~1`, `.gitmodules`, `.gitattributes`, `.lfsconfig`),
 * holds `:` (NTFS alternate streams) or another reserved character, ends in a
 * dot or a space, or is a Windows device name (CON, PRN, AUX, NUL, COM1-9,
 * LPT1-9, with any extension), and when a second entry has the same path
 * without regard to case.
 */
export const ZIP_LIMITS = { maxEntries: 500, maxTotalBytes: 20 * 1024 * 1024, maxEntryBytes: 8 * 1024 * 1024 };

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function findEndOfCentralDirectory(buffer) {
  const floor = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= floor; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD) {
      return offset;
    }
  }
  throw new Error("Not a ZIP archive (no end of central directory).");
}

/**
 * A path segment as Windows and git compare it: lower case, trailing dots and
 * spaces removed (NTFS drops them, so `.GIT.` is `.git`).
 */
export function normalisedSegment(segment) {
  return String(segment ?? "").toLowerCase().replace(/[. ]+$/, "");
}

// Git metadata must never be planted by an archive: a `.git` folder in any
// case (`.GIT`, `.Git.`) or its 8.3 short name `git~1` is a repository whose
// config (core.fsmonitor, hooks) git executes, and these files change how git
// reads a checkout (submodules, filters, LFS endpoints).
const GIT_SEGMENTS = new Set([".git", "git~1"]);
const GIT_FILES = new Set([".gitmodules", ".gitattributes", ".lfsconfig"]);
// Windows reserved device names, with or without an extension.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Why a single path segment is refused, or null when it is safe. */
export function unsafeSegment(segment) {
  const part = String(segment ?? "");
  if (part === "..") {
    return "parent folder";
  }
  if (/[\u0000-\u001f\u007f:<>"|?*]/.test(part)) {
    return "reserved character";
  }
  if (/[. ]$/.test(part)) {
    return "trailing dot or space";
  }
  const normal = normalisedSegment(part);
  if (GIT_SEGMENTS.has(normal) || GIT_FILES.has(normal)) {
    return "git metadata";
  }
  if (RESERVED.test(part.split(".")[0].trim()) || RESERVED.test(part.trim())) {
    return "reserved device name";
  }
  return null;
}

/** A safe relative path for an entry name, or null when it must be refused. */
export function safeEntryPath(name) {
  const value = String(name ?? "").replace(/\\/g, "/");
  if (!value || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\0")) {
    return null;
  }
  const parts = value.split("/").filter((part) => part !== "" && part !== ".");
  if (!parts.length || parts.some((part) => unsafeSegment(part))) {
    return null;
  }
  return parts.join("/");
}

/**
 * List the entries of a ZIP buffer without extracting.
 */
export function readZipEntries(buffer, { limits = ZIP_LIMITS } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error("Not a ZIP archive (too short).");
  }
  const end = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(end + 10);
  const size = buffer.readUInt32LE(end + 12);
  const start = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported.");
  }
  if (count > limits.maxEntries) {
    throw new Error("ZIP has " + count + " entries (limit " + limits.maxEntries + ").");
  }
  const entries = [];
  let offset = start;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL) {
      throw new Error("Corrupt ZIP central directory.");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const external = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    const mode = (external >>> 16) & 0o170000;
    entries.push({
      name,
      path: safeEntryPath(name),
      directory: name.endsWith("/") || mode === 0o040000,
      symlink: mode === 0o120000,
      encrypted: Boolean(flags & 1),
      method,
      compressedSize,
      size,
      localOffset
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Extract a ZIP buffer into `target`. Returns { files, skipped }.
 */
export function extractZip(buffer, target, { limits = ZIP_LIMITS } = {}) {
  const entries = readZipEntries(buffer, { limits });
  const root = resolve(target);
  mkdirSync(root, { recursive: true });
  const files = [];
  const skipped = [];
  let total = 0;
  // Case-insensitive bookkeeping: on Windows and macOS `A.md` and `a.md` are
  // one file, so a second spelling would silently overwrite the first.
  const seenFiles = new Set();
  const seenDirectories = new Set();
  const keyOf = (path) => path.split("/").map(normalisedSegment).join("/");
  for (const entry of entries) {
    if (entry.encrypted) {
      throw new Error("Encrypted ZIP entries are not supported: " + entry.name);
    }
    if (!entry.path) {
      skipped.push({ name: entry.name, reason: "unsafe path" });
      continue;
    }
    if (entry.symlink) {
      skipped.push({ name: entry.name, reason: "symbolic link" });
      continue;
    }
    const destination = resolve(root, ...entry.path.split("/"));
    if (destination !== root && !destination.startsWith(root + sep)) {
      skipped.push({ name: entry.name, reason: "unsafe path" });
      continue;
    }
    const key = keyOf(entry.path);
    const parents = key.split("/").slice(0, -1).map((_, index, all) => all.slice(0, index + 1).join("/"));
    if (entry.directory) {
      if (seenFiles.has(key) || parents.some((parent) => seenFiles.has(parent))) {
        skipped.push({ name: entry.name, reason: "duplicate or case-colliding entry" });
        continue;
      }
      seenDirectories.add(key);
      parents.forEach((parent) => seenDirectories.add(parent));
      mkdirSync(destination, { recursive: true });
      continue;
    }
    if (seenFiles.has(key) || seenDirectories.has(key) || parents.some((parent) => seenFiles.has(parent))) {
      skipped.push({ name: entry.name, reason: "duplicate or case-colliding entry" });
      continue;
    }
    seenFiles.add(key);
    parents.forEach((parent) => seenDirectories.add(parent));
    if (entry.size > limits.maxEntryBytes) {
      skipped.push({ name: entry.name, reason: "larger than " + limits.maxEntryBytes + " bytes" });
      continue;
    }
    total += entry.size;
    if (total > limits.maxTotalBytes) {
      throw new Error("ZIP unpacks to more than " + limits.maxTotalBytes + " bytes.");
    }
    const local = entry.localOffset;
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL) {
      throw new Error("Corrupt ZIP local header: " + entry.name);
    }
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize);
    let data;
    if (entry.method === 0) {
      data = Buffer.from(raw);
    } else if (entry.method === 8) {
      data = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) + 1 });
    } else {
      skipped.push({ name: entry.name, reason: "compression method " + entry.method });
      continue;
    }
    if (data.length !== entry.size) {
      throw new Error("ZIP entry size mismatch: " + entry.name);
    }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, data);
    files.push({ path: entry.path, size: data.length });
  }
  return { files, skipped };
}

/** Build a ZIP (stored entries) — used by tests to fake a registry download. */
export function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
    const nameBuffer = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuffer, data);
    centrals.push(central, nameBuffer);
    offset += 30 + nameBuffer.length + data.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

