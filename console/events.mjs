/**
 * Live updates for the console.
 *
 * Two sources feed one stream. Events emitted on `runtime.eventBus` in this
 * process are forwarded as they happen. Work started from another process (a
 * CLI run, the scheduler daemon, a gateway) never reaches this bus, so a light
 * poller also compares a fingerprint of the durable state — pending approvals,
 * mission states, runner runs, open incidents — and turns every difference
 * into a notification. Bus events only trigger an earlier poll, so a change is
 * announced once whichever way it was noticed.
 */

export const FORWARDED_EVENTS = [
  "approval.requested",
  "approval.granted",
  "approval.rejected",
  "approval.consumed",
  "mission.created",
  "mission.waiting",
  "mission.resumed",
  "mission.completed",
  "mission.failed",
  "scheduler.run.started",
  "scheduler.run.finished",
  "scheduler.incident.opened",
  "scheduler.incident.closed",
  "signal.received",
  "signal.processed",
  "skill.forged",
  "audit.recorded",
  "runner.started",
  "runner.completed",
  "runner.failed",
  "runner.awaiting-approval",
  "gateway.message",
  "board.updated"
];

const NOTIFY_LIMIT = 60;

/** The approval action a console conversation's tool request carries. */
export const CHAT_APPROVAL_ACTION = "claude.tool";

export class ConsoleEvents {
  constructor(runtime, { pollMs = 3000, log = () => {}, clock = null } = {}) {
    this.runtime = runtime;
    this.pollMs = Math.max(250, Number(pollMs) || 3000);
    this.log = log;
    this.clock = clock ?? (() => new Date());
    this.clients = new Set();
    // Per-client options: `chat: false` keeps conversation events away from
    // a listener where conversations are not available; `hideChatApprovals`
    // also keeps their tool approvals out of activity, notifications and counts.
    this.clientOptions = new WeakMap();
    this.notifications = [];
    this.sequence = 0;
    this.snapshot = null;
    this.timer = null;
    this.pending = null;
    this.attached = false;
    this.stopped = false;
  }

  /** Subscribe once per hub; the bus has no `off`, so handlers check `stopped`. */
  attach() {
    if (this.attached || !this.runtime.eventBus?.on) {
      return;
    }
    this.attached = true;
    for (const name of FORWARDED_EVENTS) {
      this.runtime.eventBus.on(name, (event) => {
        if (this.stopped) {
          return;
        }
        // Audit records arrive for every action; forwarding them keeps the
        // audit screen live without making them notifications.
        this.broadcast("activity", { event: event.eventName, payload: safePayload(event.payload), at: event.at });
        if (event.eventName !== "audit.recorded") {
          this.soon();
        }
      });
    }
  }

