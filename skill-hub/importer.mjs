import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { sanitizeExternalContent, slugify, uniqueTokens } from "../lib/text.mjs";
import { parseFrontMatter } from "./frontmatter.mjs";
import { MAX_FILE_BYTES, isGitMetadataName, listSkillFiles, sniff } from "./scanner.mjs";

const SKIP_DIRECTORIES = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".astack", "dist", "build"]);

// `.git` in any case, with trailing dots or spaces, or as its 8.3 short name.
// (`.github` stays: some repositories keep their skills in `.github/skills/`.)
function isRepositoryFolder(name) {
  const normal = String(name ?? "").toLowerCase().replace(/[. ]+$/, "");
  return normal === ".git" || normal === "git~1";
}

export const DEFAULT_TIERS = { skills: "core", "optional-skills": "optional" };

const CATEGORY_DOMAINS = {
  research: "research",
  "data-science": "research",
  mlops: "software",
  "software-development": "software",
  "web-development": "software",
  devops: "software",
  mcp: "software",
  "autonomous-ai-agents": "software",
  security: "software",
  github: "software",
  finance: "finance",
  payments: "finance",
  blockchain: "finance",
  "social-media": "marketing",
  marketing: "marketing",
  creative: "marketing",
  media: "marketing",
  productivity: "operations",
  "note-taking": "operations",
  email: "operations",
  communication: "operations",
  "smart-home": "operations",
  apple: "operations",
  migration: "operations",
  health: "business",
  gaming: "business"
};

