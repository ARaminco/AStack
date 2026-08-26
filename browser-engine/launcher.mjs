import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";

const CANDIDATES = {
  win32: [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    "C:/Program Files/Chromium/Application/chrome.exe"
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/snap/bin/chromium"
  ]
};

const LAUNCH_FLAGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-features=TranslateUI,MediaRouter",
  "--password-store=basic",
  "--use-mock-keychain"
];

export function findBrowserBinary({ preferred = null } = {}) {
  const explicit = preferred ?? process.env.ASTACK_BROWSER_PATH ?? null;
  if (explicit && existsSync(explicit)) {
    return explicit;
  }
  for (const candidate of CANDIDATES[platform()] ?? CANDIDATES.linux) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  const local = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe")
    : null;
  if (local && existsSync(local)) {
    return local;
  }
  return null;
}

async function waitForEndpoint(port, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/json/version", { signal: AbortSignal.timeout(1500) });
      if (response.ok) {
        return await response.json();
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Browser did not expose its debugging endpoint on port " + port + (lastError ? ": " + lastError.message : ""));
}

export async function findFreePort(start = 9333) {
  const net = await import("node:net");
  for (let port = start; port < start + 200; port += 1) {
    const free = await new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => server.close(() => resolve(true)));
      server.listen(port, "127.0.0.1");
    });
    if (free) {
      return port;
    }
  }
  throw new Error("No free debugging port found");
}

/**
 * Launch a real browser against a persistent profile directory.
 *
 * The profile directory is the whole point: the owner logs in once in a headed
 * window and every later automated run reuses that session, exactly like a
 * human coming back to their own browser.
 */
export async function launchBrowser({
  userDataDir,
  headless = true,
  port = null,
  url = "about:blank",
  binary = null,
  extraArgs = [],
  timeoutMs = 20000
} = {}) {
  const executable = findBrowserBinary({ preferred: binary });
  if (!executable) {
    throw new Error(
      "No Chromium based browser was found. Install Chrome or Edge, or set ASTACK_BROWSER_PATH to the executable."
    );
  }
  mkdirSync(userDataDir, { recursive: true });
  const debugPort = port ?? (await findFreePort());
  const args = [
    "--remote-debugging-port=" + debugPort,
    "--user-data-dir=" + userDataDir,
    ...LAUNCH_FLAGS,
    ...(headless ? ["--headless=new", "--disable-gpu", "--window-size=1440,1000"] : ["--window-size=1440,1000"]),
    ...extraArgs,
    url
  ];
  const child = spawn(executable, args, { detached: false, stdio: "ignore", windowsHide: headless });
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  try {
    const version = await waitForEndpoint(debugPort, { timeoutMs });
    return { child, port: debugPort, executable, version, headless, userDataDir };
  } catch (error) {
    if (!exited) {
      child.kill();
    }
    throw error;
  }
}

export { LAUNCH_FLAGS };
