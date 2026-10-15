import { lookup } from "node:dns/promises";
import { isInternalHost } from "../../permission-system/automation-policy.mjs";

/**
 * Small, polite HTTP client for the online skill registries.
 *
 * Every URL — the first one and every redirect target — passes
 * `automationPolicy.allowHost` before a connection is made. Requests carry an
 * `astack-skill-hub/<version>` User-Agent, time out, never send cookies and
 * stop reading once a response grows past a size cap. Response bodies are
 * data: they are parsed as JSON or kept as bytes, never evaluated.
 *
 * Redirects stay on the requested host (other hosts only when listed in
 * skills.online.redirect_hosts, and then without credential headers), never
 * downgrade from https, and must resolve to public addresses.
 */

export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 4;

/**
 * An error the caller can show as-is, with a hint (an exact command) when the
 * owner can fix it.
 */
export class OnlineError extends Error {
  constructor(message, { code = "error", hint = null, status = null, host = null } = {}) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.status = status;
    this.host = host;
  }
}

/**
 * Turn a policy refusal into an OnlineError whose hint is the exact command
 * that would lift it, when one exists.
 */
export function policyError(url, verdict) {
  let host = null;
  try {
    host = new URL(String(url)).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    host = null;
  }
  const reason = String(verdict?.reason ?? "refused");
  let hint = null;
  if (/not allowlisted/i.test(reason) && host) {
    hint = "astack schedule policy allow-host " + host;
  } else if (/Internal and link-local/i.test(reason)) {
    hint = "astack schedule policy allow-private";
  }
  return new OnlineError("Refused by the automation policy: " + reason, { code: "policy", hint, host });
}

export function checkHost(policy, url) {
  if (!policy) {
    return;
  }
  const verdict = policy.allowHost(url);
  if (!verdict.allowed) {
    throw policyError(url, verdict);
  }
}

async function readCapped(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new OnlineError("Response too large (" + declared + " bytes, cap " + maxBytes + ")", { code: "too-large" });
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new OnlineError("Response too large (over " + maxBytes + " bytes)", { code: "too-large" });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function rateLimitNote(headers) {
  const parts = [];
  const retry = headers.get("retry-after");
  if (retry) {
    parts.push("retry after " + retry + "s");
  }
  for (const name of ["x-ratelimit-daily-remaining", "x-ratelimit-minute-remaining", "x-ratelimit-remaining", "ratelimit-remaining"]) {
    const value = headers.get(name);
    if (value !== null) {
      parts.push(name.replace(/^x-/, "") + " " + value);
    }
  }
  return parts.join(", ");
}

// Headers that carry a credential. They are never sent to a host other than
// the one the request was made to.
const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key", "x-auth-token"]);

export function withoutCredentials(headers) {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !CREDENTIAL_HEADERS.has(String(name).toLowerCase())));
}

function hostnameOf(url) {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

/**
 * A redirect target must resolve to public addresses only, unless the policy
 * deliberately allows private networks (`astack schedule policy
 * allow-private`). This closes the gap a host name check leaves: a public
 * name whose DNS answer is 127.0.0.1, 10.x or 169.254.169.254.
 */
async function assertPublicTarget(url, policy, lookupImpl) {
  if (policy?.policy?.network?.allowPrivateNetworks === true) {
    return;
  }
  const host = hostnameOf(url);
  let addresses;
  try {
    addresses = await lookupImpl(host, { all: true, verbatim: true });
  } catch (error) {
    throw new OnlineError("Cannot resolve the redirect target " + host + " (" + String(error?.code ?? error?.message ?? error) + ")", { code: "network", host });
  }
  for (const entry of Array.isArray(addresses) ? addresses : [addresses]) {
    const address = String(entry?.address ?? entry ?? "");
    if (!address || isInternalHost(address.toLowerCase())) {
      throw new OnlineError("Refused a redirect to " + host + ": it resolves to an internal address (" + (address || "none") + ").", { code: "policy", hint: "astack schedule policy allow-private", host });
    }
  }
}

/**
 * GET a URL. Returns { status, url, headers, contentType, body (Buffer) }.
 *
 * Redirects are followed by hand, at most MAX_REDIRECTS times. Every target
 * passes the policy again; https never downgrades to http; a target on
 * another host than the one requested is refused unless that host is listed
 * in `redirectHosts` (and then credential headers are dropped); and the
 * target's DNS answer must not be a private, loopback or link-local address.
 */
export async function httpGet(url, { policy = null, userAgent = "astack-skill-hub", headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, fetchImpl = globalThis.fetch, redirectHosts = [], lookupImpl = lookup } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new OnlineError("This Node.js has no fetch(); online skill search needs Node 20 or newer.", { code: "unsupported" });
  }
  let current = String(url);
  let requestedHost = null;
  try {
    requestedHost = new URL(current).host.toLowerCase();
  } catch {
    requestedHost = null;
  }
  const extraHosts = new Set((Array.isArray(redirectHosts) ? redirectHosts : []).map((host) => String(host).trim().toLowerCase()).filter(Boolean));
  let sendHeaders = { ...headers };
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    checkHost(policy, current);
    let response;
    try {
      response = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": userAgent, accept: "application/json, application/zip;q=0.9, */*;q=0.5", ...sendHeaders },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      throw new OnlineError((timedOut ? "Timed out after " + timeoutMs + " ms: " : "Network error: ") + hostOf(current) + (timedOut ? "" : " (" + String(error?.cause?.code ?? error?.message ?? error) + ")"), { code: timedOut ? "timeout" : "network", host: hostOf(current) });
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      await response.body?.cancel?.().catch(() => {});
      const from = new URL(current);
      let next;
      try {
        next = new URL(response.headers.get("location"), current);
      } catch {
        throw new OnlineError("Invalid redirect from " + from.host, { code: "redirect", host: from.host });
      }
      if (from.protocol === "https:" && next.protocol !== "https:") {
        throw new OnlineError("Refused a redirect from https to " + next.protocol.replace(/:$/, "") + " (" + from.host + " -> " + next.host + ").", { code: "redirect", host: next.host });
      }
      if (next.host.toLowerCase() !== requestedHost) {
        if (!extraHosts.has(hostnameOf(next))) {
          throw new OnlineError(
            "Refused a redirect from " + (requestedHost ?? from.host) + " to another host: " + next.host + ". A registry's download host can be allowed deliberately in skills.online.redirect_hosts.",
            { code: "redirect", host: next.host }
          );
        }
        // An allowed foreign host never receives the registry credential.
        sendHeaders = withoutCredentials(sendHeaders);
      }
      await assertPublicTarget(next, policy, lookupImpl);
      current = next.toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      const note = rateLimitNote(response.headers);
      await response.body?.cancel?.().catch(() => {});
      const limited = response.status === 429;
      throw new OnlineError(
        (limited ? "Rate limited" : "HTTP " + response.status) + " from " + hostOf(current) + (note ? " (" + note + ")" : ""),
        { code: limited ? "rate-limited" : "http", status: response.status, host: hostOf(current) }
      );
    }
    const body = await readCapped(response, maxBytes);
    return { status: response.status, url: current, headers: response.headers, contentType: String(response.headers.get("content-type") ?? ""), body };
  }
  throw new OnlineError("Too many redirects: " + url, { code: "redirects" });
}

export async function httpGetJson(url, options = {}) {
  const response = await httpGet(url, options);
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch {
    throw new OnlineError("Invalid JSON from " + hostOf(response.url), { code: "format", host: hostOf(response.url) });
  }
}

export function hostOf(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return String(url);
  }
}
