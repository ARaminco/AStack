import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jaccard, redactSecrets, shortHash, uniqueTokens } from "../lib/text.mjs";

export const episodeOutcomes = ["done", "failed", "partial", "abandoned"];

const ACTION_VERBS = new Map([
  ["review", "review"], ["بازبینی", "review"], ["بررسی", "review"],
  ["build", "build"], ["ساخت", "build"], ["بساز", "build"], ["create", "build"], ["ایجاد", "build"],
  ["fix", "fix"], ["رفع", "fix"], ["اصلاح", "fix"], ["debug", "fix"], ["باگ", "fix"],
  ["report", "report"], ["گزارش", "report"], ["summary", "report"], ["خلاصه", "report"],
  ["file", "file"], ["بایگانی", "file"], ["archive", "file"], ["ثبت", "file"],
  ["analyze", "analyze"], ["تحلیل", "analyze"], ["audit", "analyze"], ["حسابرسی", "analyze"],
  ["extract", "extract"], ["استخراج", "extract"], ["ocr", "extract"], ["transcribe", "extract"],
  ["close", "close"], ["بستن", "close"], ["reconcile", "close"], ["مغایرت", "close"],
  ["draft", "draft"], ["نگارش", "draft"], ["تنظیم", "draft"], ["لایحه", "draft"],
  ["deploy", "deploy"], ["استقرار", "deploy"], ["release", "deploy"], ["انتشار", "deploy"],
  ["monitor", "monitor"], ["پایش", "monitor"], ["check", "monitor"], ["چک", "monitor"]
]);

export function classifyAction(task) {
  for (const token of uniqueTokens(task)) {
    const verb = ACTION_VERBS.get(token);
    if (verb) {
      return verb;
    }
  }
  return "handle";
}

/**
 * The signature is what makes repetition visible: the same practice, the same
 * kind of action and the same tool chain collapse to one key even when the
 * wording, the file names and the dates differ every time.
 */
export function signatureOf(episode) {
  const tokens = uniqueTokens(episode.task ?? "")
    .filter((token) => !/^[0-9]+$/.test(token))
    .slice(0, 10)
    .sort();
  const action = classifyAction(episode.task ?? "");
  const tools = [...new Set(episode.tools ?? (episode.steps ?? []).map((step) => step.tool).filter(Boolean))].sort();
  const domain = episode.domain ?? "general";
  return {
    key: shortHash(domain, action, tokens.slice(0, 6).join(" "), tools.join(">")),
    domain,
    action,
    tokens,
    tools
  };
}

/**
 * Episodic memory for work that actually happened. Every recorded episode is
 * evidence: it feeds pattern mining, calibration and the skill forge.
 */
export class ExperienceEngine {
  constructor(root, { clock, memory, eventBus } = {}) {
    this.root = root;
    this.directory = join(root, ".astack", "learning");
    this.path = join(this.directory, "episodes.jsonl");
    this.clock = clock ?? (() => new Date());
    this.memory = memory ?? null;
    this.eventBus = eventBus ?? null;
  }

  now() {
    return this.clock().toISOString();
  }

