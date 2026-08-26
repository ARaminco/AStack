import { Buffer } from "node:buffer";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeExternalContent, shortHash, slugify, uniqueTokens } from "../lib/text.mjs";

export const signalSources = ["whatsapp", "telegram", "email", "github", "gitlab", "monitoring", "portal", "form", "generic"];
export const reactionActions = [
  "notify",
  "record-episode",
  "memory-append",
  "create-mission",
  "assign-agent",
  "run-job",
  "create-work-item",
  "browser-task",
  "open-incident",
  "reply"
];

/**
 * Inbound signals.
 *
 * The owner registers one webhook URL in any external tool — a WhatsApp
 * gateway, a monitoring system, a government portal notifier, a form — and
 * every message that arrives is verified, normalized, classified by domain and
 * matched against rules that decide what AStack does about it.
 *
 * Message text is external content: it is sanitized and stored as data, and it
 * can never instruct the system to do something its rules do not allow.
 */
export class SignalEngine {
  constructor(root, { clock, eventBus, domains = null, services = {}, policy = null, audit = null } = {}) {
    this.root = root;
    this.directory = join(root, ".astack", "signals");
    this.hooksDirectory = join(this.directory, "hooks");
    this.inboxDirectory = join(this.directory, "inbox");
    this.clock = clock ?? (() => new Date());
    this.eventBus = eventBus ?? null;
    this.domains = domains;
    this.services = services;
    this.policy = policy;
    this.audit = audit;
    this.seenNonces = new Map();
  }

  now() {
    return this.clock().toISOString();
  }

  hookPath(id) {
    return join(this.hooksDirectory, id + ".json");
  }

  list() {
    if (!existsSync(this.hooksDirectory)) {
      return [];
    }
    return readdirSync(this.hooksDirectory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.get(name.replace(/\.json$/, "")))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id) {
    const path = this.hookPath(id);
    if (!existsSync(path)) {
      throw new Error("Unknown hook: " + id);
    }
    return JSON.parse(readFileSync(path, "utf8"));
  }

  exists(id) {
    return existsSync(this.hookPath(id));
  }

  save(hook) {
    mkdirSync(this.hooksDirectory, { recursive: true });
    hook.updatedAt = this.now();
    writeFileSync(this.hookPath(hook.id), JSON.stringify(hook, null, 2) + "\n", "utf8");
    return hook;
  }

  /**
   * Create a hook. The returned secret is shown once: it is what the external
   * tool signs its requests with.
   */
  create({ id = null, name, source = "generic", mapping = {}, rules = [], defaults = {}, enabled = true, requireSignature = true }) {
    if (!name) {
      throw new Error("A hook needs a name");
    }
    if (!signalSources.includes(source)) {
      throw new Error("Unknown signal source: " + source + ". Use: " + signalSources.join(", "));
    }
    const hookId = slugify(id ?? name, { fallback: "hook" });
    if (this.exists(hookId)) {
      throw new Error("Hook already exists: " + hookId);
    }
    const secret = randomBytes(24).toString("hex");
    const hook = {
      id: hookId,
      name,
      source,
      enabled,
      requireSignature,
      secret,
      token: randomBytes(12).toString("hex"),
      mapping: {
        text: mapping.text ?? "text",
        from: mapping.from ?? "from",
        subject: mapping.subject ?? "subject",
        attachments: mapping.attachments ?? "attachments",
        ...mapping
      },
      defaults: { domain: defaults.domain ?? null, project: defaults.project ?? null, authority: defaults.authority ?? "L2", ...defaults },
      rules,
      createdAt: this.now(),
      updatedAt: this.now(),
      state: { received: 0, processed: 0, lastAt: null, lastFrom: null }
    };
    this.save(hook);
    this.eventBus?.emit("signal.hook.created", { id: hook.id, source });
    return hook;
  }

  update(id, patch = {}) {
    const hook = this.get(id);
    return this.save({ ...hook, ...patch, id: hook.id, secret: hook.secret, token: hook.token });
  }

  remove(id) {
    const hook = this.get(id);
    rmSync(this.hookPath(id), { force: true });
    return hook;
  }

  addRule(id, rule) {
    const hook = this.get(id);
    const entry = {
      id: rule.id ?? "R" + (hook.rules.length + 1),
      when: rule.when ?? {},
      then: rule.then ?? [],
      stop: Boolean(rule.stop),
      enabled: rule.enabled !== false
    };
    for (const reaction of entry.then) {
      if (!reactionActions.includes(reaction.action)) {
        throw new Error("Unknown reaction action: " + reaction.action + ". Use: " + reactionActions.join(", "));
      }
    }
    hook.rules.push(entry);
    this.save(hook);
    return entry;
  }

