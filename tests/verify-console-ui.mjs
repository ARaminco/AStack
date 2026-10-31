import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, extname, join, relative } from "node:path";
import vm from "node:vm";
import { createRuntime } from "../runtime/astack-runtime.mjs";
import { ConsoleServer, resolveBrand } from "../console/server.mjs";

// Aramis UI checks: the served shell, the vendored AraminConsole template,
// brand names, locale keys, the API paths the scripts call, the CSP rules
// (no inline style, no foreign origins), the service worker and the old
// aramin-* storage fallback. The optional last part drives a real browser
// through Playwright and is skipped, with a message, when none is installed.
//
// Everything runs against a temporary workspace and a temporary fake Claude
// home with stubbed accounts (*@example.test). No real login, token or
// transcript is read.

const repoRoot = process.cwd();
const PUBLIC = join(repoRoot, "console", "public");
const sandboxes = [];
const servers = [];
let checks = 0;

function sandbox(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  sandboxes.push(directory);
  return directory;
}
async function cleanup() {
  for (const server of servers) {
    await server.stop().catch(() => {});
  }
  for (const directory of sandboxes) {
    rmSync(directory, { recursive: true, force: true });
  }
}
function ok(condition, message) {
  checks += 1;
  assert.ok(condition, message);
}
function equal(actual, expected, message) {
  checks += 1;
  assert.equal(actual, expected, message);
}
/** Fail once with every offender listed, so one run shows everything to fix. */
function none(offenders, message) {
  checks += 1;
  assert.equal(offenders.length, 0, message + " (" + offenders.length + "):\n  " + offenders.join("\n  "));
}

function walk(directory, out = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(path, out);
    } else {
      out.push(path);
    }
  }
  return out;
}
const rel = (path) => relative(PUBLIC, path).replace(/\\/g, "/");
const read = (path) => readFileSync(path, "utf8");
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

const allFiles = walk(PUBLIC);
const textExt = new Set([".js", ".css", ".html", ".svg", ".webmanifest", ".txt", ".json", ""]);
const textFiles = allFiles.filter((file) => textExt.has(extname(file).toLowerCase()) || /LICENSE/.test(basename(file)));
const isVendor = (file) => rel(file).startsWith("vendor/");
// The UI's own code: app.js and everything under js/ plus the shell.
const uiScripts = allFiles.filter((file) => /\.js$/.test(file) && !isVendor(file) && !/^(sw|boot)\.js$/.test(rel(file)));
const uiMarkup = [...uiScripts, join(PUBLIC, "index.html")];

function call(base, path, { method = "GET", body, cookie, csrf, origin } = {}) {
  const headers = { accept: "*/*" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-csrf-token"] = csrf;
  if (origin) headers.origin = origin;
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const req = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json, bytes: buffer.length });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

let browserOutcome = "not run";