  start() {
    this.stopped = false;
    this.attach();
    this.snapshot = this.capture();
    this.timer = setInterval(() => this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.pending);
    this.timer = null;
    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        // already gone
      }
    }
    this.clients.clear();
  }

  soon() {
    clearTimeout(this.pending);
    this.pending = setTimeout(() => this.poll(), 120);
    this.pending.unref?.();
  }

  addClient(response, options = {}) {
    const settings = { chat: options.chat !== false, hideChatApprovals: options.hideChatApprovals === true };
    this.clients.add(response);
    this.clientOptions.set(response, settings);
    response.on("close", () => this.clients.delete(response));
    this.write(response, "hello", { at: this.clock().toISOString(), counts: this.counts({ hideChat: settings.hideChatApprovals }) });
  }

  write(response, type, data) {
    this.sequence += 1;
    try {
      response.write("id: " + this.sequence + "\nevent: " + type + "\ndata: " + JSON.stringify(data) + "\n\n");
    } catch {
      this.clients.delete(response);
    }
  }

  broadcast(type, data) {
    let hiddenCounts = null;
    for (const client of this.clients) {
      const options = this.clientOptions.get(client) ?? {};
      if (type === "chat" && options.chat === false) {
        continue;
      }
      if (options.hideChatApprovals) {
        if (type === "activity" && data?.payload?.action === CHAT_APPROVAL_ACTION) {
          continue;
        }
        if (type === "notification" && data?.chat) {
          continue;
        }
        if (type === "counts") {
          hiddenCounts = hiddenCounts ?? this.counts({ hideChat: true });
          this.write(client, type, hiddenCounts);
          continue;
        }
      }
      this.write(client, type, data);
    }
  }

  heartbeat() {
    for (const client of this.clients) {
      try {
        client.write(": keep-alive\n\n");
      } catch {
        this.clients.delete(client);
      }
    }
  }

  notify(kind, { title, body = null, level = "info", link = null, ref = null, chat = false }) {
    const entry = {
      id: "N" + Date.now().toString(36) + (this.notifications.length + 1),
      kind,
      title,
      body,
      level,
      link,
      ref,
      at: this.clock().toISOString(),
      // A conversation's tool request: hidden where conversations are closed.
      ...(chat ? { chat: true } : {})
    };
    this.notifications = [entry, ...this.notifications].slice(0, NOTIFY_LIMIT);
    this.broadcast("notification", entry);
    return entry;
  }

  recent(limit = 30, { hideChat = false } = {}) {
    return (hideChat ? this.notifications.filter((entry) => !entry.chat) : this.notifications).slice(0, limit);
  }

  counts({ hideChat = false } = {}) {
    const snapshot = this.snapshot ?? this.capture();
    return {
      approvals: Object.values(snapshot.approvals).filter((record) => !hideChat || record.action !== CHAT_APPROVAL_ACTION).length,
      missionsActive: Object.values(snapshot.missions).filter((mission) => ["running", "waiting-approval", "paused"].includes(mission.state)).length,
      incidents: Object.keys(snapshot.incidents).length,
      runsActive: Object.values(snapshot.runs).filter((run) => ["queued", "running", "awaiting-approval"].includes(run.status)).length
    };
  }

  capture() {
    const runtime = this.runtime;
    const approvals = {};
    for (const record of attempt(() => runtime.approvals.pending(), [])) {
      approvals[record.id] = { action: record.action, summary: record.summary, level: record.level };
    }
    const missions = {};
    for (const mission of attempt(() => runtime.missions.list({ limit: 200 }), [])) {
      missions[mission.id] = { state: mission.state, title: mission.title };
    }
    const incidents = {};
    for (const incident of attempt(() => runtime.scheduler.incidents({ open: true, limit: 100 }), [])) {
      incidents[incident.id] = { job: incident.jobName ?? incident.jobId ?? null, summary: incident.summary ?? null };
    }
    const runs = {};
    if (typeof runtime.runner?.list === "function") {
      for (const run of attempt(() => toArray(runtime.runner.list({ limit: 50 })), [])) {
        if (run?.id) {
          runs[run.id] = { status: run.status, summary: run.summary ?? run.objective ?? null };
        }
      }
    }
    return { approvals, missions, incidents, runs };
  }

  poll() {
    if (this.stopped) {
      return;
    }
    const before = this.snapshot ?? this.capture();
    const after = this.capture();
    this.snapshot = after;
    let changed = false;
    for (const [id, record] of Object.entries(after.approvals)) {
      if (!before.approvals[id]) {
        changed = true;
        this.notify("approval", { title: record.summary || record.action, body: record.action, level: "warning", link: "#/approvals/" + id, ref: id, chat: record.action === CHAT_APPROVAL_ACTION });
      }
    }
    for (const id of Object.keys(before.approvals)) {
      if (!after.approvals[id]) {
        changed = true;
      }
    }
    for (const [id, mission] of Object.entries(after.missions)) {
      const previous = before.missions[id];
      if (previous && previous.state === mission.state) {
        continue;
      }
      changed = true;
      if (mission.state === "completed" || mission.state === "failed") {
        this.notify("mission", { title: mission.title, body: mission.state, level: mission.state === "failed" ? "error" : "success", link: "#/missions/" + id, ref: id });
      }
    }
    for (const [id, incident] of Object.entries(after.incidents)) {
      if (!before.incidents[id]) {
        changed = true;
        this.notify("incident", { title: incident.job ?? id, body: incident.summary, level: "error", link: "#/jobs", ref: id });
      }
    }
    if (Object.keys(before.incidents).some((id) => !after.incidents[id])) {
      changed = true;
    }
    for (const [id, run] of Object.entries(after.runs)) {
      const previous = before.runs[id];
      if (previous && previous.status === run.status) {
        continue;
      }
      changed = true;
      if (["completed", "failed", "awaiting-approval", "refused"].includes(run.status)) {
        const level = run.status === "failed" || run.status === "refused" ? "error" : run.status === "completed" ? "success" : "warning";
        this.notify("run", { title: run.summary ?? id, body: run.status, level, link: "#/runs/" + id, ref: id });
      }
    }
    if (changed) {
      this.broadcast("counts", this.counts());
    }
  }
}

function attempt(fn, fallback) {
  try {
    const value = fn();
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function toArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (Array.isArray(value?.runs)) {
    return value.runs;
  }
  return [];
}

function safePayload(payload) {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (/secret|token|password|credential|cookie/i.test(key)) {
      continue;
    }
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
      out[key] = typeof value === "string" ? value.slice(0, 200) : value;
    }
  }
  return out;
}
