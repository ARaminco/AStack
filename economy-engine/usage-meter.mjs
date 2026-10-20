import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { economyDirectory, scanLines, tail, updateJson } from "./storage.mjs";
import { LiveRegistry } from "./live.mjs";
import { modelClass } from "./policy.mjs";

const FIELDS = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"];
const ZERO = () => ({ calls: 0, tokens: 0, units: 0, input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 });

function filesUnder(root) {
  const files = [];
  if (!existsSync(root)) {
    return files;
  }
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory()) {
      files.push(...filesUnder(path));
    } else if (item.isFile() && item.name.endsWith(".jsonl")) {
      files.push(path);
    }
  }
  return files;
}

/** Delegation needs fresh Codex pressure without rescanning Claude usage. */
export function latestCodexLimits(root) {
  let latest = null;
  const files = filesUnder(root).map((path) => ({ path, modified: statSync(path).mtimeMs })).sort((a, b) => b.modified - a.modified);
  for (const file of files) {
    if (latest && file.modified < latest.capturedAt) {
      break;
    }
    for (const line of tail(file.path, 512 * 1024).split("\n")) {
      if (!line.includes('"token_count"')) {
        continue;
      }
      try {
        const entry = JSON.parse(line);
        const at = Date.parse(entry.timestamp);
        if ((entry.payload?.type ?? entry.type) === "token_count" && entry.payload?.rate_limits && Number.isFinite(at) && (!latest || at >= latest.capturedAt)) {
          latest = { rate_limits: entry.payload.rate_limits, capturedAt: at };
        }
      } catch {
        // Only complete, bounded token records are eligible.
      }
    }
  }
  return latest;
}

export class UsageMeter {
  constructor({ home = homedir(), directory = economyDirectory(home), claudeRoot = join(home, ".claude", "projects"), codexRoot = join(home, ".codex", "sessions"), config = {}, clock = () => Date.now() } = {}) {
    Object.assign(this, { directory, claudeRoot, codexRoot, config, clock });
    this.path = join(directory, "meter-cache.json");
  }

  cost(usage, model) {
    const weights = { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 0.1, output_tokens: 5, ...this.config.token_weights };
    const models = { haiku: 0.33, sonnet: 1, opus: 1.67, fable: 1.67, unknown: 1, ...this.config.model_weights };
    return FIELDS.reduce((sum, key) => sum + (Number(usage[key]) || 0) * weights[key], 0) * models[modelClass(model)];
  }

  add(total, call) {
    total.calls += 1;
    for (const key of FIELDS) {
      total[key] += Number(call.usage[key]) || 0;
    }
    total.tokens += FIELDS.reduce((sum, key) => sum + (Number(call.usage[key]) || 0), 0);
    total.units += this.cost(call.usage, call.model);
  }