try {
  // ------------------------------------------------------------ server + login
  const workspace = sandbox("aramis-ui-ws-");
  cpSync(join(repoRoot, "context-engine", "lenses.json"), join(workspace, "context-engine", "lenses.json"));
  const claudeHome = sandbox("aramis-ui-home-");
  mkdirSync(join(claudeHome, "projects"), { recursive: true });
  // The accounts store defaults to ~/.astack/accounts: point it at the sandbox.
  process.env.ASTACK_ACCOUNTS_DIR = join(sandbox("aramis-ui-acc-"), "accounts");
  const runtime = createRuntime({ workspaceRoot: workspace });
  runtime.configuration.path = "";
  const server = new ConsoleServer({ runtime, port: 0, pollMs: 300, log: () => {}, claudeHome });
  const fakeAccounts = {
    active: { email: "a@example.test", plan: "max", profileId: "a-example-test" },
    accounts: [
      { id: "a-example-test", email: "a@example.test", label: "personal", savedAt: new Date().toISOString(), active: true },
      { id: "b-example-test", email: "b@example.test", label: "", savedAt: new Date().toISOString(), active: false }
    ],
    running: [], chatTurnsRunning: 0, platform: process.platform
  };
  server.accounts.list = async () => fakeAccounts;
  server.accounts.usage = async () => ({ fiveHour: { pct: 10, resetsAt: new Date(Date.now() + 3600000).toISOString() }, sevenDay: { pct: 20, resetsAt: new Date(Date.now() + 86400000).toISOString() } });
  servers.push(server);
  await server.start();
  const base = server.origin;
  const token = readFileSync(join(workspace, ".astack", "console", "token"), "utf8").trim();
  const login = await call(base, "/api/login", { method: "POST", body: { token }, origin: base });
  equal(login.status, 200, "the owner token signs in");
  const cookie = String(login.headers["set-cookie"]).split(";")[0];
  const csrf = login.json.csrf;
  const health = await call(base, "/api/health");
  const build = health.json.build;
  ok(build && build !== "__BUILD__", "the server reports a build stamp");

  // --------------------------------------------------------- served shell files
  const TYPES = {
    ".html": /^text\/html/,
    ".css": /^text\/css/,
    ".js": /^text\/javascript/,
    ".svg": /^image\/svg\+xml/,
    ".png": /^image\/png/,
    ".woff2": /^font\/woff2/,
    ".webmanifest": /^application\/manifest\+json/,
    ".txt": /^text\/plain/
  };
  const served = new Map();
  for (const file of allFiles) {
    const path = rel(file);
    const url = "/" + path;
    const response = await call(base, url);
    equal(response.status, 200, url + " is served");
    const type = TYPES[extname(file).toLowerCase()];
    if (type) {
      ok(type.test(response.headers["content-type"] ?? ""), url + " has the right content type, got " + response.headers["content-type"]);
    }
    ok(response.bytes > 0, url + " is not empty");
    ok(response.headers["x-content-type-options"] === "nosniff", url + " is sent with nosniff");
    served.set(path, response);
  }
  const home = await call(base, "/");
  equal(home.status, 200, "/ serves the shell");
  ok(/^text\/html/.test(home.headers["content-type"]), "/ is html");
  served.set("index.html", home);
  const csp = home.headers["content-security-policy"] ?? "";
  ok(/script-src 'self'(;|$)/.test(csp) && /style-src 'self'(;|$)/.test(csp) && !/unsafe-/.test(csp), "the CSP allows no inline script, no inline style and no foreign origin: " + csp);
  ok(!/__BUILD__/.test(home.text), "the build stamp is filled into the shell");
  // The asked-for shapes by name.
  for (const [path, type] of [["/app.js", /javascript/], ["/boot.js", /javascript/], ["/sw.js", /javascript/], ["/app.css", /css/], ["/manifest.webmanifest", /manifest\+json/],
    ["/vendor/aramin-console/aramin-console.min.css", /css/], ["/vendor/aramin-console/aramin-console.min.js", /javascript/], ["/vendor/aramin-console/icons.svg", /svg/],
    ["/vendor/aramin-console/fonts/vazirmatn-variable.woff2", /woff2/]]) {
    const response = await call(base, path);
    equal(response.status, 200, path + " is served");
    ok(type.test(response.headers["content-type"]), path + " content type " + response.headers["content-type"]);
  }
  for (const file of readdirSync(join(PUBLIC, "js")).filter((name) => name.endsWith(".js"))) {
    const response = await call(base, "/js/" + file);
    equal(response.status, 200, "/js/" + file + " is served");
    ok(/javascript/.test(response.headers["content-type"]), "/js/" + file + " is javascript");
  }
  const vendorDirectory = join(PUBLIC, "vendor", "aramin-console");
  ok(existsSync(join(vendorDirectory, "LICENSE")) && /MIT License/i.test(read(join(vendorDirectory, "LICENSE"))), "the vendored template ships its MIT LICENSE");
  const licenseResponse = await call(base, "/vendor/aramin-console/LICENSE");
  equal(licenseResponse.status, 200, "the LICENSE is served with the template");
  ok(/MIT License/i.test(licenseResponse.text), "the served LICENSE is the MIT text");
  none(["aramin-console.min.css", "aramin-console.min.js", "icons.svg", "fonts/vazirmatn-variable.woff2", "LICENSE"].filter((name) => !existsSync(join(vendorDirectory, name))), "vendored template files missing");

  // Every asset the shell links resolves.
  const linked = [...home.text.matchAll(/(?:src|href)="(\/[^"#]*)"/g)].map((match) => match[1].split("?")[0]).filter((path) => path !== "/");
  ok(linked.length >= 8, "the shell links its scripts, styles, icons and manifest (" + linked.length + ")");
  for (const path of linked) {
    equal((await call(base, path)).status, 200, "linked asset " + path + " exists");
  }
  ok(home.text.includes('data-ac-icons="/vendor/aramin-console/icons.svg"'), "the template icon sprite path is set on <html>");

  // ----------------------------------------------------------------- manifest
  const manifest = JSON.parse(served.get("manifest.webmanifest").text);
  equal(manifest.name, "Aramis", "the manifest is named Aramis");
  equal(manifest.short_name, "Aramis");
  equal(manifest.display, "standalone", "the app installs standalone");
  equal(manifest.dir, "rtl");
  equal(manifest.lang, "fa");
  for (const icon of manifest.icons) {
    equal((await call(base, icon.src)).status, 200, "manifest icon " + icon.src + " exists");
  }
  none(manifest.shortcuts.filter((entry) => !/^\/#\//.test(entry.url)).map((entry) => entry.url), "manifest shortcuts must point at hash routes");

  // -------------------------------------------------------------------- brand
  // The template keeps its own name; the product is Aramis / آرامیس.
  const stripAllowed = (text) => text
    .replace(/aramin-console/g, "")          // vendored template folder and file names
    .replace(/AraminConsole|Aramin Console/g, "") // the template's own name and licence text
    .replace(/\baramin-(theme|lang|[a-z]+)\b/g, ""); // old storage keys and cache prefix, read only as a fallback
  const brandOffenders = [];
  for (const file of textFiles) {
    const text = stripAllowed(read(file));
    let match;
    const pattern = /Aramin|آرامین/g;
    while ((match = pattern.exec(text))) {
      brandOffenders.push(rel(file) + ":" + lineOf(text, match.index) + " " + text.slice(Math.max(0, match.index - 20), match.index + 30).replace(/\s+/g, " "));
    }
  }
  none(brandOffenders, "the old product name Aramin / آرامین is still in the UI files (only the template name AraminConsole may stay)");
  ok(/<title>آرامیس<\/title>/.test(home.text), "the page title is آرامیس");
  ok(/apple-mobile-web-app-title" content="Aramis"/.test(home.text), "the home-screen title is Aramis");
  ok(home.text.includes("آرامیس") && home.text.includes("Aramis"), "both the Persian and the Latin brand are in the shell");
  ok(!/Aramin|آرامین/.test(stripAllowed(home.text)), "no old name in the served shell");
  const i18nFa = await call(base, "/api/i18n?lang=fa");
  const i18nEn = await call(base, "/api/i18n?lang=en");
  equal(i18nFa.status, 200);
  equal(i18nEn.status, 200);
  ok(!/Aramin|آرامین/.test(stripAllowed(JSON.stringify(i18nFa.json.strings))), "no old name in the Persian console strings");
  ok(!/Aramin|آرامین/.test(stripAllowed(JSON.stringify(i18nEn.json.strings))), "no old name in the English console strings");
  ok(/آرامیس/.test(JSON.stringify(i18nFa.json.strings)) && /Aramis/.test(JSON.stringify(i18nEn.json.strings)), "the locale bundles carry the new name");
  // A console.brand rename keeps working on the served shell.
  const branded = new ConsoleServer({ runtime, port: 0, pollMs: 300, log: () => {}, claudeHome, brand: resolveBrand({ name: "Gisoo", name_fa: "گیسو" }) });
  servers.push(branded);
  await branded.start();
  const brandedShell = await call(branded.origin, "/");
  ok(/<title>گیسو<\/title>/.test(brandedShell.text) && !/Aramis|آرامیس/.test(brandedShell.text.replace(/aramis-[a-z-]+/g, "")), "console.brand replaces the base name in the shell");
  ok(JSON.parse((await call(branded.origin, "/manifest.webmanifest")).text).name === "Gisoo", "console.brand replaces the base name in the manifest");

  // ------------------------------------------------------------- locale keys
  const faJson = JSON.parse(read(join(repoRoot, "locales", "fa.json")));
  const enJson = JSON.parse(read(join(repoRoot, "locales", "en.json")));
  const faStrings = faJson.console;
  const enStrings = enJson.console;
  const lookup = (strings, key) => key.split(".").reduce((node, part) => (node && typeof node === "object" ? node[part] : undefined), strings);
  const keySources = new Map(); // key -> Set(file)
  const addKey = (key, file) => {
    if (!keySources.has(key)) keySources.set(key, new Set());
    keySources.get(key).add(file);
  };
  const dynamicPrefixes = new Map(); // "nav." -> Set(file)
  for (const file of uiMarkup) {
    const text = read(file);
    for (const match of text.matchAll(/\bt\(\s*["']([a-zA-Z0-9_.\-]+)["']\s*([,)+])/g)) {
      if (match[1].endsWith(".") && match[2] === "+") {
        if (!dynamicPrefixes.has(match[1])) dynamicPrefixes.set(match[1], new Set());
        dynamicPrefixes.get(match[1]).add(basename(file));
      } else {
        addKey(match[1], basename(file));
      }
    }
    for (const match of text.matchAll(/data-i18n(?:-[a-z]+)?="([^"]+)"/g)) {
      addKey(match[1], basename(file));
    }
  }
  // Dynamic ids, derived from the code itself where it lists them.
  const appSource = read(join(PUBLIC, "app.js"));
  const navBlock = appSource.slice(appSource.indexOf("var NAV = ["), appSource.indexOf("var BASE_TABS"));
  const navIds = new Set([...navBlock.matchAll(/\bid:\s*"([a-z]+)"/g), ...navBlock.matchAll(/\bgroup:\s*"([A-Za-z]+)"/g)].map((match) => match[1]));
  const tabsBlock = appSource.slice(appSource.indexOf("var BASE_TABS"), appSource.indexOf("var TABS ="));
  for (const match of tabsBlock.matchAll(/\bid:\s*"([a-z]+)"/g)) navIds.add(match[1]);
  const moreIds = new Set();
  for (const match of appSource.matchAll(/(?:BASE_MORE|MORE_PAGES)\s*=\s*\[([^\]]*)\]/g)) {
    for (const id of match[1].matchAll(/"([a-z]+)"/g)) moreIds.add(id[1]);
  }
  ok(navIds.size >= 12 && moreIds.size >= 8, "the nav and more-page ids are readable from app.js (" + navIds.size + "/" + moreIds.size + ")");
  for (const id of navIds) addKey("nav." + id, "app.js (nav)");
  for (const id of moreIds) {
    addKey("nav." + id, "app.js (more)");
    addKey("more." + id, "app.js (more)");
  }
  const paletteGroups = new Set([...appSource.matchAll(/\{\s*group:\s*"([a-z]+)",\s*icon:/g)].map((match) => match[1]));
  ok(paletteGroups.size >= 5, "the palette groups are readable from app.js (" + paletteGroups.size + ")");
  for (const group of paletteGroups) addKey("palette." + group, "app.js (palette)");
  for (const risk of ["high", "medium", "low"]) addKey("risk." + risk, "app.js (risk)");
  for (const operation of ["pause", "resume", "cancel"]) {
    addKey("missions." + operation, "app.js (missions)");
    for (const suffix of ["Title", "Body", "Done"]) addKey("missions." + operation + suffix, "app.js (missions)");
  }
  for (const kind of ["approval", "mission", "incident", "run"]) addKey("notify." + kind, "app.js (notify)");
  for (const sort of ["updated", "started", "turns"]) addKey("ui.projects.sort." + sort, "projects.js (sort)");
  for (const id of ["projects", "claudeMemory", "memory", "phoneTitles", "accounts"]) addKey("ui.sync.step." + id, "sync.js (steps)");
  for (const reason of ["disabled", "no-interop"]) addKey("ui.sync.skipped." + reason, "sync.js (skipped)");
  // Every dynamic prefix is accounted for above, so none can hide a missing key.
  for (const key of Object.keys(faStrings.login)) addKey("login." + key, "login.js (template)");
  const covered = ["login.","nav.", "more.", "palette.", "risk.", "missions.", "notify.", "ui.projects.sort.", "ui.sync.step.", "ui.sync.skipped."];
  none([...dynamicPrefixes.keys()].filter((prefix) => !covered.includes(prefix)).map((prefix) => prefix + " in " + [...dynamicPrefixes.get(prefix)].join(",")), "dynamic t(\"prefix.\" + x) keys the test does not know how to enumerate");
  ok(keySources.size >= 300, "the scan found the UI's keys (" + keySources.size + ")");
  none([...keySources].filter(([key]) => typeof lookup(faStrings, key) !== "string").map(([key, files]) => "fa  " + key + "  [" + [...files].join(",") + "]"), "locale keys missing from locales/fa.json (console.*)");
  none([...keySources].filter(([key]) => typeof lookup(enStrings, key) !== "string").map(([key, files]) => "en  " + key + "  [" + [...files].join(",") + "]"), "locale keys missing from locales/en.json (console.*)");
  // The served bundles are what the browser really gets.
  none([...keySources].filter(([key]) => typeof lookup(i18nFa.json.strings, key) !== "string" || typeof lookup(i18nEn.json.strings, key) !== "string").map(([key]) => key), "keys missing from the served /api/i18n bundles");
  // Untranslated: an English string shipped as the Persian value.
  const sameText = [];
  const leaves = (node, prefix = "") => Object.entries(node).flatMap(([key, value]) => (value && typeof value === "object" ? leaves(value, prefix + key + ".") : [[prefix + key, value]]));
  for (const [key, value] of leaves(faStrings)) {
    if (!key.startsWith("ui.") || typeof value !== "string") continue;
    const english = lookup(enStrings, key);
    if (typeof english === "string" && english === value && /[A-Za-z]{4,}/.test(value) && !/[؀-ۿ]/.test(value) && !/^(Claude|Aramis|AStack|[A-Za-z0-9 ._\-/]{1,12})$/.test(value)) {
      sameText.push(key + " = " + JSON.stringify(value));
    }
  }
  none(sameText, "console.ui.* strings that are identical English text in fa.json (untranslated)");
  // Both languages keep the same key set under console.ui, console.accounts and console.projects (the new screens).
  const keysOf = (node, name) => (node[name] ? leaves(node[name], name + ".").map(([key]) => key).sort() : []);
  for (const group of ["ui", "accounts", "projects"]) {
    const fa = keysOf(faStrings, group);
    const en = keysOf(enStrings, group);
    none(fa.filter((key) => !en.includes(key)).map((key) => "only fa: " + key).concat(en.filter((key) => !fa.includes(key)).map((key) => "only en: " + key)), "console." + group + ".* differs between fa.json and en.json");
  }

  // ------------------------------------------------------------ API paths
  const serverSource = read(join(repoRoot, "console", "server.mjs"));
  // /api/users/* is routed by console/users-admin.mjs, so its segments count as handled too
  const apiSource = read(join(repoRoot, "console", "api.mjs")) + read(join(repoRoot, "console", "users-admin.mjs"));
  const slice = (start, end) => {
    const from = serverSource.indexOf(start);
    const to = serverSource.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, "server.mjs layout changed: cannot find " + start);
    return serverSource.slice(from, to);
  };
  const routeBody = slice("  async route(", "  writeRecord()");
  const projectsBody = slice("  async projectsRoute(", "  async accountsRoute(");
  const accountsBody = slice("  async accountsRoute(", "  async route(");
  const publicEndpoints = new Set([...serverSource.matchAll(/pathname === "(\/api\/[a-z0-9-]+)"/g)].map((match) => match[1].slice(5)));
  const resources = new Set([...routeBody.matchAll(/resource === "([a-z0-9-]+)"/g)].map((match) => match[1]));
  for (const match of routeBody.matchAll(/case "([a-z0-9-]+)":/g)) resources.add(match[1]);
  const literals = new Set([...routeBody.matchAll(/"([a-z0-9-]+)"/g), ...projectsBody.matchAll(/"([a-z0-9-]+)"/g), ...accountsBody.matchAll(/"([a-z0-9-]+)"/g)].map((match) => match[1]));
  for (const need of ["health", "i18n", "session", "login", "events", "logout", "logout-all"]) {
    ok(publicEndpoints.has(need), "server.mjs still handles the public /api/" + need);
  }
  ok(["home", "approvals", "missions", "runs", "jobs", "audit", "memory", "skills", "board", "gateway", "system", "search", "chats", "accounts", "projects", "notifications", "hooks", "counts"].every((name) => resources.has(name)), "the resource list read from server.mjs is complete: " + [...resources].join(","));

  /** Turn `"/api/x/" + id + "/y"` into segments, with \0 where the code splices a value. */
  function apiCalls(source, file) {
    const calls = [];
    const start = /(["'])(\/api\/[^"'\\\n]*)\1/g;
    let match;
    while ((match = start.exec(source))) {
      let path = match[2];
      let position = start.lastIndex;
      for (;;) {
        const plus = /^\s*\+\s*/.exec(source.slice(position));
        if (!plus) break;
        position += plus[0].length;
        const literal = /^(["'])([^"'\\\n]*)\1/.exec(source.slice(position));
        if (literal) {
          path += literal[2];
          position += literal[0].length;
          continue;
        }
        let depth = 0;
        let index = position;
        for (; index < source.length; index += 1) {
          const char = source[index];
          if (char === "(" || char === "[") depth += 1;
          else if (char === ")" || char === "]") {
            if (depth === 0) break;
            depth -= 1;
          } else if (depth === 0 && (char === "," || char === "+" || char === ";" || char === "\n")) break;
        }
        path += "\0";
        position = index;
      }
      const around = source.slice(Math.max(0, match.index - 12), match.index) + source.slice(position, position + 200);
      const method = /write\($/.test(source.slice(Math.max(0, match.index - 8), match.index)) || /method:\s*"POST"/.test(source.slice(position, position + 200)) ? "POST" : "GET";
      calls.push({ file: basename(file), line: lineOf(source, match.index), path, method, around });
    }
    return calls;
  }
  const calls = uiScripts.flatMap((file) => apiCalls(read(file), file));
  ok(calls.length >= 40, "the scan found the UI's API calls (" + calls.length + ")");
  // Dynamic action segments (an operation name chosen in code) must be listed.
  const DYNAMIC_ACTIONS = { missions: ["pause", "resume", "cancel"] };
  const unknownApi = [];
  const patterns = new Map();
  for (const entry of calls) {
    let pathOnly = entry.path.slice(5);
    const cut = pathOnly.search(/\?/);
    if (cut >= 0) pathOnly = pathOnly.slice(0, cut);
    const segments = [];
    for (const raw of pathOnly.split("/")) {
      if (raw === "") continue;
      if (raw.includes("\0") && raw.replace(/\0/g, "") !== "") {
        // literal followed by a spliced query string, e.g. "skills" + (params ? "?x" : "")
        segments.push(raw.slice(0, raw.indexOf("\0")));
        break;
      }
      segments.push(raw.includes("\0") ? "{}" : raw);
    }
    entry.segments = segments;
    patterns.set("/api/" + segments.join("/"), entry);
    const [resource, ...rest] = segments;
    const where = entry.file + ":" + entry.line + " " + entry.method + " " + entry.path.replace(/\0/g, "{}");
    if (!resource || resource === "{}") {
      unknownApi.push(where + "  (no resource)");
      continue;
    }
    if (!publicEndpoints.has(resource) && !resources.has(resource)) {
      unknownApi.push(where + "  (server.mjs has no handler for /api/" + resource + ")");
      continue;
    }
    rest.forEach((segment, index) => {
      if (segment === "{}") {
        if (index >= 1) {
          if (!DYNAMIC_ACTIONS[resource]) unknownApi.push(where + "  (computed action segment not in the test's allow-list)");
          else if (!DYNAMIC_ACTIONS[resource].every((name) => literals.has(name))) unknownApi.push(where + "  (server.mjs does not handle " + DYNAMIC_ACTIONS[resource].join("/") + ")");
        }
      } else if (!literals.has(segment) && !apiSource.includes('"' + segment + '"')) {
        unknownApi.push(where + "  (server.mjs has no handler for the segment \"" + segment + "\")");
      }
    });
    if (resource === "accounts" || resource === "projects") {
      const body = resource === "accounts" ? accountsBody : projectsBody;
      for (const segment of rest.filter((value) => value !== "{}")) {
        if (!body.includes('"' + segment + '"')) unknownApi.push(where + "  (" + resource + "Route() has no \"" + segment + "\")");
      }
    }
  }
  none(unknownApi, "API paths the UI calls that the server does not handle");
  for (const required of ["/api/accounts", "/api/accounts/switch", "/api/accounts/save", "/api/accounts/remove", "/api/accounts/label", "/api/accounts/usage", "/api/projects", "/api/projects/sessions", "/api/projects/session", "/api/projects/session/meta", "/api/projects/session/rename", "/api/projects/meta", "/api/approvals/{}/decide", "/api/missions/{}/{}", "/api/jobs/{}/run", "/api/chats/{}/messages", "/api/chats/{}/stop", "/api/events", "/api/notifications"]) {
    ok(patterns.has(required), "the UI uses " + required);
  }
  // Live: every plain collection path the UI reads is really routed (404 means unrouted).
  const probed = new Set();
  const unrouted = [];
  for (const entry of calls) {
    const plain = "/api/" + entry.segments.filter((segment) => segment !== "{}").join("/");
    if (entry.method !== "GET" || entry.segments.includes("{}") || probed.has(plain) || ["events", "logout", "logout-all", "login"].includes(entry.segments[0])) continue;
    probed.add(plain);
    const response = await call(base, plain + (entry.segments[0] === "i18n" ? "?lang=fa" : ""), { cookie, csrf });
    const chatsOff = entry.segments[0] === "chats" && response.status === 404 && /turned off/.test(response.text);
    if ((response.status === 404 && !chatsOff) || response.status >= 500) unrouted.push("GET " + plain + " -> " + response.status + " " + response.text.slice(0, 80));
  }
  ok(probed.size >= 15, "live-probed the UI's read endpoints (" + probed.size + ")");
  none(unrouted, "UI read endpoints that answer 404/5xx on a live server");

  // ------------------------------------------------------- external origins
  const SCHEMA_HOSTS = new Set(["www.w3.org"]);
  const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  // Attribution links in the vendored template's own banners and licence; never fetched.
  const VENDOR_ATTRIBUTION = new Set(["github.com/ARaminco/AraminConsole", "lucide.dev", "github.com/rastikerdar/vazirmatn"]);
  const foreign = [];
  // Licence and readme texts only name where fonts and icons came from; they are never loaded.
  for (const file of textFiles.filter((name) => /\.(?:html|js|css|svg|webmanifest)$/.test(name))) {
    const text = read(file);
    for (const match of text.matchAll(/\b(?:https?|wss?):\/\/([^\s"'`)<>\\,;]+)/g)) {
      const host = match[1].split(/[/:?#]/)[0];
      if (LOCAL_HOSTS.has(host) || SCHEMA_HOSTS.has(host)) continue;
      if (isVendor(file) && [...VENDOR_ATTRIBUTION].some((allowed) => match[1].startsWith(allowed))) continue;
      foreign.push(rel(file) + ":" + lineOf(text, match.index) + " " + match[0]);
    }
    for (const match of text.matchAll(/(?:\bsrc|\bhref|action)\s*=\s*["']\/\/[^"']+/g)) foreign.push(rel(file) + ":" + lineOf(text, match.index) + " protocol-relative " + match[0]);
    for (const match of text.matchAll(/@import\s+(?:url\()?["']?(?:https?:)?\/\//g)) foreign.push(rel(file) + ":" + lineOf(text, match.index) + " @import from another origin");
    for (const match of text.matchAll(/url\(\s*["']?(?:https?:)?\/\/[^)]+\)/g)) foreign.push(rel(file) + ":" + lineOf(text, match.index) + " " + match[0]);
  }
  none(foreign, "references to external origins in the served UI");
  // The same on the bytes the server really sends.
  none([...served].filter(([path, response]) => /\.(?:html|js|css|webmanifest)$/.test(path) && !path.startsWith("vendor/") && /\bhttps?:\/\/(?!www\.w3\.org|localhost|127\.0\.0\.1)/.test(response.text)).map(([path]) => path), "served files that mention a foreign origin");

  // ------------------------------------------------------------ CSP: inline
  const inline = [];
  for (const file of uiMarkup.concat(join(PUBLIC, "sw.js"), join(PUBLIC, "boot.js"))) {
    const text = read(file);
    const label = rel(file);
    for (const match of text.matchAll(/\bstyle\s*=\s*(?=["'`$\\])/g)) {
      // JavaScript assignment `el.style = "..."` has spaces and a preceding dot; attributes sit inside markup.
      const before = text.slice(Math.max(0, match.index - 1), match.index);
      if (before === ".") continue;
      inline.push(label + ":" + lineOf(text, match.index) + "  style=\"…\" attribute: " + text.slice(match.index, match.index + 50).replace(/\s+/g, " "));
    }
    for (const match of text.matchAll(/setAttribute\(\s*["']style["']/g)) inline.push(label + ":" + lineOf(text, match.index) + "  setAttribute(\"style\") is blocked by the CSP");
    for (const match of text.matchAll(/<style[\s>]/gi)) inline.push(label + ":" + lineOf(text, match.index) + "  inline <style> element");
    for (const match of text.matchAll(/<[a-zA-Z][^<>]*?\son(?:click|change|input|submit|load|error|keydown|keyup|focus|blur|mouse[a-z]+|touch[a-z]+)\s*=/g)) {
      inline.push(label + ":" + lineOf(text, match.index) + "  inline event handler attribute: " + match[0].slice(-30));
    }
    for (const match of text.matchAll(/(?:href|src)\s*=\s*["']javascript:/gi)) inline.push(label + ":" + lineOf(text, match.index) + "  javascript: URL");
    if (label === "index.html") {
      for (const match of text.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)) inline.push(label + ":" + lineOf(text, match.index) + "  inline <script>");
    }
  }
  none(inline, "inline style / script that the CSP blocks");

  // ------------------------------------------------------- service worker
  const swText = served.get("sw.js").text;
  ok(!/__BUILD__/.test(swText), "the service worker has the build stamped in");
  ok(swText.includes('const BUILD = "' + build + '"'), "the service worker carries the server's build");
  ok(/"aramis-shell-"\s*\+\s*BUILD/.test(swText), "the cache is named aramis-shell-<build>");
  equal(served.get("sw.js").headers["service-worker-allowed"], "/", "the worker may control the whole app");
  // Every shell file the worker pre-caches is really served.
  const shellList = [...swText.slice(swText.indexOf("const SHELL"), swText.indexOf("];", swText.indexOf("const SHELL"))).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  ok(shellList.length >= 10, "the worker pre-caches the shell (" + shellList.length + ")");
  for (const path of shellList) {
    equal((await call(base, path)).status, 200, "pre-cached " + path + " is served");
  }
  for (const path of ["/app.css", "/app.js", "/boot.js", "/js/accounts.js", "/js/projects.js", "/js/keys.js", "/vendor/aramin-console/aramin-console.min.css", "/vendor/aramin-console/aramin-console.min.js", "/vendor/aramin-console/icons.svg"]) {
    ok(shellList.some((entry) => entry.split("?")[0] === path), "the worker pre-caches " + path);
  }
  // Run the worker against a fake Cache API: install fills this build's cache, activate drops the old ones.
  {
    const listeners = {};
    const stores = new Map([["aramin-shell-old", new Set()], ["aramis-shell-old", new Set()], ["aramin-anything", new Set()], ["unrelated-cache", new Set()]]);
    const caches = {
      async open(name) {
        if (!stores.has(name)) stores.set(name, new Set());
        return { addAll: async (urls) => urls.forEach((url) => stores.get(name).add(url)) };
      },
      async keys() { return [...stores.keys()]; },
      async delete(name) { return stores.delete(name); },
      async match() { return undefined; }
    };
    const self = { addEventListener: (type, handler) => { listeners[type] = handler; }, skipWaiting: async () => {}, clients: { claim: async () => {}, matchAll: async () => [] }, location: { origin: base } };
    vm.runInNewContext(swText, { self, caches, URL, fetch: async () => ({}), Promise, console });
    ok(listeners.install && listeners.activate && listeners.fetch && listeners.notificationclick, "the worker registers install, activate, fetch and notificationclick");
    let pending;
    listeners.install({ waitUntil: (promise) => { pending = promise; } });
    await pending;
    equal(stores.get("aramis-shell-" + build)?.size, new Set(shellList).size, "install fills aramis-shell-<build> with the whole shell");
    listeners.activate({ waitUntil: (promise) => { pending = promise; } });
    await pending;
    ok(stores.has("aramis-shell-" + build), "activate keeps this build's cache");
    none(["aramin-shell-old", "aramis-shell-old", "aramin-anything"].filter((name) => stores.has(name)), "old caches the worker should delete");
    ok(stores.has("unrelated-cache"), "activate leaves caches that are not ours alone");
  }

  // ------------------------------------------------- old aramin-* keys fallback
  {
    const runBoot = (storage, { dark = false } = {}) => {
      const attributes = {};
      const root = { setAttribute: (name, value) => { attributes[name] = value; } };
      const localStorage = {
        getItem: (key) => (key in storage ? storage[key] : null),
        setItem: (key, value) => { storage[key] = String(value); }
      };
      const window = { matchMedia: () => ({ matches: dark }), navigator: {} };
      vm.runInNewContext(read(join(PUBLIC, "boot.js")), { document: { documentElement: root, getElementById: () => null }, window, localStorage });
      return attributes;
    };
    let storage = { "aramin-theme": "dark", "aramin-lang": "en" };
    let attributes = runBoot(storage);
    equal(attributes["data-theme"], "dark", "boot.js falls back to the old aramin-theme key");
    equal(attributes.lang, "en", "boot.js falls back to the old aramin-lang key");
    equal(attributes.dir, "ltr");
    equal(storage["aramis-theme"], "dark", "the old theme is copied to aramis-theme");
    equal(storage["aramis-lang"], "en", "the old language is copied to aramis-lang");
    storage = { "aramis-theme": "light", "aramin-theme": "dark" };
    attributes = runBoot(storage);
    equal(attributes["data-theme"], "light", "the new aramis-theme key wins over the old one");
    attributes = runBoot({}, { dark: true });
    equal(attributes["data-theme"], "dark", "with nothing stored, the system theme decides");
    ok(!("lang" in attributes) || attributes.lang !== "en", "Persian stays the default language");
    // app.js reads the same fallback.
    ok(/getItem\(key\.replace\(\/\^aramis-\/, "aramin-"\)\)/.test(appSource), "app.js reads the old aramin-* key as a fallback");
    ok(/["']aramis-theme["']/.test(appSource) && /["']aramis-lang["']/.test(appSource), "app.js stores aramis-theme and aramis-lang");
    none(["theme", "lang"].filter((name) => /setItem\(\s*["']aramin-/.test(appSource + read(join(PUBLIC, "boot.js"))) ), "the UI writes an old aramin-* key");
  }

  // --------------------------------------------------- optional: real browser
  async function loadPlaywright() {
    const candidates = [process.env.ARAMIS_PLAYWRIGHT_DIR, repoRoot, "C:/Projects/AraminConsole"].filter(Boolean);
    for (const directory of candidates) {
      for (const name of ["playwright-core", "playwright"]) {
        try {
          return createRequire(join(directory, "package.json"))(name);
        } catch {
          // try the next one
        }
      }
    }
    return null;
  }
  const playwright = await loadPlaywright();
  let browser = null;
  if (!playwright) {
    browserOutcome = "skipped: Playwright is not installed (set ARAMIS_PLAYWRIGHT_DIR to a folder whose node_modules has playwright-core)";
  } else {
    const attempts = [{ channel: "chrome" }, process.env.ARAMIS_CHROME ? { executablePath: process.env.ARAMIS_CHROME } : null, {}].filter(Boolean);
    for (const options of attempts) {
      try {
        browser = await playwright.chromium.launch(options);
        break;
      } catch {
        browser = null;
      }
    }
    if (!browser) browserOutcome = "skipped: no Chrome/Chromium could be launched (set ARAMIS_CHROME to a browser executable)";
  }
  if (browser) {
    try {
      const { verifyLogin } = await import("./console-login-browser.mjs");
      checks += await verifyLogin(browser, base, token);
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "fa-IR" });
      const response = await context.request.post(base + "/api/login", { data: { token }, headers: { origin: base } });
      equal(response.ok(), true, "the browser signs in");
      const page = await context.newPage();
      const problems = [];
      page.on("console", (message) => { if (["error", "warning"].includes(message.type())) problems.push(message.type() + ": " + message.text()); });
      page.on("pageerror", (error) => problems.push("pageerror: " + error.message));
      page.on("requestfailed", (request) => { if (!/\/api\/events/.test(request.url()) && !/ERR_ABORTED/.test(request.failure()?.errorText ?? "")) problems.push("request failed: " + request.url()); });
      await page.addInitScript(() => {
        window.__csp = [];
        document.addEventListener("securitypolicyviolation", (event) => window.__csp.push(event.violatedDirective + " " + event.blockedURI + " " + (event.sourceFile || "") + ":" + event.lineNumber));
      });
      const routes = ["home", "approvals", "missions", "memory", "projects", "accounts", "more", "runs", "jobs", "audit", "skills", "board", "gateway", "system", "settings"];
      for (const route of routes) {
        problems.length = 0;
        await page.goto(base + "/#/" + route);
        await page.waitForSelector("#ar-app, main, [data-view]", { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(700);
        const violations = await page.evaluate(() => window.__csp.slice());
        none(problems.map((line) => route + ": " + line).concat(violations.map((line) => route + ": CSP violation " + line)), "browser console errors, warnings or CSP violations");
        const bodyText = await page.evaluate(() => document.body.innerText.trim().length);
        ok(bodyText > 20, "#/" + route + " renders something");
      }
      // Ctrl+K opens exactly one palette.
      await page.goto(base + "/#/home");
      await page.waitForTimeout(700);
      const visiblePalettes = () => page.evaluate(() => [...document.querySelectorAll(".palette, .ac-palette")].filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0;
      }).length);
      equal(await visiblePalettes(), 0, "no palette is open before Ctrl+K");
      await page.keyboard.press("Control+K");
      await page.waitForTimeout(600);
      equal(await visiblePalettes(), 1, "Ctrl+K opens exactly one palette");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
      equal(await visiblePalettes(), 0, "Escape closes the palette");
      await context.close();
      browserOutcome = "ran " + routes.length + " screens in " + (browser.version?.() ?? "browser");
    } finally {
      await browser.close().catch(() => {});
    }
  }

  console.log("AStack console UI verified (" + checks + " checks; browser smoke " + browserOutcome + ")");
} catch (error) {
  console.error(error.stack ?? error);
  process.exitCode = 1;
} finally {
  await cleanup();
}
