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
 * - passwords: the agent never types into a password, PIN or one-time-code
 *   field; the owner types those in the window;
 * - commits: a click, submit, upload or accepted dialog that commits (submit,
 *   pay, send, delete, publish, …) needs an owner approval, one receipt per
 *   action.
 */

export const CODE_TOOLS = new Set(["browser_evaluate", "browser_run_code_unsafe", "browser_run_code"]);
export const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "about:"]);

const COMMIT_WORDS = /\b(submit|pay|payment|checkout|purchase|buy|order|place order|confirm|send|delete|remove|destroy|publish|post|transfer|wire|sign|approve|accept|finali[sz]e|file it|apply)\b|ثبت|پرداخت|ارسال|بفرست|حذف|تایید|تأیید|انتشار|منتشر|واریز|انتقال|امضا|خرید|سفارش|نهایی|إرسال|دفع|حذف|تأكيد|نشر/i;
const SECRET_FIELDS = /\b(password|passcode|passwd|pin|otp|one[- ]time|2fa|mfa|verification code|security code|cvv|cvc|card number)\b|رمز|گذرواژه|پسورد|کد تایید|کد تأیید|کد یکبار|کلمه عبور|كلمة المرور|رمز التحقق/i;
const ACTING_TOOLS = new Set(["browser_click", "browser_type", "browser_fill_form", "browser_select_option", "browser_press_key", "browser_drag", "browser_drop"]);

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

/** Typing into a secret field is the owner's job. */
export function secretFieldProblem(tool, args = {}) {
  if (!["browser_type", "browser_fill_form"].includes(tool)) {
    return null;
  }
  const targets = tool === "browser_fill_form"
    ? (Array.isArray(args.fields) ? args.fields : []).map((field) => [field?.name, field?.element, field?.type].filter(Boolean).join(" "))
    : [String(args.element ?? "")];
  return targets.some((target) => SECRET_FIELDS.test(target))
    ? "Refused: passwords, PINs and one-time codes are typed by the owner in the project's browser window, never by an agent."
    : null;
}

/**
 * What a commit-like call would commit, or null. Uploads and accepted dialogs
 * always count: an upload sends a file away, and a dialog is usually the
 * "are you sure?" of a delete or a payment.
 */
export function commitTarget(tool, args = {}) {
  if (tool === "browser_file_upload" && Array.isArray(args.paths) && args.paths.length) {
    return "upload " + args.paths.length + " file(s): " + args.paths.map((path) => String(path).split(/[\\/]/).pop()).join(", ");
  }
  if (tool === "browser_handle_dialog" && args.accept === true) {
    return "accept a page dialog" + (args.promptText ? " with text" : "");
  }
  if (!ACTING_TOOLS.has(tool)) {
    return null;
  }
  const described = strings({ element: args.element, values: args.values, fields: args.fields, startElement: args.startElement, endElement: args.endElement }).join(" ");
  const pressesEnter = tool === "browser_press_key" && /^(enter|return)$/i.test(String(args.key ?? ""));
  const submits = (tool === "browser_type" && args.submit === true) || pressesEnter;
  if (COMMIT_WORDS.test(described) || (submits && COMMIT_WORDS.test(described + " submit"))) {
    return tool.replace("browser_", "") + " «" + (described || "the focused element").slice(0, 160) + "»";
  }
  return null;
}

/** One approval covers exactly this tool with exactly these arguments. */
export function actionKey(tool, args = {}) {
  return createHash("sha256").update(tool + "\n" + JSON.stringify(args)).digest("hex").slice(0, 24);
}

/** Log entry: tool and target, never typed text or a query string. */
export function logEntry(tool, args = {}) {
  let url;
  if (typeof args.url === "string") {
    try {
      const parsed = new URL(args.url);
      url = parsed.origin + parsed.pathname;
    } catch {
      url = "(invalid)";
    }
  }
  return {
    at: new Date().toISOString(),
    tool,
    url,
    element: typeof args.element === "string" ? args.element.slice(0, 200) : undefined,
    filename: typeof args.filename === "string" ? args.filename.slice(0, 120) : undefined
  };
}
