import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "../lib/text.mjs";

const DEFAULT_PROFILE = {
  name: null,
  languages: { conversation: "fa", assets: "en" },
  responseStyle: "concise",
  timezone: null,
  companies: [],
  activeProjects: [],
  recurringWorkflows: [],
  preferences: [],
  workingHours: null,
  decisionStyle: null,
  doNotStore: ["passwords", "otp", "card numbers", "national id numbers"],
  updatedAt: null
};

/**
 * The owner model.
 *
 * A compact, non sensitive picture of who the owner is and how they work,
 * rendered into an identity capsule that starts every session for a few
 * hundred tokens instead of a replayed history. Preferences learned from real
 * interactions are added here explicitly, never inferred silently from content
 * the owner asked not to store.
 */
export class OwnerModel {
  constructor(root, { clock, memory = null, graph = null, projects = null } = {}) {
    this.root = root;
    this.path = join(root, ".astack", "owner", "profile.json");
    this.clock = clock ?? (() => new Date());
    this.memory = memory;
    this.graph = graph;
    this.projects = projects;
  }

  now() {
    return this.clock().toISOString();
  }

  read() {
    if (!existsSync(this.path)) {
      return { ...DEFAULT_PROFILE };
    }
    try {
      return { ...DEFAULT_PROFILE, ...JSON.parse(readFileSync(this.path, "utf8")) };
    } catch {
      return { ...DEFAULT_PROFILE };
    }
  }

  save(profile) {
    mkdirSync(join(this.root, ".astack", "owner"), { recursive: true });
    const next = { ...profile, updatedAt: this.now() };
    writeFileSync(this.path, JSON.stringify(next, null, 2) + "\n", "utf8");
    return next;
  }

  update(patch = {}) {
    const profile = this.read();
    const next = { ...profile, ...patch };
    for (const key of ["companies", "activeProjects", "recurringWorkflows", "preferences"]) {
      if (patch[key]) {
        next[key] = [...new Set([...(profile[key] ?? []), ...patch[key]])];
      }
    }
    return this.save(next);
  }

  /**
   * Record a preference the owner actually expressed, with its evidence.
   */
  learnPreference(text, { evidence = null, confidence = 0.7 } = {}) {
    const profile = this.read();
    const entry = String(text).slice(0, 200);
    if (!profile.preferences.includes(entry)) {
      profile.preferences.push(entry);
      this.save(profile);
    }
    this.memory?.remember?.("preference", {
      title: entry,
      body: evidence ? "evidence: " + evidence : "",
      tags: ["preference", "owner"],
      confidence,
      importance: 0.8,
      source: "owner-model"
    });
    return entry;
  }

  /**
   * The identity capsule: the few hundred tokens that start a session.
   */
  capsule({ budget = 800 } = {}) {
    const profile = this.read();
    const lines = [];
    const push = (line) => {
      if (line) {
        lines.push(line);
      }
    };
    push(profile.name ? "- owner: " + profile.name : null);
    push("- language: owner-facing " + profile.languages.conversation + ", assets " + profile.languages.assets);
    push(profile.responseStyle ? "- response style: " + profile.responseStyle : null);
    push(profile.timezone ? "- timezone: " + profile.timezone : null);
    if (profile.companies.length) {
      push("- companies: " + profile.companies.slice(0, 6).join(", "));
    }
    const active = this.activeProjects();
    if (active.length) {
      push("- active projects: " + active.slice(0, 5).map((project) => project.name + " (" + project.phase + ")").join(", "));
    }
    if (profile.recurringWorkflows.length) {
      push("- recurring work: " + profile.recurringWorkflows.slice(0, 5).join(", "));
    }
    for (const preference of profile.preferences.slice(0, 6)) {
      push("- preference: " + preference);
    }
    const memoryPreferences = this.memory?.recall({ facets: ["preference", "identity"], limit: 6 }) ?? [];
    for (const record of memoryPreferences) {
      const line = "- " + record.facet + ": " + record.title;
      if (!lines.includes(line)) {
        push(line);
      }
    }
    push("- never store: " + profile.doNotStore.join(", "));
    const trimmed = [];
    let tokens = 0;
    for (const line of lines) {
      const cost = estimateTokens(line);
      if (tokens + cost > budget) {
        break;
      }
      tokens += cost;
      trimmed.push(line);
    }
    return { lines: trimmed, tokens, budget, updatedAt: profile.updatedAt };
  }

  activeProjects() {
    try {
      return (this.projects?.list() ?? []).filter((project) => project.phase !== "closed").slice(0, 8);
    } catch {
      return [];
    }
  }

  /**
   * A conversation summary, stored as structured memory rather than raw text.
   */
  summarizeConversation({
    summary,
    decisions = [],
    newFacts = [],
    changedFacts = [],
    entities = [],
    tasks = [],
    preferences = [],
    openQuestions = [],
    domain = null,
    project = null
  }) {
    const stored = [];
    if (summary) {
      stored.push(this.memory?.remember?.("episodic", {
        title: "conversation: " + String(summary).slice(0, 120),
        body: String(summary).slice(0, 1200),
        domain,
        project,
        tags: ["conversation"],
        entities,
        importance: 0.6,
        source: "conversation-summary"
      }));
    }
    for (const decision of decisions) {
      stored.push(this.memory?.remember?.("decision", {
        title: String(decision.title ?? decision).slice(0, 140),
        body: String(decision.reason ?? "").slice(0, 600),
        domain,
        project,
        tags: ["decision"],
        entities,
        importance: 0.85,
        confidence: 0.8,
        source: "conversation-summary"
      }));
    }
    for (const fact of newFacts) {
      stored.push(this.memory?.remember?.("semantic", {
        title: String(fact.title ?? fact).slice(0, 140),
        body: String(fact.body ?? "").slice(0, 600),
        subject: fact.subject ?? null,
        predicate: fact.predicate ?? null,
        object: fact.object ?? null,
        domain,
        project,
        entities,
        confidence: fact.confidence ?? 0.7,
        source: "conversation-summary"
      }));
    }
    for (const change of changedFacts) {
      if (change.supersedes && this.memory?.facets) {
        stored.push(this.memory.facets.supersede(change.supersedes, {
          facet: change.facet ?? "semantic",
          title: change.title,
          body: change.body ?? "",
          subject: change.subject ?? null,
          predicate: change.predicate ?? null,
          object: change.object ?? null,
          domain,
          project,
          source: "conversation-summary"
        }).replacement);
      }
    }
    for (const question of openQuestions) {
      stored.push(this.memory?.remember?.("working", {
        title: "open question: " + String(question).slice(0, 140),
        domain,
        project,
        tags: ["open-question"],
        importance: 0.7,
        source: "conversation-summary"
      }));
    }
    for (const preference of preferences) {
      this.learnPreference(preference, { evidence: "conversation" });
    }
    for (const task of tasks) {
      stored.push(this.memory?.remember?.("project", {
        title: "task: " + String(task).slice(0, 140),
        domain,
        project,
        tags: ["task"],
        importance: 0.7,
        source: "conversation-summary"
      }));
    }
    return { stored: stored.filter(Boolean).length };
  }
}

export { DEFAULT_PROFILE };
