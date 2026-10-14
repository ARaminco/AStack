import { spawn } from "node:child_process";
import { parseArgs } from "../delivery-engine/cli.mjs";
import { ConsoleAuth } from "./auth.mjs";
import { ConsoleServer, consoleStateDirectory, readServerRecord, resolveConsoleSettings } from "./server.mjs";

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
 * `astack console status`
 */
export async function runConsoleCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "status", ...rest] = tokens;
  const { flags } = parseArgs(rest);
  const config = runtime.configuration.section("console", {});
  const auth = new ConsoleAuth(consoleStateDirectory(runtime.workspaceRoot), { sessionDays: config.session_days ?? 30 });

  if (action === "token") {
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
    } else {
      out(t("cli.console.stopped"));
    }
    out(t("cli.console.tokenState", { state: auth.hasToken() ? "present" : "missing", sessions: auth.count() }));
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