  scanFile(path, previous, engine) {
    const stat = statSync(path);
    const identity = String(stat.ino) + ":" + stat.birthtimeMs;
    const file = previous && previous.identity === identity && previous.offset <= stat.size
      ? previous : { identity, offset: 0, calls: {}, engine };
    file.offset = scanLines(path, file.offset, (line) => {
      if (engine === "claude" && !line.includes('"output_tokens"')) {
        return;
      }
      if (engine === "codex" && !line.includes('"token_count"')) {
        return;
      }
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return;
      }
      if (engine === "codex") {
        const payload = entry.payload;
        if ((payload?.type ?? entry.type) !== "token_count" || !payload?.info?.total_token_usage) {
          return;
        }
        const current = payload.info.total_token_usage;
        const last = file.codexTotal ?? {};
        const usage = {
          input_tokens: Math.max(0, (current.input_tokens ?? 0) - (last.input_tokens ?? 0) - Math.max(0, (current.cached_input_tokens ?? 0) - (last.cached_input_tokens ?? 0))),
          cache_read_input_tokens: Math.max(0, (current.cached_input_tokens ?? 0) - (last.cached_input_tokens ?? 0)),
          output_tokens: Math.max(0, (current.output_tokens ?? 0) - (last.output_tokens ?? 0))
        };
        file.codexTotal = current;
        if (payload.rate_limits && (!file.rateAt || Date.parse(entry.timestamp) >= Date.parse(file.rateAt))) {
          file.rateLimits = payload.rate_limits;
          file.rateAt = entry.timestamp;
        }
        if (Object.values(usage).some((value) => value > 0)) {
          file.calls[String(file.sequence = (file.sequence ?? 0) + 1)] = { at: entry.timestamp, model: "codex", usage };
        }
        return;
      }
      const message = entry.message;
      if (!message?.usage || !message.id || !entry.timestamp) {
        return;
      }
      const key = message.id + ":" + (entry.requestId ?? "");
      const previousCall = file.calls[key];
      const usage = Object.fromEntries(FIELDS.map((field) => [field, Math.max(Number(message.usage[field]) || 0, Number(previousCall?.usage[field]) || 0)]));
      file.calls[key] = { at: previousCall?.at ?? entry.timestamp, model: message.model ?? previousCall?.model ?? "unknown", usage };
    });
    file.totals = ZERO();
    for (const call of Object.values(file.calls)) {
      this.add(file.totals, call);
    }
    return file;
  }

  async snapshot({ since = null } = {}) {
    const now = this.clock();
    const start = since === null ? now - 7 * 86400000 : new Date(since).getTime();
    if (!Number.isFinite(start)) {
      throw new Error("Invalid economy report timestamp");
    }
    const paths = [...filesUnder(this.claudeRoot).map((path) => [path, "claude"]), ...filesUnder(this.codexRoot).map((path) => [path, "codex"])];
    const cache = updateJson(this.path, (value) => {
      const files = {};
      for (const [path, engine] of paths) {
        try {
          files[path] = this.scanFile(path, value.files?.[path], engine);
        } catch (error) {
          if (error.code !== "ENOENT") {
            throw error;
          }
        }
      }
      return { version: 1, files, capturedAt: now };
    });
    const totals = ZERO();
    const codex = { ...ZERO(), rate_limits: null, capturedAt: null };
    const windows = { fiveHour: ZERO(), sevenDay: ZERO(), lastHour: ZERO() };
    const groups = { sessions: {}, subagents: {}, projects: {}, models: {}, hours: {} };
    for (const [path, file] of Object.entries(cache.files)) {
      if (file.engine === "codex" && file.rateLimits && (!codex.capturedAt || Date.parse(file.rateAt) > codex.capturedAt)) {
        codex.rate_limits = file.rateLimits;
        codex.capturedAt = Date.parse(file.rateAt);
      }
      const parts = relative(this.claudeRoot, path).split(sep);
      const project = parts[0];
      const subagent = parts.includes("subagents") ? basename(path, ".jsonl").replace(/^agent-/, "") : null;
      const session = subagent ? basename(dirname(dirname(path))) : basename(path, ".jsonl");
      for (const call of Object.values(file.calls)) {
        const at = Date.parse(call.at);
        if (!Number.isFinite(at) || at > now) {
          continue;
        }
        if (file.engine === "codex") {
          if (at >= start) {
            this.add(codex, call);
          }
          continue;
        }
        for (const [window, duration] of [["fiveHour", 5 * 3600000], ["sevenDay", 7 * 86400000], ["lastHour", 3600000]]) {
          if (at >= now - duration) {
            this.add(windows[window], call);
          }
        }
        if (at < start) {
          continue;
        }
        this.add(totals, call);
        for (const [group, key] of [["sessions", project + "/" + session], ["subagents", subagent ? session + "/" + subagent : null], ["projects", project], ["models", call.model], ["hours", new Date(at).toISOString().slice(0, 13)]]) {
          if (key !== null) {
            groups[group][key] ??= ZERO();
            this.add(groups[group][key], call);
          }
        }
      }
    }
    const topConsumers = Object.entries(groups.sessions).map(([id, total]) => {
      const [project, session] = id.split("/");
      let title = null;
      for (const line of tail(join(this.claudeRoot, project, session + ".jsonl"), 256 * 1024).split("\n")) {
        if (line.includes('"customTitle"')) {
          try {
            title = JSON.parse(line).customTitle ?? title;
          } catch {
            // A bounded tail can start in a partial record.
          }
        }
      }
      return { id, title, ...total, share: totals.units ? total.units / totals.units * 100 : 0 };
    }).sort((a, b) => b.units - a.units);
    const snapshot = { since: new Date(start).toISOString(), capturedAt: now, totals, windows, groups, topConsumers, burnRate: windows.lastHour.units, live: new LiveRegistry({ directory: this.directory, clock: this.clock }).read(), codex };
    updateJson(this.path, (value) => ({ ...value, summary: { capturedAt: now, windows } }));
    return snapshot;
  }
}