  all() {
    if (!existsSync(this.path)) {
      return [];
    }
    const merged = new Map();
    for (const line of readFileSync(this.path, "utf8").split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const record = JSON.parse(line);
        if (record.id) {
          merged.set(record.id, record);
        }
      } catch {
        continue;
      }
    }
    return [...merged.values()];
  }

  list({ domain = null, since = null, outcome = null, limit = 100 } = {}) {
    return this.all()
      .filter((episode) => !domain || episode.domain === domain)
      .filter((episode) => !outcome || episode.outcome === outcome)
      .filter((episode) => !since || new Date(episode.at).getTime() >= new Date(since).getTime())
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .slice(0, limit);
  }

  get(id) {
    return this.all().find((episode) => episode.id === id) ?? null;
  }

  record(input = {}) {
    const task = String(input.task ?? "").trim();
    if (!task) {
      throw new Error("An episode needs a task description");
    }
    if (input.outcome && !episodeOutcomes.includes(input.outcome)) {
      throw new Error("Unknown outcome: " + input.outcome + ". Use: " + episodeOutcomes.join(", "));
    }
    const at = input.at ?? this.now();
    const steps = (input.steps ?? []).map((step, position) => ({
      order: position + 1,
      action: String(step.action ?? step).slice(0, 160),
      tool: step.tool ?? null,
      target: step.target ? redactSecrets(String(step.target)).slice(0, 160) : null
    }));
    const signature = signatureOf({ ...input, task, steps });
    const episode = {
      id: "E-" + shortHash(at, task, signature.key).slice(0, 10),
      at,
      task: redactSecrets(task).slice(0, 400),
      domain: input.domain ?? signature.domain,
      workflow: input.workflow ?? null,
      project: input.project ?? null,
      agent: input.agent ?? null,
      team: input.team ?? null,
      skill: input.skill ?? null,
      steps,
      tools: signature.tools,
      inputs: (input.inputs ?? []).map((value) => redactSecrets(String(value)).slice(0, 200)),
      artifacts: (input.artifacts ?? []).map((value) => String(value).slice(0, 200)),
      outcome: input.outcome ?? "done",
      durationMs: Number(input.durationMs ?? 0),
      tokens: Number(input.tokens ?? 0),
      reviewer: input.reviewer ?? null,
      notes: input.notes ? redactSecrets(String(input.notes)).slice(0, 600) : null,
      signature: signature.key,
      action: signature.action,
      tokensOfTask: signature.tokens
    };
    mkdirSync(this.directory, { recursive: true });
    appendFileSync(this.path, JSON.stringify(episode) + "\n", "utf8");
    this.memory?.facets?.append("episodic", {
      at,
      title: episode.action + ": " + episode.task.slice(0, 120),
      body: [episode.notes, steps.map((step) => step.action).join(" -> ")].filter(Boolean).join("\n"),
      domain: episode.domain,
      project: episode.project,
      tags: ["episode", episode.outcome, ...(episode.tools ?? []).slice(0, 4)],
      refs: [episode.id],
      confidence: episode.outcome === "done" ? 0.7 : 0.4,
      source: "experience-engine"
    });
    this.eventBus?.emit("experience.recorded", { id: episode.id, signature: episode.signature, outcome: episode.outcome });
    return episode;
  }

  /**
   * Episodes that look like the given task, used to prime an agent with what
   * worked last time before it starts.
   */
  similar(task, { limit = 5, domain = null, minScore = 0.25 } = {}) {
    const tokens = uniqueTokens(task);
    return this.all()
      .filter((episode) => !domain || episode.domain === domain)
      .map((episode) => ({ episode, score: jaccard(tokens, episode.tokensOfTask ?? uniqueTokens(episode.task)) }))
      .filter((entry) => entry.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => ({ ...entry.episode, similarity: Number(entry.score.toFixed(3)) }));
  }

  stats() {
    const episodes = this.all();
    const byDomain = {};
    const bySignature = {};
    for (const episode of episodes) {
      byDomain[episode.domain] = (byDomain[episode.domain] ?? 0) + 1;
      bySignature[episode.signature] = (bySignature[episode.signature] ?? 0) + 1;
    }
    const successes = episodes.filter((episode) => episode.outcome === "done").length;
    return {
      episodes: episodes.length,
      successRate: episodes.length ? Number((successes / episodes.length).toFixed(3)) : 0,
      totalDurationMs: episodes.reduce((sum, episode) => sum + episode.durationMs, 0),
      totalTokens: episodes.reduce((sum, episode) => sum + episode.tokens, 0),
      distinctSignatures: Object.keys(bySignature).length,
      byDomain
    };
  }

  compact({ keep = 5000 } = {}) {
    const episodes = this.all().sort((a, b) => new Date(a.at) - new Date(b.at)).slice(-keep);
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(this.path, episodes.map((episode) => JSON.stringify(episode)).join("\n") + (episodes.length ? "\n" : ""), "utf8");
    return episodes.length;
  }
}
