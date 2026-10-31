import { redactSecrets } from "../lib/text.mjs";

/**
 * Owner notifications for console activity, sent through the gateway
 * (Telegram by default): every successful sign-in, lockouts and security
 * changes. Fire-and-forget: a slow, missing or failing gateway never delays
 * or breaks a sign-in. No password, token, ticket, cookie, code or session id
 * ever goes into a message.
 */

const TIMEOUT_MS = 8000;
const DEDUPE_MS = 5000;
const LOCK_MS = 60000;

export const DEFAULT_NOTIFY = { enabled: true, login: true, lockout: true, security: true, channel: "telegram", timezone: null };

export function resolveNotifySettings(section) {
  const base = { ...DEFAULT_NOTIFY };
  if (!section || typeof section !== "object") {
    return base;
  }
  const flag = (value, fallback) => (value === undefined || value === null ? fallback : !(value === false || value === "false"));
  let timezone = section.timezone ? String(section.timezone) : null;
  if (timezone) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone });
    } catch {
      timezone = null;
    }
  }
  return {
    enabled: flag(section.enabled, true),
    login: flag(section.login, true),
    lockout: flag(section.lockout, true),
    security: flag(section.security, true),
    channel: section.channel ? String(section.channel).slice(0, 40) : "telegram",
    timezone
  };
}

/** One line of "browser on system" from a user-agent string. */
export function describeDevice(userAgent) {
  const ua = String(userAgent ?? "");
  if (!ua) {
    return "نامشخص";
  }
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "مرورگر ناشناس";
  const system = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iOS/.test(ua) ? "iOS" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "سیستم ناشناس";
  return browser + " روی " + system;
}

/** Remove control, bidi-override and line-breaking characters from user supplied text. */
function plain(value, max = 60) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, "")
    .trim()
    .slice(0, max);
}

function formatTime(date, timezone) {
  const options = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(timezone ? { timeZone: timezone } : {}) };
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", options).formatToParts(date).map((part) => [part.type, part.value]));
  return parts.day + "/" + parts.month + "/" + parts.year + " " + parts.hour + ":" + parts.minute;
}

const METHOD_LABEL = { password: "نام کاربری و رمز", token: "توکن", ticket: "بلیط یک‌بارمصرف از ترمینال" };

/** Security changes worth a message: [method, pathname regex] → what happened. */
const SECURITY_EVENTS = [
  ["POST", /^\/api\/users$/, "حساب کاربری تازه ساخته شد"],
  ["POST", /^\/api\/users\/password$/, "رمز یک حساب عوض شد"],
  ["POST", /^\/api\/users\/totp$/, "ورود دومرحله‌ای یک حساب تغییر کرد"],
  ["POST", /^\/api\/users\/role$/, "نقش یک حساب عوض شد"],
  ["POST", /^\/api\/users\/remove$/, "یک حساب کاربری حذف شد"],
  ["POST", /^\/api\/users\/auth-mode$/, "روش ورود به آرامیس تغییر کرد"],
  ["POST", /^\/api\/accounts\/switch$/, "حساب Claude عوض شد"],
  ["POST", /^\/api\/accounts\/save$/, "یک حساب Claude ذخیره شد"],
  ["POST", /^\/api\/accounts\/remove$/, "یک حساب Claude حذف شد"],
  ["POST", /^\/api\/logout-all$/, "خروج از همهٔ نشست‌ها انجام شد"]
];

export class ConsoleNotifier {
  constructor({ runtime, settings = null, log = () => {}, clock = null } = {}) {
    this.runtime = runtime;
    this.settings = settings ?? { ...DEFAULT_NOTIFY };
    this.log = log;
    this.clock = clock ?? (() => new Date());
    this.recent = new Map();
    this.lockedAt = new Map();
  }

  ready() {
    return this.settings.enabled && typeof this.runtime?.gateway?.notify === "function";
  }

  /** Never throws and never waits for the caller. */
  send(text, level = "info") {
    if (!this.ready()) {
      return;
    }
    const clean = redactSecrets(String(text)).slice(0, 1500);
    const now = Date.now();
    for (const [key, at] of this.recent) {
      if (now - at > DEDUPE_MS) {
        this.recent.delete(key);
      }
    }
    if (this.recent.has(clean)) {
      return;
    }
    this.recent.set(clean, now);
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, TIMEOUT_MS);
      timer.unref?.();
    });
    let call;
    try {
      call = Promise.resolve(this.runtime.gateway.notify({ text: clean, level, channel: this.settings.channel }));
    } catch (error) {
      this.log("[console] notify failed: " + plain(error?.message, 120));
      return;
    }
    Promise.race([call, timeout])
      .catch((error) => this.log("[console] notify failed: " + plain(error?.message, 120)))
      .finally(() => clearTimeout(timer));
  }

  where(listener, address) {
    return (listener?.kind === "remote" ? "اینترنتی" : "محلی") + " — " + plain(address, 64);
  }

  when() {
    return formatTime(this.clock(), this.settings.timezone);
  }

  login({ method, user = null, usedCode = false, listener, address, userAgent }) {
    if (!this.settings.login) {
      return;
    }
    const who = method === "password" ? plain(user, 40) || "نامشخص" : METHOD_LABEL[method] ?? plain(method, 20);
    const how = (METHOD_LABEL[method] ?? plain(method, 20)) + (usedCode ? " + کد دومرحله‌ای" : "");
    const lines = [
      "🔐 ورود به آرامیس",
      "کاربر: " + who,
      "روش: " + how,
      "اتصال: " + (listener?.kind === "remote" ? "اینترنتی" : "محلی"),
      "آدرس: " + plain(address, 64),
      "دستگاه: " + describeDevice(userAgent),
      "زمان: " + this.when(),
      "اگر خودتان نبودید: تنظیمات ← خروج از همه‌جا، و رمز را عوض کنید."
    ];
    this.send(lines.join("\n"), "info");
  }

  lockout({ address, listener, target = null }) {
    if (!this.settings.lockout) {
      return;
    }
    const key = String(address);
    const now = Date.now();
    if (now - (this.lockedAt.get(key) ?? 0) < LOCK_MS) {
      return;
    }
    this.lockedAt.set(key, now);
    const lines = ["⚠️ قفل شدن ورود به آرامیس", "دلیل: تلاش‌های ناموفق پشت‌سرهم", "اتصال: " + (listener?.kind === "remote" ? "اینترنتی" : "محلی"), "آدرس: " + plain(address, 64)];
    if (target) {
      lines.push("نام کاربری: " + plain(target, 40));
    }
    lines.push("زمان: " + this.when());
    this.send(lines.join("\n"), "warn");
  }

  /** Called once after a route answered; decides by method and path. Never throws. */
  routed({ method, pathname, session, listener, address, userAgent }) {
    try {
      if (!this.settings.security) {
        return;
      }
      const event = SECURITY_EVENTS.find(([m, pattern]) => m === method && pattern.test(pathname));
      if (!event) {
        return;
      }
      const by = session?.user ? plain(session.user, 40) : session?.method === "ticket" ? METHOD_LABEL.ticket : METHOD_LABEL.token;
      this.send(["🛡️ " + event[2], "توسط: " + by, "اتصال: " + (listener?.kind === "remote" ? "اینترنتی" : "محلی"), "آدرس: " + plain(address, 64), "دستگاه: " + describeDevice(userAgent), "زمان: " + this.when()].join("\n"), "warn");
    } catch (error) {
      this.log("[console] notify failed: " + plain(error?.message, 120));
    }
  }
}