// Tools and conventions that only exist inside the Hermes agent runtime.
const HERMES_TOOLS = [
  "web_extract", "web_search", "terminal", "delegate_task", "send_message", "browser_navigate", "browser_click", "vision_analyze",
  "text_to_speech", "image_generate", "execute_code", "skill_view", "skill_manage", "skills_list", "session_search", "cronjob",
  "clarify", "mixture_of_agents", "read_file", "write_file", "search_files", "todo", "memory", "patch", "process", "ha_call_service"
];
const HERMES_CLI = /(^|[\s`"'(])hermes\s+(gateway|config|skills|cron|tools|setup|profile|model|chat|plugins|auth|sessions|mcp|doctor|update|status|kanban|insights|login|pairing)\b/g;
const RUNTIME_FIELDS = ["requires_toolsets", "fallback_for_toolsets", "toolsets", "session_platforms", "requires_tools"];

/**
 * Find every skill folder (a folder holding SKILL.md) under a directory.
 * Discovery stops at a skill folder: everything inside belongs to it.
 */
export function discoverSkills(directory, { paths = null } = {}) {
  const roots = paths?.length ? paths.map((path) => join(directory, ...String(path).split(/[\\/]/))) : [directory];
  const found = [];
  const walk = (current) => {
    if (existsSync(join(current, "SKILL.md"))) {
      found.push(current);
      return;
    }
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && !SKIP_DIRECTORIES.has(entry.name) && !isRepositoryFolder(entry.name)) {
        walk(join(current, entry.name));
      }
    }
  };
  for (const root of roots) {
    if (existsSync(root) && statSync(root).isDirectory()) {
      walk(root);
    }
  }
  return found.map((path) => ({ path, rel: relative(directory, path).split(sep).join("/") || "." }));
}

function clean(text, max) {
  const value = String(text ?? "")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F​-‏‪-‮⁠-⁩﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return sanitizeExternalContent(value, { maxLength: max }).text;
}

function asList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function firstParagraph(body) {
  return String(body ?? "")
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .find((block) => block && !block.startsWith("#") && !block.startsWith("```") && !block.startsWith("|")) ?? "";
}

/**
 * Does a skill only make sense inside the Hermes agent runtime?
 */
export function detectCompat(data, body) {
  const markers = [];
  const hermes = data?.metadata?.hermes ?? {};
  for (const field of RUNTIME_FIELDS) {
    if (data?.[field] !== undefined || hermes?.[field] !== undefined) {
      markers.push("field:" + field);
    }
  }
  const text = String(body ?? "");
  const cli = new Set([...text.matchAll(HERMES_CLI)].map((match) => match[2]));
  for (const command of cli) {
    markers.push("cli:hermes " + command);
  }
  const tools = HERMES_TOOLS.filter((tool) => new RegExp("(^|[^A-Za-z0-9_.])" + tool + "\\(").test(text));
  for (const tool of tools) {
    markers.push("tool:" + tool);
  }
  const home = /~\/\.hermes\b|\$HERMES_HOME\b|HERMES_HOME/.test(text);
  if (home) {
    markers.push("path:~/.hermes");
  }
  const score = (markers.some((marker) => marker.startsWith("field:")) ? 3 : 0) + cli.size * 2 + tools.length + (home ? 1 : 0);
  return { compat: score >= 3 ? "hermes-runtime" : "portable", markers };
}

/**
 * Read a discovered skill folder into a catalog entry (without scanning).
 */
export function describeSkill({ path, rel }, { tiers = DEFAULT_TIERS, packLicense = null } = {}) {
  const text = readFileSync(join(path, "SKILL.md"), "utf8");
  const parsed = parseFrontMatter(text);
  const data = parsed.data ?? {};
  const segments = rel === "." ? [] : rel.split("/");
  const folder = segments[segments.length - 1] ?? slugify(String(data.name ?? "skill"));
  let tier = null;
  let parents = segments.slice(0, -1);
  if (parents.length && tiers[parents[0]] !== undefined) {
    tier = tiers[parents[0]];
    parents = parents.slice(1);
  } else if (!parents.length && segments.length === 1 && tiers[segments[0]] !== undefined) {
    tier = tiers[segments[0]];
  }
  const hermes = data?.metadata?.hermes ?? {};
  const category = String(parents[0] ?? hermes.category ?? data.category ?? data?.metadata?.category ?? "general");
  const subcategory = parents.slice(1).join("/") || null;
  const name = clean(data.name ?? folder, 80) || folder;
  const description = clean(data.description ?? firstParagraph(parsed.body), 320);
  const tags = [...asList(hermes.tags), ...asList(data.tags), ...asList(data?.metadata?.tags)].map((tag) => clean(tag, 40)).filter(Boolean);
  const keywords = uniqueTokens([folder.replace(/[-_]/g, " "), name, tags.join(" "), category.replace(/[-_]/g, " "), subcategory ?? ""].join(" ")).slice(0, 24);
  const { compat, markers } = detectCompat(data, parsed.body);
  return {
    folder,
    name,
    description,
    category,
    subcategory,
    tier,
    tags: [...new Set(tags)].slice(0, 16),
    keywords,
    domain: CATEGORY_DOMAINS[category] ?? "business",
    license: data.license ? clean(data.license, 60) : packLicense,
    version: data.version !== undefined ? String(data.version) : null,
    author: data.author ? clean(data.author, 120) : null,
    platforms: asList(data.platforms),
    related: asList(hermes.related_skills ?? data.related_skills).slice(0, 12),
    compat,
    compatMarkers: markers.slice(0, 12),
    frontMatter: parsed.ok,
    upstream: rel
  };
}

/**
 * Copy a skill folder byte for byte, skipping binaries, oversized files and
 * symbolic links. Returns the copied and excluded files.
 */
export function copySkill(sourceDirectory, targetDirectory, { maxBytes = MAX_FILE_BYTES, dryRun = false } = {}) {
  const copied = [];
  const excluded = [];
  for (const file of listSkillFiles(sourceDirectory)) {
    // listSkillFiles already leaves git metadata out; check every segment
    // again so no spelling of `.git` can reach a pack.
    if (file.rel.split("/").some((segment) => isGitMetadataName(segment))) {
      excluded.push({ file: file.rel, reason: "git metadata" });
      continue;
    }
    if (file.symlink) {
      excluded.push({ file: file.rel, reason: "symbolic link" });
      continue;
    }
    if (file.size > maxBytes) {
      excluded.push({ file: file.rel, reason: "larger than " + Math.round(maxBytes / 1048576) + " MB (" + file.size + " bytes)" });
      continue;
    }
    const kind = sniff(file.absolute, file.rel);
    if (kind.binary) {
      excluded.push({ file: file.rel, reason: (kind.executable ? "executable binary" : "binary") + " (" + file.size + " bytes)" });
      continue;
    }
    if (!dryRun) {
      const target = join(targetDirectory, ...file.rel.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(file.absolute, target);
    }
    copied.push({ file: file.rel, size: file.size });
  }
  return { copied, excluded };
}

export function findLicense(directory) {
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING"]) {
    const path = join(directory, name);
    if (existsSync(path) && statSync(path).isFile()) {
      const text = readFileSync(path, "utf8");
      return { file: name, text, spdx: spdxOf(text) };
    }
  }
  return null;
}

export function spdxOf(text) {
  const value = String(text ?? "");
  if (/MIT License|Permission is hereby granted, free of charge/i.test(value)) {
    return "MIT";
  }
  if (/Apache License,?\s+Version 2\.0/i.test(value)) {
    return "Apache-2.0";
  }
  if (/BSD 3-Clause|Redistribution and use in source and binary forms/i.test(value)) {
    return "BSD";
  }
  if (/GNU GENERAL PUBLIC LICENSE/i.test(value)) {
    return "GPL";
  }
  if (/Mozilla Public License/i.test(value)) {
    return "MPL-2.0";
  }
  return value.trim() ? "custom" : null;
}
