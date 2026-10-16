import { createHash } from "node:crypto";

/**
 * The rules the project's browser proxy enforces on every Playwright MCP call,
 * whatever the runtime's own permission mode (bypass included):
 *
 * - addresses: only http, https and about pages (a `javascript:` or `data:`
 *   address would run code inside the signed-in site);
 * - files: a `filename` is a bare name inside the browser's output folder,
 *   never a path, so no tool can overwrite a project file;
 * - code: tools that run arbitrary code in the page are off unless allowed;
 * - targets: an acting tool names its element by a ref seen in a snapshot of
 *   the current page (`e12`), never by a CSS or text selector, so the gate
 *   always knows what the element really says;
 * - passwords: the agent never types into a password, PIN or one-time-code
 *   field; the owner types those in the window;
 * - keys: only navigation keys and single characters pass; Enter, Space and
 *   shortcuts are commits;
 * - commits: a click, key, submit, upload, drop or accepted dialog that
 *   commits (submit, pay, send, delete, publish, … or a POST form's submit
 *   button) needs an owner approval, one receipt per call on that page.
 *
 * Playwright MCP 0.0.83 names an element `target` (`startTarget`,
 * `endTarget`, `fields[].target`); `ref` is read too, for older and newer
 * versions. A test checks the tool schema so an upgrade cannot silently
 * switch the reading off.
 */

export const CODE_TOOLS = new Set(["browser_evaluate", "browser_run_code_unsafe", "browser_run_code"]);
export const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "about:"]);
export const TARGET_KEYS = ["target", "ref", "startTarget", "endTarget", "startRef", "endRef"];

const COMMIT_WORDS = /\b(submit|pay|payment|checkout|purchase|buy|order|place order|confirm|send|delete|remove|destroy|publish|post|transfer|wire|sign|approve|accept|finali[sz]e|file it|apply|trash|bin|archive|cancel|unsubscribe|deactivate|close account)\b|ثبت|پرداخت|ارسال|بفرست|حذف|تایید|تأیید|انتشار|منتشر|واریز|انتقال|امضا|خرید|سفارش|نهایی|سطل|لغو|إرسال|دفع|تأكيد|نشر|سلة/i;
export const SECRET_FIELDS = /\b(password|passcode|passwd|pass phrase|passphrase|pin|otp|one[- ]time|2fa|mfa|verification code|security code|auth(entication)? code|cvv|cvc|card number|passwort|kennwort|mot de passe|contraseña|contrasena|senha|şifre|sifre|пароль|код)\b|رمز|گذرواژه|پسورد|کد تایید|کد تأیید|کد یکبار|کلمه عبور|كلمة المرور|رمز التحقق|كلمة السر/i;
export const ACTING_TOOLS = new Set(["browser_click", "browser_type", "browser_fill_form", "browser_select_option", "browser_press_key", "browser_drag", "browser_drop", "browser_hover"]);
const REF_TOOLS = new Set(["browser_click", "browser_type", "browser_fill_form", "browser_select_option", "browser_drag", "browser_drop", "browser_hover"]);
const COORDINATE_TOOLS = new Set(["browser_mouse_click_xy", "browser_mouse_drag_xy", "browser_mouse_down", "browser_mouse_up"]);
const SAFE_KEYS = new Set(["tab", "shift+tab", "arrowup", "arrowdown", "arrowleft", "arrowright", "escape", "home", "end", "pageup", "pagedown", "backspace"]);
const REF_SHAPE = /^(f\d+)?e\d+$/;

/** Every element target of a call: ref-shaped or not. */
export function callTargets(args = {}) {
  const values = TARGET_KEYS.map((key) => args[key]);
  for (const field of Array.isArray(args.fields) ? args.fields : []) {
    values.push(field?.target, field?.ref);
  }
  return values.filter((value) => typeof value === "string" && value);
}

/** The refs among the targets (kept for older callers). */
export function targetRefs(args = {}) {
  return callTargets(args).filter((value) => REF_SHAPE.test(value));
}

