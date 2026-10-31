import { EconomyEngine } from "../economy-engine/economy-engine.mjs";
import { DEFAULT_ROUTES } from "../economy-engine/policy.mjs";
import { localModels } from "../economy-engine/delegate.mjs";

/**
 * The Aramis dashboard's numbers in one call: totals, tokens per day, models in
 * use, services and limits. Everything is read from this computer; nothing here
 * calls an outside service except the local model list (Ollama on loopback).
 * Cached for 20 seconds so reloading the page is cheap, and every part is
 * optional: one source failing leaves the rest of the dashboard intact.
 *
 * On the internet listener no project name, title or path is returned.
 */
const CACHE_MS = 20000;
const USAGE_PROJECTS = 8;
const SESSION_SAMPLE = 400;
const DAY_MS = 86400000;

const safe = async (task, fallback) => {
  try {
    return await task();
  } catch {
    return fallback;
  }
};

function lastDays(count, now) {
  const today = new Date(now).toISOString().slice(0, 10);
  return Array.from({ length: count }, (_, index) => new Date(Date.parse(today + "T00:00:00Z") - (count - 1 - index) * DAY_MS).toISOString().slice(0, 10));
}

export class ConsoleOverview {
  constructor(server, { economy = null, localModelList = null } = {}) {
    this.server = server;
    this.economyFactory = economy;
    this.localModelList = localModelList;
    this.cache = null;
    this.pending = null;
  }

  economy() {
    if (this.economyFactory) {
      return this.economyFactory();
    }
    return new EconomyEngine({ root: this.server.runtime.workspaceRoot });
  }

  async get({ remote = false, fresh: forceFresh = false } = {}) {
    const fresh = !forceFresh && this.cache && Date.now() - this.cache.at < CACHE_MS;
    if (!fresh) {
      this.pending ??= this.build().finally(() => {
        this.pending = null;
      });
      this.cache = { at: Date.now(), data: await this.pending };
    }
    return remote ? this.privateView(this.cache.data) : this.cache.data;
  }

  privateView(data) {
    return { ...data, topProjects: [], private: true };
  }

