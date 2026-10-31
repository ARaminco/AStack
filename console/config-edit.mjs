import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The one change the console makes to astack.config.yaml by itself:
 * `console.auth`. A line-level edit, so the owner's comments, ordering and
 * quoting stay exactly as they were. The file is copied to
 * `.astack/backups/console-auth-<stamp>/` first and replaced atomically. When
 * the `console:` section is not in the plain block form this edit understands,
 * nothing is written and the exact line to add by hand is returned.
 */
export const AUTH_MODES = ["token", "password", "both"];

export function authLine(mode) {
  return "auth: " + mode;
}

/** Pure text edit; returns { text } or { manual } when the section has an unusual shape. */
export function withConsoleAuth(source, mode) {
  const crlf = source.includes("\r\n");
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^console\s*:\s*(#.*)?$/.test(line));
  const newline = (list) => list.join(crlf ? "\r\n" : "\n");
  if (start === -1) {
    if (lines.some((line) => /^console\s*:/.test(line))) {
      return { manual: true };
    }
    const tail = source.endsWith("\n") || !source.length ? "" : crlf ? "\r\n" : "\n";
    return { text: source + tail + newline(["", "console:", "  " + authLine(mode), ""]) };
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\S/.test(lines[index]) && !/^#/.test(lines[index])) {
      end = index;
      break;
    }
  }
  let indent = "  ";
  for (let index = start + 1; index < end; index += 1) {
    const found = /^(\s+)\S/.exec(lines[index]);
    if (found && !/^\s*#/.test(lines[index])) {
      indent = found[1];
      break;
    }
  }
  for (let index = start + 1; index < end; index += 1) {
    if (new RegExp("^" + indent + "auth\\s*:").test(lines[index])) {
      const comment = /\s+#.*$/.exec(lines[index]);
      lines[index] = indent + authLine(mode) + (comment ? comment[0] : "");
      return { text: newline(lines) };
    }
  }
  // Insert right after the last non-comment line of the section (keeps trailing comments below).
  let last = start;
  for (let index = start + 1; index < end; index += 1) {
    if (lines[index].trim() && !/^\s*#/.test(lines[index])) {
      last = index;
    }
  }
  lines.splice(last + 1, 0, indent + authLine(mode));
  return { text: newline(lines) };
}

export function setConsoleAuth({ configPath, backupsRoot, mode, clock = () => new Date() }) {
  if (!AUTH_MODES.includes(mode)) {
    throw new Error("console.auth is token, password or both");
  }
  const line = "console:\n  " + authLine(mode);
  if (!configPath || !existsSync(configPath)) {
    return { persisted: false, line, reason: "no astack.config.yaml" };
  }
  const source = readFileSync(configPath, "utf8");
  const edited = withConsoleAuth(source, mode);
  if (edited.manual) {
    return { persisted: false, line, reason: "the console section has an unusual shape" };
  }
  if (edited.text === source) {
    return { persisted: true, line, changed: false };
  }
  const stamp = clock().toISOString().replace(/[-:.]/g, "").slice(0, 15);
  // Two changes in the same second must not overwrite the first backup.
  const parent = backupsRoot ?? dirname(configPath);
  let folder = join(parent, "console-auth-" + stamp);
  for (let index = 2; existsSync(folder); index += 1) {
    folder = join(parent, "console-auth-" + stamp + "-" + index);
  }
  mkdirSync(folder, { recursive: true });
  copyFileSync(configPath, join(folder, "astack.config.yaml"));
  const temporary = configPath + "." + process.pid + ".tmp";
  writeFileSync(temporary, edited.text, "utf8");
  renameSync(temporary, configPath);
  return { persisted: true, line, changed: true, backup: folder };
}