  endpoint(id, { host = "http://127.0.0.1:8787" } = {}) {
    const hook = this.get(id);
    return host.replace(/\/$/, "") + "/hooks/" + hook.id + "?token=" + hook.token;
  }

  /**
   * Verify an inbound request: shared token, optional HMAC signature over the
   * raw body, a timestamp window and a nonce cache against replays.
   */
  verify(hook, { rawBody = "", signature = null, token = null, timestamp = null }) {
    if (!hook.enabled) {
      return { ok: false, reason: "hook is disabled" };
    }

    // A hook that requires a signature is satisfied by nothing else. A token,
    // which travels in a URL and lands in access logs, can never stand in for
    // it, and a signature is only meaningful with the timestamp it covers.
    if (hook.requireSignature) {
      if (!signature) {
        return { ok: false, reason: "signature required" };
      }
      if (!timestamp) {
        return { ok: false, reason: "timestamp required with a signature" };
      }
      const expected = createHmac("sha256", hook.secret).update(String(timestamp) + "." + rawBody).digest("hex");
      const provided = String(signature).replace(/^sha256=/, "").toLowerCase();
      if (provided.length !== expected.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) {
        return { ok: false, reason: "signature mismatch" };
      }
    } else if (!constantTimeEquals(token, hook.token)) {
      return { ok: false, reason: "invalid token" };
    }

    if (timestamp) {
      const millis = Number(timestamp) * (String(timestamp).length <= 10 ? 1000 : 1);
      if (!Number.isFinite(millis) || Math.abs(this.clock().getTime() - millis) > 5 * 60 * 1000) {
        return { ok: false, reason: "timestamp outside the accepted window" };
      }
    }

    const nonce = shortHash(hook.id, rawBody, String(timestamp ?? ""), String(signature ?? ""));
    const seenAt = this.seenNonces.get(nonce);
    if (seenAt && this.clock().getTime() - seenAt < 10 * 60 * 1000) {
      return { ok: false, reason: "replayed request" };
    }
    this.seenNonces.set(nonce, this.clock().getTime());
    if (this.seenNonces.size > 2000) {
      this.seenNonces.clear();
    }
    return { ok: true };
  }

  readPath(payload, path) {
    if (!path) {
      return null;
    }
    return String(path)
      .split(".")
      .reduce((value, segment) => (value === null || value === undefined ? value : value[segment]), payload);
  }

  /**
   * Turn a provider specific payload into the one event shape the rest of the
   * platform understands.
   */
  normalize(hook, payload) {
    const rawText = this.readPath(payload, hook.mapping.text) ?? payload.text ?? payload.message ?? payload.body ?? "";
    const sanitized = sanitizeExternalContent(typeof rawText === "string" ? rawText : JSON.stringify(rawText));
    const from = this.readPath(payload, hook.mapping.from) ?? payload.from ?? payload.sender ?? null;
    const subject = this.readPath(payload, hook.mapping.subject) ?? payload.subject ?? null;
    const attachments = this.readPath(payload, hook.mapping.attachments) ?? payload.attachments ?? [];
    const at = this.now();
    const domain = hook.defaults.domain ?? this.domains?.detect(sanitized.text)?.id ?? null;
    return {
      id: "SG-" + shortHash(hook.id, sanitized.text, at).slice(0, 10),
      hookId: hook.id,
      source: hook.source,
      at,
      from: from ? String(from).slice(0, 120) : null,
      subject: subject ? String(subject).slice(0, 200) : null,
      text: sanitized.text,
      injectionSuspected: sanitized.injectionSuspected,
      attachments: Array.isArray(attachments) ? attachments.slice(0, 20) : [],
      domain,
      project: hook.defaults.project ?? null,
      tokens: uniqueTokens(sanitized.text).slice(0, 20),
      trust: "external-untrusted",
      state: "queued",
      raw: truncateRaw(payload)
    };
  }

  queue(event) {
    mkdirSync(this.inboxDirectory, { recursive: true });
    writeFileSync(join(this.inboxDirectory, event.id + ".json"), JSON.stringify(event, null, 2) + "\n", "utf8");
    const hook = this.get(event.hookId);
    hook.state.received += 1;
    hook.state.lastAt = event.at;
    hook.state.lastFrom = event.from;
    this.save(hook);
    this.eventBus?.emit("signal.received", { id: event.id, hook: event.hookId, source: event.source, domain: event.domain });
    return event;
  }

  /**
   * Feed a hook from the command line. This is what makes the system usable
   * with tools that cannot reach a local port: a relay, an MCP bridge or a
   * cron job can pipe the payload in.
   */
  emit(hookId, payload) {
    const hook = this.get(hookId);
    return this.queue(this.normalize(hook, payload));
  }

