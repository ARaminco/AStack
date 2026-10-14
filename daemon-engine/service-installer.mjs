import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, posix, win32 } from "node:path";
import { shortHash, slugify } from "../lib/text.mjs";

/**
 * Run the AStack daemon as an operating-system service so it starts at logon
 * and comes back after a crash:
 *
 * - Windows: a Task Scheduler task (logon trigger, hidden, restart on failure)
 * - macOS: a launchd agent in ~/Library/LaunchAgents
 * - Linux: a systemd user unit in ~/.config/systemd/user
 *
 * `plan()` is pure: it returns the exact files and commands, which the CLI
 * prints, `--dry-run` stops at, and the tests check for all three systems.
 */
export function servicePlan({
  platform = process.platform,
  workspaceRoot,
  coreRoot = workspaceRoot,
  nodePath = process.execPath,
  home = homedir(),
  user = safeUser(),
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  windowsLauncher = "conhost-headless"
} = {}) {
  if (!workspaceRoot) {
    throw new Error("servicePlan needs a workspaceRoot");
  }
  // Paths are built for the target system, so a plan for another system can
  // be previewed (and tested) from any machine.
  const join = platform === "win32" ? win32.join : posix.join;
  const basename = platform === "win32" ? win32.basename : posix.basename;
  const id = slugify(basename(workspaceRoot), { fallback: "workspace", maxLength: 24 }) + "-" + shortHash(workspaceRoot).slice(0, 6);
  const entry = join(coreRoot, "bin", "astack.mjs");
  const program = [nodePath, entry, "daemon", "start", "--foreground", "--quiet"];
  const logDirectory = join(workspaceRoot, ".astack", "daemon");
  if (platform === "win32") {
    return windowsPlan({ id, program, workspaceRoot, user, windowsLauncher, logDirectory, join });
  }
  if (platform === "darwin") {
    return macPlan({ id, program, workspaceRoot, home, uid, logDirectory, join });
  }
  return linuxPlan({ id, program, workspaceRoot, home, join });
}

