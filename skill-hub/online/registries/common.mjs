import { sanitizeExternalContent } from "../../../lib/text.mjs";

/**
 * Shared helpers for registry adapters. Every adapter turns a registry's own
 * response into normalised hits:
 *
 *   { source, id: "<source>:<native id>", name, description, author,
 *     repo: "owner/repo" | null, repoUrl, path, ref, skillId,
 *     popularity, popularityKind, url,
 *     fetch: { type: "git", repo, path, skillId, ref } | { type: "clawhub", owner, slug } | null }
 *
 * Registry text is third-party data: it is stripped of control characters,
 * shortened and passed through the external-content sanitiser before it is
 * printed or stored.
 */
export function cleanText(value, max = 240) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F​-‏‪-‮⁠-⁩﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return sanitizeExternalContent(text, { maxLength: max }).text;
}

const GITHUB_REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export function isRepo(value) {
  return GITHUB_REPO.test(String(value ?? "")) && !String(value).includes("..");
}

/** Safe relative path inside a repository, or null. */
export function cleanRepoPath(value) {
  const text = String(value ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!text) {
    return "";
  }
  const parts = text.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[\u0000-\u001F;&|`$<>]/.test(part))) {
    return null;
  }
  return parts.join("/");
}

/**
 * Parse a GitHub tree/blob URL: https://github.com/<owner>/<repo>/tree/<ref>/<path>.
 * The ref is taken as one path segment (branch names with a slash fall back
 * to locating the folder by name).
 */
export function parseGitHubUrl(url) {
  const match = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/(tree|blob)\/([^/]+)(?:\/(.*))?)?\/?$/.exec(String(url ?? "").trim());
  if (!match) {
    return null;
  }
  const repo = match[1] + "/" + match[2];
  let path = match[5] ? decodeURIComponent(match[5]) : "";
  if (match[3] === "blob") {
    path = path.split("/").slice(0, -1).join("/");
  }
  const clean = cleanRepoPath(path);
  return isRepo(repo) && clean !== null ? { repo, ref: match[4] ?? null, path: clean } : null;
}

export function gitFetch({ repo, path = null, skillId = null, ref = null }) {
  return { type: "git", repo, path, skillId, ref };
}

export function repoUrl(repo, base = "https://github.com") {
  return repo ? base.replace(/\/+$/, "") + "/" + repo : null;
}

export function baseOf(endpoints, key, fallback) {
  return String(endpoints?.[key] ?? fallback).replace(/\/+$/, "");
}

export function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && value !== null && value !== "" ? number : null;
}