/**
 * Lines of a Playwright snapshot by ref ("- button \"Pay now\" [ref=e12]"),
 * so the gate can read what an element really says.
 */
export function indexSnapshotRefs(text, into = new Map()) {
  for (const match of String(text ?? "").matchAll(/^[^\n]*\[ref=([A-Za-z0-9_-]+)\][^\n]*$/gm)) {
    into.set(match[1], match[0].trim().slice(0, 300));
  }
  while (into.size > 4000) {
    into.delete(into.keys().next().value);
  }
  return into;
}

/** The accessible name inside a snapshot line: button "Pay now" → Pay now. */
export function snapshotName(line) {
  return /"((?:[^"\\]|\\.)*)"/.exec(String(line ?? ""))?.[1] ?? "";
}

/** An acting tool must name its element by a ref the proxy has seen. */
export function targetProblem(tool, args = {}, known = new Map()) {
  if (!REF_TOOLS.has(tool)) {
    return null;
  }
  const targets = callTargets(args);
  if (!targets.length) {
    return "Refused: name the element by its ref from a browser_snapshot of this page (for example target \"e12\").";
  }
  const bad = targets.find((value) => !REF_SHAPE.test(value) || !known.has(value));
  return bad
    ? "Refused: " + JSON.stringify(bad.slice(0, 60)) + " is not a ref from a snapshot of the current page. Take a browser_snapshot and use its ref (for example \"e12\"); CSS and text selectors are not accepted."
    : null;
}

function strings(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((entry) => strings(entry, out));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((entry) => strings(entry, out));
  }
  return out;
}

/** Every `url` in the arguments must be an http, https or about address. */
export function urlProblem(args = {}) {
  const urls = [];
  const walk = (value, key = "") => {
    if (typeof value === "string" && /url$/i.test(key)) {
      urls.push(value);
    } else if (value && typeof value === "object") {
      Object.entries(value).forEach(([childKey, child]) => walk(child, childKey));
    }
  };
  walk(args);
  for (const value of urls) {
    let protocol = null;
    try {
      protocol = new URL(value.trim()).protocol;
    } catch {
      return "Refused: " + JSON.stringify(value.slice(0, 80)) + " is not a full http(s) address.";
    }
    if (!ALLOWED_PROTOCOLS.has(protocol)) {
      return "Refused: " + protocol + " addresses run code or read local files; only http, https and about pages are opened.";
    }
  }
  return null;
}

/** A filename is a bare name, written inside the browser's output folder. */
export function filenameProblem(args = {}) {
  const names = [];
  const walk = (value, key = "") => {
    if (typeof value === "string" && /^(filename|path|outputPath)$/i.test(key)) {
      names.push(value);
    } else if (value && typeof value === "object") {
      Object.entries(value).forEach(([childKey, child]) => walk(child, childKey));
    }
  };
  walk(args);
  for (const name of names) {
    if (/[\\/]|\.\.|^[a-z]:/i.test(name) || name.startsWith(".")) {
      return "Refused: files are written only as a bare name inside the browser's output folder (" + JSON.stringify(name.slice(0, 80)) + " is a path).";
    }
  }
  return null;
}

const SECRET_REFUSAL = "Refused: passwords, PINs and one-time codes are typed by the owner in the project's browser window, never by an agent.";

/**
 * Typing into a secret field is the owner's job. The words are checked on the
 * agent's description, the field names and the page's own text for the
 * target; the proxy also asks the page itself (input type and autocomplete).
 */
export function secretFieldProblem(tool, args = {}, pageText = "") {
  if (!["browser_type", "browser_fill_form"].includes(tool)) {
    return null;
  }
  const described = tool === "browser_fill_form"
    ? (Array.isArray(args.fields) ? args.fields : []).map((field) => [field?.name, field?.element, field?.type].filter(Boolean).join(" "))
    : [String(args.element ?? "")];
  return [...described, String(pageText ?? "")].some((target) => SECRET_FIELDS.test(target)) ? SECRET_REFUSAL : null;
}