  async build() {
    const { runtime, projects, api } = this.server;
    const now = this.server.clock().getTime();
    const days = lastDays(7, now);

    await safe(() => projects.warm({}), null);
    const projectList = await safe(() => projects.projects(), []);
    const home = await safe(() => api.home({}), null);

    // tokens per day across the busiest recent projects
    const recent = [...projectList].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""))).slice(0, USAGE_PROJECTS);
    const tokens = Object.fromEntries(days.map((day) => [day, { date: day, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }]));
    const perProject = [];
    for (const entry of recent) {
      const usage = await safe(() => projects.usage({ project: entry.id }), null);
      let total = 0;
      for (const row of usage?.days ?? []) {
        if (tokens[row.date]) {
          tokens[row.date].input += row.input ?? 0;
          tokens[row.date].output += row.output ?? 0;
          tokens[row.date].cacheRead += row.cacheRead ?? 0;
          tokens[row.date].cacheWrite += row.cacheWrite ?? 0;
        }
        total += (row.input ?? 0) + (row.output ?? 0);
      }
      perProject.push({ id: entry.id, name: entry.label || entry.name, sessions: entry.sessions ?? 0, live: entry.live ?? 0, tokens: total });
    }

    // models actually used in the last seven days, counted from the chat list
    const sample = await safe(() => projects.sessions({ size: SESSION_SAMPLE, sort: "updated" }), { items: [] });
    const since = now - 7 * DAY_MS;
    const models = new Map();
    for (const item of sample.items ?? []) {
      if (item.model && Date.parse(item.updatedAt) >= since) {
        const name = String(item.model).replace(/^claude-/, "");
        models.set(name, (models.get(name) ?? 0) + 1);
      }
    }

    // activity per day from the audit trail
    const audit = await safe(() => runtime.audit.list({ limit: 4000 }), []);
    const activity = Object.fromEntries(days.map((day) => [day, 0]));
    for (const entry of audit) {
      const day = String(entry.timestamp ?? "").slice(0, 10);
      if (day in activity) {
        activity[day] += 1;
      }
    }

    const economy = await safe(() => this.economy(), null);
    const limits = economy ? await safe(() => economy.limits.read(), {}) : {};
    const local = this.localModelList ? await safe(() => this.localModelList(), []) : economy ? await safe(() => localModels({ config: economy.config }), []) : [];
    const claudeLimits = limits?.claude?.rate_limits ?? null;
    const codexLimits = limits?.codex?.rate_limits ?? null;
    const capturedAt = limits?.claude?.capturedAt ?? null;
    const account = await safe(async () => (await this.server.accounts.list()).active?.email ?? null, null);

    const gateway = await safe(() => api.gateway(), null);
    const channels = Object.entries(gateway?.status?.channels ?? {}).map(([id, channel]) => ({ id, enabled: Boolean(channel.enabled), configured: Boolean(channel.configured) }));
    const chatTurns = await safe(() => this.server.chats.status(), null);

    const services = [
      { id: "console", state: "on", detail: this.server.origin ?? "" },
      { id: "scheduler", state: (home?.scheduler?.failing ?? 0) > 0 ? "warn" : (home?.scheduler?.jobs ?? 0) > 0 ? "on" : "idle", detail: home?.scheduler ? home.scheduler.jobs + " / " + (home.scheduler.failing ?? 0) : "" },
      { id: "signals", state: (home?.counts?.hooks ?? 0) > 0 ? "on" : "idle", detail: String(home?.counts?.hooks ?? 0) },
      { id: "runner", state: home?.features?.runner ? "on" : "off", detail: "" },
      { id: "ollama", state: local.length ? "on" : "off", detail: String(local.length) },
      { id: "chats", state: (chatTurns?.running ?? 0) > 0 ? "busy" : "on", detail: String(chatTurns?.running ?? 0) },
      ...channels.map((channel) => ({ id: channel.id, state: channel.enabled && channel.configured ? "on" : channel.configured ? "idle" : "off", detail: "" }))
    ];

    const tokenRows = days.map((day) => tokens[day]);
    return {
      generatedAt: new Date(now).toISOString(),
      kpis: {
        projects: projectList.length,
        sessions: projectList.reduce((sum, entry) => sum + Number(entry.sessions ?? 0), 0),
        live: projectList.reduce((sum, entry) => sum + Number(entry.live ?? 0), 0),
        tokens7d: tokenRows.reduce((sum, row) => sum + row.input + row.output, 0),
        approvals: home?.counts?.approvals ?? 0,
        missions: home?.counts?.missionsActive ?? 0,
        jobs: home?.counts?.jobs ?? 0,
        incidents: home?.counts?.incidents ?? 0,
        skills: home?.counts?.skills ?? 0,
        auditToday: home?.counts?.auditToday ?? 0
      },
      tokensByDay: tokenRows,
      activityByDay: days.map((day) => ({ date: day, count: activity[day] })),
      topProjects: perProject.sort((a, b) => b.tokens - a.tokens).slice(0, 6),
      models: {
        seen: [...models].map(([model, count]) => ({ model, count })).sort((a, b) => b.count - a.count),
        local,
        routes: { ...DEFAULT_ROUTES },
        claude: claudeLimits ? { fiveHour: claudeLimits.five_hour ? { pct: claudeLimits.five_hour.used_percentage, resetsAt: claudeLimits.five_hour.resets_at } : null, sevenDay: claudeLimits.seven_day ? { pct: claudeLimits.seven_day.used_percentage, resetsAt: claudeLimits.seven_day.resets_at } : null, capturedAt, stale: capturedAt ? now - capturedAt > 6 * 3600000 : true } : null,
        codex: codexLimits?.primary ? { pct: codexLimits.primary.used_percent, resetsAt: codexLimits.primary.resets_at, plan: codexLimits.plan_type ?? null } : null,
        account
      },
      services
    };
  }
}
