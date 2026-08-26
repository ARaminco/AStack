import { jaccard, uniqueTokens } from "../lib/text.mjs";
import { ExperienceEngine, episodeOutcomes, signatureOf } from "./experience-engine.mjs";
import { DEFAULT_THRESHOLDS, mine } from "./pattern-miner.mjs";
import { SkillForge, skillStatuses } from "./skill-forge.mjs";
import { Reinforcement } from "./reinforcement.mjs";

/**
 * The self learning layer.
 *
 * Work is recorded as episodes, repetition is mined into patterns, patterns
 * become installed skills, and the outcome of every use feeds back into the
 * confidence of those skills. Nothing here needs to be asked for: recording an
 * episode is enough for a skill to appear once the same job has been done
 * often enough, reliably enough, on enough different days.
 */
export class LearningEngine {
  constructor(root, { clock, memory, eventBus, thresholds = {} } = {}) {
    this.root = root;
    this.clock = clock ?? (() => new Date());
    this.memory = memory ?? null;
    this.eventBus = eventBus ?? null;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
    this.experience = new ExperienceEngine(root, { clock: this.clock, memory, eventBus });
    this.forge = new SkillForge(root, { clock: this.clock, memory, eventBus });
    this.reinforcement = new Reinforcement(this.forge, { clock: this.clock, memory, eventBus });
  }

  now() {
    return this.clock().toISOString();
  }

  /**
   * Record one unit of real work. When it completes a repeating pattern the
   * matching skill is forged or refined in the same call.
   */
  record(episode, { autoForge = true } = {}) {
    const recorded = this.experience.record(episode);
    const result = { episode: recorded, forged: null };
    if (!autoForge) {
      return result;
    }
    const candidates = this.candidates({ onlyQualifying: true });
    const match = candidates.find((candidate) => candidate.signatures.includes(recorded.signature));
    if (!match) {
      return result;
    }
    const known = this.forge.exists(match.id) ? this.forge.read(match.id) : null;
    if (known && known.evidence.occurrences === match.occurrences) {
      return result;
    }
    result.forged = this.forge.forge(match, { status: known?.status ?? "draft" });
    return result;
  }

  candidates({ onlyQualifying = false, domain = null, limit = 25 } = {}) {
    const episodes = this.experience.all().filter((episode) => !domain || episode.domain === domain);
    const mined = mine(episodes, this.thresholds);
    return mined
      .filter((candidate) => !onlyQualifying || candidate.qualifies)
      .slice(0, limit)
      .map((candidate) => ({ ...candidate, installed: this.forge.exists(candidate.id) }));
  }

  /**
   * Forge every qualifying pattern that is not installed yet.
   */
  autoForge({ domain = null, status = "draft" } = {}) {
    const forged = [];
    for (const candidate of this.candidates({ onlyQualifying: true, domain, limit: 50 })) {
      const known = this.forge.exists(candidate.id) ? this.forge.read(candidate.id) : null;
      if (known && known.evidence.occurrences >= candidate.occurrences) {
        continue;
      }
      forged.push(this.forge.forge(candidate, { status: known?.status ?? status }));
    }
    return forged;
  }

  forgeById(candidateId, options = {}) {
    const candidate = this.candidates({ limit: 100 }).find((entry) => entry.id === candidateId);
    if (!candidate) {
      throw new Error("Unknown skill candidate: " + candidateId);
    }
    return this.forge.forge(candidate, options);
  }

  skills({ status = null, domain = null } = {}) {
    return this.forge
      .list()
      .filter((skill) => !status || skill.status === status)
      .filter((skill) => !domain || skill.domains.includes(domain));
  }

  /**
   * Which learned skill applies to a task, and how sure are we.
   */
  match(task, { domain = null, limit = 3, minScore = 0.2 } = {}) {
    const tokens = uniqueTokens(task);
    const signature = signatureOf({ task, domain });
    return this.forge
      .list()
      .filter((skill) => skill.status !== "deprecated")
      .filter((skill) => !domain || skill.domains.includes(domain))
      .map((skill) => {
        const overlap = jaccard(tokens, skill.keywords);
        const exact = skill.signatures?.includes(signature.key) ? 0.5 : 0;
        const actionMatch = skill.action === signature.action ? 0.15 : 0;
        const trust = { draft: 0.8, active: 1, trusted: 1.15, candidate: 0.6 }[skill.status] ?? 1;
        return { skill, score: Number(((overlap + exact + actionMatch) * trust * (0.6 + 0.4 * skill.confidence)).toFixed(3)) };
      })
      .filter((entry) => entry.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => ({
        id: entry.skill.id,
        name: entry.skill.name,
        nameFa: entry.skill.nameFa,
        status: entry.skill.status,
        confidence: entry.skill.confidence,
        score: entry.score,
        path: "skills/learned/" + entry.skill.id + "/SKILL.md",
        procedure: entry.skill.procedure
      }));
  }

  feedback(id, options = {}) {
    return this.reinforcement.feedback(id, options);
  }

  setStatus(id, status) {
    return this.forge.setStatus(id, status);
  }

  /**
   * Everything an agent should know before starting a task it may have done
   * before: the matching skill, the last similar runs and the lessons learned.
   */
  brief(task, { domain = null, limit = 3 } = {}) {
    const skills = this.match(task, { domain, limit });
    const similar = this.experience.similar(task, { domain, limit });
    const lessons = this.memory
      ? this.memory.recall({ query: task, facets: ["lesson", "procedural"], domain, limit: 4 })
      : [];
    const lines = [];
    for (const skill of skills) {
      lines.push("- skill " + skill.id + " (" + skill.status + ", conf " + skill.confidence + "): " + skill.path);
    }
    for (const episode of similar) {
      lines.push("- past run " + episode.id + " (" + episode.outcome + ", sim " + episode.similarity + "): " + episode.task.slice(0, 110));
    }
    for (const lesson of lessons) {
      lines.push("- lesson: " + lesson.title);
    }
    return { skills, similar, lessons, lines };
  }

  status() {
    const skills = this.forge.list();
    const byStatus = {};
    for (const status of skillStatuses) {
      byStatus[status] = skills.filter((skill) => skill.status === status).length;
    }
    const candidates = this.candidates({ limit: 50 });
    return {
      episodes: this.experience.stats(),
      skills: skills.length,
      byStatus,
      candidates: candidates.length,
      readyCandidates: candidates.filter((candidate) => candidate.qualifies && !candidate.installed).length,
      thresholds: this.thresholds,
      review: this.reinforcement.review()
    };
  }
}

export { episodeOutcomes, skillStatuses, signatureOf };