export { SECRET_REFUSAL };

/** A key that cannot commit anything on its own. */
export function safeKey(key) {
  const value = String(key ?? "");
  if (SAFE_KEYS.has(value.toLowerCase())) {
    return true;
  }
  // One printable character, not a space (Space presses buttons).
  return [...value].length === 1 && value !== " " && !/[\r\n\t]/.test(value);
}

/**
 * What a commit-like call would commit, or null. Uploads, drops and accepted
 * dialogs always count; keys other than navigation keys and characters count;
 * typed text with a line break counts as a submit. `probe` is what the page
 * itself reported (a POST form's submit button).
 */
export function commitTarget(tool, args = {}, pageText = "", probe = {}) {
  if (tool === "browser_file_upload" && Array.isArray(args.paths) && args.paths.length) {
    return "upload " + args.paths.length + " file(s): " + args.paths.map((path) => String(path).split(/[\\/]/).pop()).join(", ");
  }
  if (tool === "browser_drop" && ((Array.isArray(args.paths) && args.paths.length) || args.data !== undefined)) {
    return "drop " + (args.paths?.length ? args.paths.length + " file(s)" : "data") + " onto «" + (snapshotName(pageText) || pageText || "an element").slice(0, 120) + "»";
  }
  if (tool === "browser_handle_dialog" && args.accept === true) {
    return "accept a page dialog" + (args.promptText ? " with text" : "");
  }
  if (COORDINATE_TOOLS.has(tool)) {
    // A click by coordinates names no element, so nothing shows what it hits.
    return tool.replace("browser_", "") + " at " + [args.x, args.y].filter((value) => value !== undefined).join(",");
  }
  if (tool === "browser_press_key" && !safeKey(args.key)) {
    return "press " + String(args.key).slice(0, 30) + (probe.focused ? " on «" + probe.focused.slice(0, 120) + "»" : "");
  }
  if (!ACTING_TOOLS.has(tool) || tool === "browser_press_key") {
    return null;
  }
  const typedBreak = tool === "browser_type" && /[\r\n]/.test(String(args.text ?? ""));
  if (probe.postSubmit) {
    return tool.replace("browser_", "") + " «" + (snapshotName(pageText) || pageText).slice(0, 120) + "» (submits a form)";
  }
  // The agent's own description and the page's real text for the refs it
  // targets (from the latest snapshot): renaming a "Pay now" button in the
  // description does not get past the gate.
  const described = [strings({ element: args.element, values: args.values, fields: args.fields, startElement: args.startElement, endElement: args.endElement }).join(" "), String(pageText ?? "")].join(" ").trim();
  const submits = (tool === "browser_type" && args.submit === true) || typedBreak;
  if (COMMIT_WORDS.test(described) || submits) {
    return tool.replace("browser_", "") + " «" + (snapshotName(pageText) || described || "the focused element").slice(0, 160) + "»" + (submits ? " (submits)" : "");
  }
  return null;
}

/**
 * One approval covers exactly this call — tool, arguments, the page it runs
 * on and what the targeted element says — so it cannot be reused on another
 * page or another element.
 */
export function actionKey(tool, args = {}, context = {}) {
  return createHash("sha256")
    .update([tool, JSON.stringify(args), context.page ?? "", context.text ?? ""].join("\n"))
    .digest("hex")
    .slice(0, 24);
}

/** Origin and path of an address; never the query or fragment. */
export function pageOf(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.origin + parsed.pathname;
  } catch {
    return null;
  }
}

/** Log entry: tool and target, never typed text or a query string. */
export function logEntry(tool, args = {}) {
  return {
    at: new Date().toISOString(),
    tool,
    url: typeof args.url === "string" ? pageOf(args.url) ?? "(invalid)" : undefined,
    element: typeof args.element === "string" ? args.element.slice(0, 200) : undefined,
    target: callTargets(args)[0]?.slice(0, 60),
    filename: typeof args.filename === "string" ? args.filename.slice(0, 120) : undefined
  };
}