function safeUser() {
  try {
    const info = userInfo();
    const domain = process.env.USERDOMAIN;
    return domain ? domain + "\\" + info.username : info.username;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ windows

function windowsPlan({ id, program, workspaceRoot, user, windowsLauncher, logDirectory, join }) {
  const taskName = "AStack Daemon " + id;
  const xmlPath = join(logDirectory, "astack-daemon-task.xml");
  // conhost --headless keeps a console program windowless for its lifetime.
  const [command, args] = windowsLauncher === "direct"
    ? [program[0], program.slice(1)]
    : ["conhost.exe", ["--headless", ...program]];
  const xml = [
    "<?xml version=\"1.0\" encoding=\"UTF-16\"?>",
    "<Task version=\"1.4\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">",
    "  <RegistrationInfo>",
    "    <Description>AStack daemon: runner queue, scheduler and webhook listener for " + xmlEscape(workspaceRoot) + "</Description>",
    "    <URI>\\" + xmlEscape(taskName) + "</URI>",
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <LogonTrigger>",
    "      <Enabled>true</Enabled>",
    user ? "      <UserId>" + xmlEscape(user) + "</UserId>" : null,
    "      <Delay>PT30S</Delay>",
    "    </LogonTrigger>",
    "  </Triggers>",
    "  <Principals>",
    "    <Principal id=\"Author\">",
    user ? "      <UserId>" + xmlEscape(user) + "</UserId>" : null,
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
    "    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>true</Hidden>",
    "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <Priority>7</Priority>",
    "    <RestartOnFailure>",
    "      <Interval>PT1M</Interval>",
    "      <Count>999</Count>",
    "    </RestartOnFailure>",
    "  </Settings>",
    "  <Actions Context=\"Author\">",
    "    <Exec>",
    "      <Command>" + xmlEscape(command) + "</Command>",
    "      <Arguments>" + xmlEscape(args.map(windowsQuote).join(" ")) + "</Arguments>",
    "      <WorkingDirectory>" + xmlEscape(workspaceRoot) + "</WorkingDirectory>",
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    ""
  ].filter((line) => line !== null).join("\r\n");
  return {
    platform: "win32",
    manager: "Task Scheduler",
    name: taskName,
    files: [{ path: xmlPath, content: xml, encoding: "utf16le", note: "task definition imported by schtasks; kept for reference" }],
    install: [
      ["schtasks", "/Create", "/TN", taskName, "/XML", xmlPath, "/F"],
      ["schtasks", "/Run", "/TN", taskName]
    ],
    uninstall: [["schtasks", "/End", "/TN", taskName], ["schtasks", "/Delete", "/TN", taskName, "/F"]],
    removeFiles: [xmlPath],
    status: ["schtasks", "/Query", "/TN", taskName, "/FO", "LIST", "/V"],
    notes: [
      "Runs at logon of " + (user ?? "the current user") + " without a window; Task Scheduler restarts it every minute after a failure (up to 999 times).",
      "The daemon itself restarts a crashed service with backoff; this task restarts the daemon."
    ]
  };
}

function windowsQuote(value) {
  const text = String(value);
  return /[\s"]/.test(text) ? "\"" + text.replace(/"/g, "\\\"") + "\"" : text;
}

// -------------------------------------------------------------------- macos

function macPlan({ id, program, workspaceRoot, home, uid, logDirectory, join }) {
  const label = "com.astack.daemon." + id;
  const plistPath = join(home, "Library", "LaunchAgents", label + ".plist");
  const plist = [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    "  <key>Label</key><string>" + xmlEscape(label) + "</string>",
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...program.map((part) => "    <string>" + xmlEscape(part) + "</string>"),
    "  </array>",
    "  <key>WorkingDirectory</key><string>" + xmlEscape(workspaceRoot) + "</string>",
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key>",
    "  <dict><key>SuccessfulExit</key><false/></dict>",
    "  <key>ThrottleInterval</key><integer>30</integer>",
    "  <key>ProcessType</key><string>Background</string>",
    "  <key>StandardOutPath</key><string>" + xmlEscape(join(logDirectory, "launchd.out.log")) + "</string>",
    "  <key>StandardErrorPath</key><string>" + xmlEscape(join(logDirectory, "launchd.err.log")) + "</string>",
    "</dict>",
    "</plist>",
    ""
  ].join("\n");
  const domain = "gui/" + (uid ?? "$(id -u)");
  return {
    platform: "darwin",
    manager: "launchd",
    name: label,
    files: [{ path: plistPath, content: plist, encoding: "utf8" }],
    install: [["launchctl", "bootstrap", domain, plistPath], ["launchctl", "enable", domain + "/" + label]],
    uninstall: [["launchctl", "bootout", domain + "/" + label]],
    removeFiles: [plistPath],
    status: ["launchctl", "print", domain + "/" + label],
    notes: ["Starts at login (RunAtLoad) and launchd restarts it after an unsuccessful exit (KeepAlive)."]
  };
}

// -------------------------------------------------------------------- linux

function linuxPlan({ id, program, workspaceRoot, home, join }) {
  const unit = "astack-daemon-" + id + ".service";
  const unitPath = join(home, ".config", "systemd", "user", unit);
  const content = [
    "[Unit]",
    "Description=AStack daemon (" + workspaceRoot.replace(/\n/g, " ") + ")",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "WorkingDirectory=" + systemdPath(workspaceRoot),
    "ExecStart=" + program.map(systemdQuote).join(" "),
    "Restart=on-failure",
    "RestartSec=10",
    "KillSignal=SIGTERM",
    "TimeoutStopSec=30",
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n");
  return {
    platform: "linux",
    manager: "systemd --user",
    name: unit,
    files: [{ path: unitPath, content, encoding: "utf8" }],
    install: [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", unit]],
    uninstall: [["systemctl", "--user", "disable", "--now", unit]],
    after: [["systemctl", "--user", "daemon-reload"]],
    removeFiles: [unitPath],
    status: ["systemctl", "--user", "status", unit, "--no-pager"],
    notes: [
      "Starts with the user session and restarts on failure.",
      "To keep it running after logout: loginctl enable-linger $USER (not run automatically)."
    ]
  };
}

function systemdQuote(value) {
  const text = String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/%/g, "%%");
  return /[\s"'\\]/.test(String(value)) ? "\"" + text + "\"" : text;
}

function systemdPath(value) {
  // WorkingDirectory takes a path, not a quoted word; escape specifiers only.
  return String(value).replace(/%/g, "%%");
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// -------------------------------------------------------------- execution

export function describePlan(plan, { action = "install" } = {}) {
  const lines = ["Service manager: " + plan.manager, "Service name: " + plan.name];
  if (action === "install") {
    for (const file of plan.files) {
      lines.push("Create file: " + file.path + (file.encoding === "utf16le" ? " (UTF-16)" : ""));
      lines.push(...file.content.split(/\r?\n/).map((line) => "    " + line));
    }
    for (const command of plan.install) {
      lines.push("Run: " + command.map(shellDisplay).join(" "));
    }
  } else if (action === "uninstall") {
    for (const command of plan.uninstall) {
      lines.push("Run: " + command.map(shellDisplay).join(" "));
    }
    for (const path of plan.removeFiles) {
      lines.push("Remove file: " + path);
    }
    for (const command of plan.after ?? []) {
      lines.push("Run: " + command.map(shellDisplay).join(" "));
    }
  } else {
    lines.push("Run: " + plan.status.map(shellDisplay).join(" "));
  }
  for (const note of plan.notes ?? []) {
    lines.push("Note: " + note);
  }
  return lines;
}

function shellDisplay(value) {
  return /[\s"]/.test(String(value)) ? "\"" + String(value).replace(/"/g, "\\\"") + "\"" : String(value);
}

function runCommand(command, { allowFailure = false } = {}) {
  const result = spawnSync(command[0], command.slice(1), { encoding: "utf8", windowsHide: true });
  const output = (String(result.stdout ?? "") + String(result.stderr ?? "")).trim();
  if (result.error || (result.status !== 0 && !allowFailure)) {
    throw new Error(command.join(" ") + " failed: " + (result.error?.message ?? output.slice(0, 400)));
  }
  return { command: command.join(" "), status: result.status, output };
}

/**
 * Apply a plan. Never called by tests; `--dry-run` stops before this.
 */
export function applyPlan(plan, { action = "install", audit = null } = {}) {
  const done = [];
  if (action === "install") {
    for (const file of plan.files) {
      mkdirSync(dirname(file.path), { recursive: true });
      if (file.encoding === "utf16le") {
        writeFileSync(file.path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(file.content, "utf16le")]));
      } else {
        writeFileSync(file.path, file.content, "utf8");
      }
      done.push({ command: "write " + file.path, status: 0, output: "" });
    }
    for (const command of plan.install) {
      done.push(runCommand(command));
    }
  } else if (action === "uninstall") {
    for (const command of plan.uninstall) {
      done.push(runCommand(command, { allowFailure: true }));
    }
    for (const path of plan.removeFiles) {
      if (existsSync(path)) {
        rmSync(path, { force: true });
        done.push({ command: "remove " + path, status: 0, output: "" });
      }
    }
    for (const command of plan.after ?? []) {
      done.push(runCommand(command, { allowFailure: true }));
    }
  } else {
    done.push(runCommand(plan.status, { allowFailure: true }));
  }
  if (action !== "status") {
    audit?.record({ actor: "owner", action: "daemon-service-" + action, target: plan.name, riskLevel: "L3", result: plan.manager, metadata: { commands: done.map((entry) => entry.command) } });
  }
  return done;
}
