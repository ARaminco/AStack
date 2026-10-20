import { join } from "node:path";
import { economyDirectory, readJson, updateJson } from "./storage.mjs";

export class LiveRegistry {
  constructor({ directory = economyDirectory(), clock = () => Date.now() } = {}) {
    this.path = join(directory, "live.json");
    this.routesPath = join(directory, "routes.json");
    this.clock = clock;
  }

  prune(value) {
    const sessions = {};
    for (const [session, agents] of Object.entries(value)) {
      const kept = Object.fromEntries(Object.entries(agents).filter(([, agent]) => this.clock() - agent.startedAt < 3 * 3600000));
      if (Object.keys(kept).length) {
        sessions[session] = kept;
      }
    }
    return sessions;
  }

  read() {
    return this.prune(readJson(this.path));
  }

  rememberRoute(input, decision) {
    let admitted = false;
    updateJson(this.routesPath, (value) => {
      const entries = (value.entries ?? []).filter((entry) => this.clock() - entry.at < 180000);
      const running = Object.keys(this.read()[input.session_id] ?? {}).length;
      const pending = entries.filter((entry) => entry.session === input.session_id).length;
      if (running + pending < decision.cap) {
        entries.push({ session: input.session_id, type: input.tool_input.subagent_type, model: decision.model, at: this.clock() });
        admitted = true;
      }
      return { entries };
    });
    return admitted;
  }

  start(input, model) {
    if (!input.session_id || !input.agent_id) {
      return;
    }
    updateJson(this.routesPath, (value) => {
      const entries = (value.entries ?? []).filter((entry) => this.clock() - entry.at < 180000);
      const index = entries.findIndex((entry) => entry.session === input.session_id && entry.type === input.agent_type);
      if (index >= 0) {
        model = entries.splice(index, 1)[0].model;
      }
      // Hold admission until the start is visible, so launches cannot slip
      // between removing the reservation and adding the actual agent.
      updateJson(this.path, (live) => {
        const next = this.prune(live);
        next[input.session_id] ??= {};
        next[input.session_id][input.agent_id] = { startedAt: this.clock(), type: input.agent_type, model };
        return next;
      });
      return { entries };
    });
  }

  stop(input) {
    updateJson(this.path, (value) => {
      const next = this.prune(value);
      if (next[input.session_id]) {
        delete next[input.session_id][input.agent_id];
      }
      return next;
    });
  }
}
