import { spawn } from "node:child_process";
import { parseArgs } from "../delivery-engine/cli.mjs";
import { ConsoleAuth } from "./auth.mjs";
import { ConsoleUsers } from "./users.mjs";
import { readSecretValue } from "../cli/vault-cli.mjs";
import { isUnattended } from "../trust-engine/approvals.mjs";
import { ConsoleServer, consoleStateDirectory, readServerRecord, resolveConsoleSettings, resolveRemoteSettings } from "./server.mjs";

const out = (line) => console.log(line);

function openBrowser(url) {
  const [command, args] = process.platform === "win32"
    ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * `astack console start [--port <n>] [--host <addr>] [--open]`
 * `astack console token [--rotate]`
 * `astack console open` — sign in from the browser with a one-time ticket
 * `astack console status`
 * `astack console user set|list|remove|totp <username> [--disable]`
 *
 * `token` and `user set|remove|totp` refuse to run in an unattended process
 * (`ASTACK_UNATTENDED`, set for runner children and console conversations):
 * sign-in material is managed by the owner only.
 */
export async function runConsoleCommand({ runtime, i18n, tokens, stdin = process.stdin }) {
  const t = i18n.t.bind(i18n);
  const [action = "status", ...rest] = tokens;
  const { flags } = parseArgs(rest);
  const config = runtime.configuration.section("console", {});
  const auth = new ConsoleAuth(consoleStateDirectory(runtime.workspaceRoot), { sessionDays: config.session_days ?? 30 });

  if (action === "token") {
    refuseUnattended(t);
    if (flags.rotate) {
      const value = auth.rotate();
      out(t("cli.console.tokenRotated"));
      out(value);
      return;
    }
    const created = !auth.hasToken();
    const value = auth.token();
    out(t(created ? "cli.console.tokenCreated" : "cli.console.tokenShown"));
    out(value);
    out(t("cli.console.tokenHint"));
    return;
  }

  if (action === "user") {
    await runUserCommand({ runtime, t, rest, flags, stdin, auth });
    return;
  }

  if (action === "status") {
    const record = readServerRecord(runtime.workspaceRoot);
    let healthy = false;
    if (record?.alive) {
      try {
        const response = await fetch(record.url + "/api/health", { signal: AbortSignal.timeout(2000) });
        healthy = response.ok;
      } catch {
        healthy = false;
      }
    }
    if (record?.alive && healthy) {
      const since = new Date(record.startedAt);
      const pad = (value) => String(value).padStart(2, "0");
      const stamp = pad(since.getDate()) + "/" + pad(since.getMonth() + 1) + "/" + since.getFullYear() + " " + pad(since.getHours()) + ":" + pad(since.getMinutes());
      out(t("cli.console.running", { url: record.url, pid: record.pid, since: stamp }));
      if (record.remote) {
        out(record.remote.running
          ? t("cli.console.remoteRunning", { url: record.remote.url, publicUrl: record.remote.publicUrl, chat: record.remote.chat ? "on" : "off", access: record.remote.access ? "on" : "off" })
          : t("cli.console.remoteStopped", { reason: record.remote.error ?? "-" }));
      }
    } else {
      out(t("cli.console.stopped"));
      // Not running: still say why the internet listener would not start.
      const remote = resolveRemoteSettings(config.remote);
      if (remote?.error) {
        out(t("cli.console.remoteStopped", { reason: remote.error }));
      }
    }
    out(t("cli.console.tokenState", { state: auth.hasToken() ? "present" : "missing", sessions: auth.count() }));
    const users = new ConsoleUsers(consoleStateDirectory(runtime.workspaceRoot)).list();
    out(t("cli.console.usersState", { count: users.length, totp: users.filter((user) => user.totp).length }));
    return;
  }

  if (action === "open") {
    // The console usually runs inside the daemon, so the ticket is shared
    // through the state folder (hash only) and dies after one login or a minute.
    const record = readServerRecord(runtime.workspaceRoot);
    if (!record?.alive) {
      out(t("cli.console.stopped"));
      process.exitCode = 1;
      return;
    }
    const ticket = auth.issueTicket({ shared: true });
    if (!openBrowser(record.url + "/#ticket=" + ticket)) {
      out(t("cli.console.openFailed", { url: record.url }));
      return;
    }
    out(t("cli.console.opened", { url: record.url }));
    return;
  }

  if (action === "start") {
    const settings = resolveConsoleSettings(config, {
      host: typeof flags.host === "string" ? flags.host : undefined,
      port: flags.port !== undefined && flags.port !== true ? flags.port : undefined
    });
    for (const warning of settings.warnings) {
      out("⚠ " + warning);
    }
    const existing = readServerRecord(runtime.workspaceRoot);
    if (existing?.alive && existing.pid !== process.pid) {
      out(t("cli.console.alreadyRunning", { url: existing.url, pid: existing.pid }));
      process.exitCode = 1;
      return;
    }
    const server = new ConsoleServer({ runtime, ...settings });
    try {
      await server.start();
    } catch (error) {
      if (error.code === "EADDRINUSE") {
        throw new Error(t("cli.console.portBusy", { port: settings.port }));
      }
      throw error;
    }
    out(t("cli.console.started", { url: server.origin }));
    const remote = server.describe().remote;
    if (remote?.running) {
      out(t("cli.console.remoteStarted", { url: remote.url, publicUrl: remote.publicUrl }));
    }
    out(t("cli.console.tokenMasked", { token: auth.masked() }));
    if (flags.open) {
      // A one-time ticket in the URL fragment: the fragment never reaches a
      // request line or a log, and the ticket dies after one login or a minute.
      const ticket = server.auth.issueTicket();
      if (!openBrowser(server.origin + "/#ticket=" + ticket)) {
        out(t("cli.console.openFailed", { url: server.origin }));
      }
    }
    out(t("cli.console.stopHint"));
    await new Promise((resolve) => {
      const shutdown = () => {
        server.stop().then(resolve);
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
    out(t("cli.console.stoppedNow"));
    return;
  }

  throw new Error(t("cli.console.unknownAction", { action }));
}

function refuseUnattended(t) {
  if (isUnattended()) {
    throw new Error(t("cli.console.unattendedRefused"));
  }
}

/**
 * Console users for password sign-in. The password is read from a hidden
 * prompt (twice, on a terminal) or from stdin; only its scrypt hash is kept.
 * Changing a password or TOTP, or removing a user, also ends that user's
 * sessions (and the new credential version refuses any the server still holds).
 */
async function runUserCommand({ runtime, t, rest, flags, stdin = process.stdin, auth }) {
  const users = new ConsoleUsers(consoleStateDirectory(runtime.workspaceRoot), { workspaceRoot: runtime.workspaceRoot });
  const positionals = rest.filter((token) => !String(token).startsWith("--"));
  const [verb = "list", name] = positionals;
  if (verb !== "list") {
    refuseUnattended(t);
  }
  const revoke = (username) => {
    const ended = auth.destroyUserSessions(username);
    if (ended) {
      out(t("cli.console.userSessionsEnded", { count: ended }));
    }
  };
  if (verb === "list") {
    const list = users.list();
    if (!list.length) {
      out(t("cli.console.userNone"));
      return;
    }
    for (const user of list) {
      out("- " + user.username + "  totp: " + (user.totp ? "on (" + user.totpStore + ")" : "off") + "  " + t("cli.console.userUpdated", { at: user.updatedAt ?? "-" }));
    }
    return;
  }
  if (!name) {
    throw new Error(t("cli.console.userUsage"));
  }
  if (verb === "set") {
    const password = await readSecretValue({ prompt: t("cli.console.passwordPrompt"), stdin });
    if (stdin.isTTY) {
      const again = await readSecretValue({ prompt: t("cli.console.passwordAgain"), stdin });
      if (again !== password) {
        throw new Error(t("cli.console.passwordMismatch"));
      }
    }
    const result = await users.set(name, password);
    out(t(result.created ? "cli.console.userCreated" : "cli.console.userUpdatedNow", { username: result.username }));
    revoke(result.username);
    runtime.audit?.record({ actor: "owner@cli", action: "console-user-set", target: result.username, riskLevel: "L2", result: result.created ? "created" : "password changed" });
    if (!users.hasTotp(result.username)) {
      out(t("cli.console.totpHint", { username: result.username }));
    }
    return;
  }
  if (verb === "remove") {
    const removed = users.remove(name);
    out(t(removed ? "cli.console.userRemoved" : "cli.console.userUnknown", { username: name }));
    if (removed) {
      revoke(String(name).toLowerCase());
      runtime.audit?.record({ actor: "owner@cli", action: "console-user-removed", target: String(name).toLowerCase(), riskLevel: "L2", result: "removed" });
    }
    return;
  }
  if (verb === "totp") {
    if (flags.disable) {
      users.disableTotp(name);
      out(t("cli.console.totpDisabled", { username: name }));
      revoke(String(name).toLowerCase());
      runtime.audit?.record({ actor: "owner@cli", action: "console-user-totp", target: String(name).toLowerCase(), riskLevel: "L2", result: "disabled" });
      return;
    }
    const enabled = users.enableTotp(name);
    out(t("cli.console.totpEnabled", { username: enabled.username }));
    // The only time the secret is ever printed: enrolment.
    out(t("cli.console.totpSecret", { secret: enabled.secret.replace(/(.{4})/g, "$1 ").trim() }));
    out(t("cli.console.totpUri"));
    out(enabled.uri);
    out(t("cli.console.totpWarning"));
    out(t("cli.console.totpStored", { store: enabled.store }));
    revoke(enabled.username);
    runtime.audit?.record({ actor: "owner@cli", action: "console-user-totp", target: enabled.username, riskLevel: "L2", result: "enabled" });
    return;
  }
  throw new Error(t("cli.console.userUsage"));
}