  inbox({ state = null, limit = 50 } = {}) {
    if (!existsSync(this.inboxDirectory)) {
      return [];
    }
    return readdirSync(this.inboxDirectory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        try {
          return JSON.parse(readFileSync(join(this.inboxDirectory, name), "utf8"));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((event) => !state || event.state === state)
      .sort((a, b) => String(a.at).localeCompare(String(b.at)))
      .slice(0, limit);
  }

  saveEvent(event) {
    mkdirSync(this.inboxDirectory, { recursive: true });
    writeFileSync(join(this.inboxDirectory, event.id + ".json"), JSON.stringify(event, null, 2) + "\n", "utf8");
    return event;
  }

  matches(rule, event) {
    const when = rule.when ?? {};
    const haystack = [event.text, event.subject, event.from].filter(Boolean).join(" ").toLowerCase();
    if (when.source && when.source !== event.source) {
      return false;
    }
    if (when.from && !String(event.from ?? "").toLowerCase().includes(String(when.from).toLowerCase())) {
      return false;
    }
    if (when.domain && when.domain !== event.domain) {
      return false;
    }
    if (when.contains?.length && !when.contains.some((needle) => haystack.includes(String(needle).toLowerCase()))) {
      return false;
    }
    if (when.all?.length && !when.all.every((needle) => haystack.includes(String(needle).toLowerCase()))) {
      return false;
    }
    if (when.regex) {
      try {
        if (!new RegExp(when.regex, "iu").test(haystack)) {
          return false;
        }
      } catch {
        return false;
      }
    }
    if (when.hasAttachment && !(event.attachments ?? []).length) {
      return false;
    }
    return true;
  }

  /**
   * Process one queued event through its hook's rules.
   */
  async process(event) {
    const hook = this.get(event.hookId);
    const reactions = [];
    for (const rule of hook.rules.filter((entry) => entry.enabled !== false)) {
      if (!this.matches(rule, event)) {
        continue;
      }
      for (const reaction of rule.then) {
        const result = await this.react(reaction, event, hook, rule);
        reactions.push(result);
      }
      if (rule.stop) {
        break;
      }
    }
    if (!reactions.length && hook.defaults.fallback) {
      reactions.push(await this.react(hook.defaults.fallback, event, hook, null));
    }
    const processed = { ...event, state: "processed", processedAt: this.now(), reactions };
    this.saveEvent(processed);
    hook.state.processed += 1;
    this.save(hook);
    this.audit?.record({
      actor: "signal-engine",
      action: "signal-processed",
      target: hook.id + "/" + event.id,
      riskLevel: "L2",
      result: reactions.map((reaction) => reaction.action + ":" + (reaction.ok ? "ok" : "failed")).join(", ") || "no rule matched",
      metadata: { source: event.source, domain: event.domain, injectionSuspected: event.injectionSuspected }
    });
    this.eventBus?.emit("signal.processed", { id: event.id, hook: hook.id, reactions: reactions.length });
    return processed;
  }

  async processQueue({ limit = 50 } = {}) {
    const queued = this.inbox({ state: "queued", limit });
    const results = [];
    for (const event of queued) {
      results.push(await this.process(event));
    }
    return results;
  }

  /**
   * Execute one reaction. Reactions are declarative and policy checked: an
   * inbound message can never do more than the owner allowed the hook to do.
   */
  async react(reaction, event, hook, rule) {
    const action = reaction.action;
    const params = interpolate(reaction.params ?? {}, event);
    const verdict = this.policy?.allowAction(action) ?? { allowed: true };
    if (!verdict.allowed) {
      return { action, ok: false, summary: "blocked by automation policy: " + verdict.reason, rule: rule?.id ?? null };
    }
    try {
      switch (action) {
        case "notify": {
          const line = "[signal] " + (params.text ?? event.text.slice(0, 200));
          this.services.memory?.append?.("global", line);
          return { action, ok: true, summary: line.slice(0, 160) };
        }
        case "memory-append": {
          const record = this.services.memory?.remember?.(params.facet ?? "semantic", {
            title: params.title ?? ("signal from " + (event.from ?? event.source)),
            body: params.body ?? event.text.slice(0, 600),
            domain: event.domain,
            project: event.project,
            tags: ["signal", event.source],
            source: "signal:" + hook.id,
            confidence: 0.5
          });
          return { action, ok: Boolean(record), summary: "memory record " + (record?.id ?? "-") };
        }
        case "record-episode": {
          const recorded = this.services.learning?.record({
            task: params.task ?? event.text.slice(0, 160),
            domain: event.domain ?? "general",
            steps: [{ action: "received signal", tool: event.source }],
            outcome: "done",
            notes: "inbound signal " + event.id
          });
          return { action, ok: Boolean(recorded), summary: "episode " + (recorded?.episode?.id ?? "-") };
        }
        case "create-mission": {
          const mission = this.services.missions?.create({
            title: params.title ?? ("Signal: " + (event.subject ?? event.text.slice(0, 80))),
            goal: params.goal ?? event.text.slice(0, 300),
            domain: event.domain,
            project: event.project,
            tags: ["signal", hook.id],
            steps: params.steps ?? []
          });
          return { action, ok: Boolean(mission), summary: "mission " + (mission?.id ?? "-"), missionId: mission?.id ?? null };
        }
        case "assign-agent": {
          const assignment = this.services.agents?.assign(params.agent, {
            objective: params.objective ?? ("[signal " + event.id + "] " + event.text.slice(0, 160)),
            deliverable: params.deliverable ?? null,
            priority: params.priority ?? "normal",
            every: params.every ?? null
          });
          return { action, ok: Boolean(assignment), summary: "assignment " + (assignment?.id ?? "-") };
        }
        case "run-job": {
          const result = await this.services.scheduler?.runJob(params.job, { manual: true });
          return { action, ok: Boolean(result?.run?.status === "ok"), summary: result?.run?.summary ?? "job " + params.job };
        }
        case "create-work-item": {
          const item = this.services.projects?.addWorkItem(params.project ?? event.project, {
            title: params.title ?? event.text.slice(0, 120),
            department: params.department ?? null,
            points: params.points ?? 3
          });
          return { action, ok: Boolean(item), summary: "work item " + (item?.id ?? "-") };
        }
        case "browser-task": {
          const result = await this.services.browser?.run({
            profile: params.profile ?? "default",
            url: params.url,
            steps: params.steps ?? [],
            capture: params.capture ?? ["screenshot"],
            evidence: params.evidence ?? hook.id,
            mission: params.mission ?? null
          });
          return { action, ok: Boolean(result?.ok), summary: result?.summary ?? "browser task" };
        }
        case "open-incident": {
          const incident = {
            id: "INC-signal-" + event.id,
            at: this.now(),
            hook: hook.id,
            summary: params.summary ?? event.text.slice(0, 200),
            severity: params.severity ?? "medium"
          };
          mkdirSync(this.directory, { recursive: true });
          appendFileSync(join(this.directory, "incidents.jsonl"), JSON.stringify(incident) + "\n", "utf8");
          return { action, ok: true, summary: incident.id };
        }
        case "reply": {
          if (!params.url) {
            return { action, ok: false, summary: "reply needs a target url" };
          }
          const allowed = this.policy?.allowHost(params.url) ?? { allowed: true };
          if (!allowed.allowed) {
            return { action, ok: false, summary: "blocked: " + allowed.reason };
          }
          const response = await fetch(params.url, {
            method: params.method ?? "POST",
            headers: { "content-type": "application/json", ...(params.headers ?? {}) },
            body: JSON.stringify(params.body ?? { text: params.text ?? "AStack received your message." }),
            signal: AbortSignal.timeout(10000)
          });
          return { action, ok: response.ok, summary: "reply HTTP " + response.status };
        }
        default:
          return { action, ok: false, summary: "unsupported reaction" };
      }
    } catch (error) {
      return { action, ok: false, summary: error.message };
    }
  }

  status() {
    const hooks = this.list();
    return {
      hooks: hooks.length,
      enabled: hooks.filter((hook) => hook.enabled).length,
      queued: this.inbox({ state: "queued", limit: 1000 }).length,
      processed: hooks.reduce((sum, hook) => sum + (hook.state.processed ?? 0), 0),
      received: hooks.reduce((sum, hook) => sum + (hook.state.received ?? 0), 0),
      lastAt: hooks.map((hook) => hook.state.lastAt).filter(Boolean).sort().pop() ?? null
    };
  }
}

function constantTimeEquals(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  if (!a.length || a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function truncateRaw(payload) {
  const text = JSON.stringify(payload ?? {});
  return text.length > 4000 ? { truncated: true, preview: text.slice(0, 4000) } : payload;
}

function interpolate(params, event) {
  const resolved = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      resolved[key] = value
        .replace(/\{text\}/g, event.text ?? "")
        .replace(/\{from\}/g, event.from ?? "")
        .replace(/\{subject\}/g, event.subject ?? "")
        .replace(/\{domain\}/g, event.domain ?? "")
        .replace(/\{id\}/g, event.id ?? "");
      continue;
    }
    resolved[key] = value;
  }
  return resolved;
}
