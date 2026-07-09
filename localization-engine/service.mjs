import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const supportedLocales = ["fa", "en", "ar", "tr"];

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readConfigValue(key, fallback) {
  const path = join(root, "astack.config.yaml");
  if (!existsSync(path)) {
    return fallback;
  }
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(key + ":")) {
      return trimmed.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  return fallback;
}

function normalizeLocale(locale) {
  const value = String(locale || "").toLowerCase().split("-")[0];
  return supportedLocales.includes(value) ? value : readConfigValue("conversation", "fa");
}

function get(source, key) {
  return key.split(".").reduce((value, segment) => value?.[segment], source);
}

function format(value, vars) {
  return typeof value === "string" ? value.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => String(vars[key] ?? "")) : value;
}

export function createLocalization(options = {}) {
  const locale = normalizeLocale(options.locale || process.env.ASTACK_LOCALE || readConfigValue("default_locale", "fa"));
  const fallbackLocale = normalizeLocale(options.fallbackLocale || readConfigValue("fallback_locale", "en"));
  const messages = loadJson(join(root, "locales", locale + ".json"));
  const fallback = loadJson(join(root, "locales", fallbackLocale + ".json"));

  return {
    locale,
    direction: get(messages, "meta.direction") ?? get(fallback, "meta.direction"),
    t(key, vars = {}) {
      return format(get(messages, key) ?? get(fallback, key) ?? key, vars);
    }
  };
}

export { supportedLocales };
