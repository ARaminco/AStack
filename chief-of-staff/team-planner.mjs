import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeText } from "../lib/text.mjs";

const TOKENS_PER_AGENT = 12000;
// Every handoff between two seats costs a structured packet both ways.
const TOKENS_PER_HANDOFF = 1500;

const SPECIALIST_BY_NEED = {
  browse: { role: "browser-operator", department: "operations", reason: "the task reaches an external site" },
  "form-fill": { role: "browser-operator", department: "operations", reason: "a form must be completed on a portal" },
  extract: { role: "document-analyst", department: "documentation", reason: "documents must be read and structured" },
  map: { role: "principal-architect", department: "architecture", reason: "the change touches the codebase structure" },
  schedule: { role: "operations-engineer", department: "operations", reason: "the work must keep running in the background" }
};

/**
 * Capabilities a piece of work can need. A capability is not a person: the
 * planner first decides which capabilities the request needs, then folds them
 * into as few seats as the scale and the risk allow. `fallback` is the role
 * used when the role catalog has no closer specialist.
 */
const CAPABILITIES = {
  architecture: {
    fallback: { role: "principal-architect", department: "architecture" },
    catalog: /architect|ddd|clean-architecture|hexagonal|microservices/,
    expectedOutput: "an architecture note: modules, data model, integrations and the decisions with their trade-offs"
  },
  implementation: {
    fallback: { role: "principal-node-engineer", department: "engineering" },
    catalog: null,
    expectedOutput: "the working change with a short note of what changed and how it was verified"
  },
  testing: {
    fallback: { role: "qa-engineer", department: "qa" },
    catalog: null,
    expectedOutput: "a test plan for the risky paths and the passing test output"
  },
  security: {
    fallback: { role: "security-secure-coding", department: "security" },
    catalog: /^security-/,
    expectedOutput: "a security review: findings by severity with the exact fix for each"
  },
  data: {
    fallback: { role: "database-architect", department: "architecture" },
    catalog: null,
    expectedOutput: "the schema and migrations with indexes and the reasoning behind them"
  },
  operations: {
    fallback: { role: "devops-engineer", department: "devops" },
    catalog: /^devops-|^infrastructure-/,
    expectedOutput: "a deployment plan with backup, health checks and the rollback step"
  },
  content: {
    fallback: { role: "content-content-strategy", department: "content" },
    catalog: /^content-|^seo-/,
    expectedOutput: "the content or SEO deliverable ready for owner review"
  }
};

const SIGNALS = {
  large: /\b(design|architect(ure)?|system|platform|from scratch|marketplace|shop|store|e-?commerce|saas|crm|erp|portal|application|app)\b|طراحی|معماری|سیستم|پلتفرم|فروشگاه|از صفر|سامانه|اپلیکیشن|اپ |پنل|بازارگاه/,
  small: /\b(fix|bug|typo|tweak|rename|bump|small|minor|hotfix|one line)\b|رفع|باگ|اشکال|ایراد|کوچک|جزئی|تغییر کوچک/,
  security: /\b(payment|checkout|gateway|auth|login|signup|password|admin|wallet|user data|personal data|upload|api)\b|پرداخت|درگاه|ورود|ثبت ?نام|احراز|کیف ?پول|امنیت|آپلود|فروشگاه|shop|store|e-?commerce/,
  securityExplicit: /\b(security|secure|owasp|penetration|pentest|vulnerab\w*|xss|csrf|injection)\b|امنیت|امنیتی|نفوذ|آسیب ?پذیری/,
  testing: /\b(test|tests|testing|qa|regression|coverage)\b|تست|آزمون|کیفیت/,
  data: /\b(database|schema|migration|sql|postgres|mysql|reporting|analytics)\b|پایگاه ?داده|دیتابیس|جدول|گزارش ?گیری/,
  operations: /\b(deploy|deployment|server|production|docker|kubernetes|nginx|ci|cd|hosting)\b|استقرار|سرور|هاست|دیپلوی|داکر|انتشار روی/,
  content: /\b(seo|content|copy|landing|blog|article)\b|سئو|محتوا|متن|لندینگ|مقاله|وبلاگ/
};

// Specializations that are also everyday words ("go live", "the rest",
// "database schema") never pick a specialist on their own.
const AMBIGUOUS_SPECIALIZATIONS = new Set(["go", "rest", "c", "net", ".net", "solid", "workers", "automation", "storage", "backup", "routing", "nat", "schema", "storytelling", "dns", "ssl"]);

// Persian spellings of the technologies owners name most often.
const PERSIAN_ALIASES = [
  ["لاراول", "laravel"], ["پی اچ پی", "php"], ["فلاتر", "flutter"], ["ریکت", "react"], ["ری اکت", "react"], ["نکست", "next.js"],
  ["وردپرس", "wordpress"], ["پایتون", "python"], ["جنگو", "django"], ["داکر", "docker"],
  ["کوبرنتیز", "kubernetes"], ["انجین ایکس", "nginx"], ["لینوکس", "linux"], ["کلادفلر", "cloudflare"], ["میکروتیک", "mikrotik"],
  ["سئو", "technical seo"], ["اندروید", "android"], ["آی او اس", "ios"]
];

const ROLE_CATALOG_PATH =join(dirname(fileURLToPath(import.meta.url)), "..", "roles", "enterprise-roles.json");
let roleCatalogCache = null;

function loadRoleCatalog() {
  if (roleCatalogCache) {
    return roleCatalogCache;
  }
  try {
    roleCatalogCache = existsSync(ROLE_CATALOG_PATH) ? JSON.parse(readFileSync(ROLE_CATALOG_PATH, "utf8")).roles ?? [] : [];
  } catch {
    roleCatalogCache = [];
  }
  return roleCatalogCache;
}

/**
 * Just in time team formation, capability first.
 *
 * The default is one agent. A request is read for the capabilities it needs
 * (architecture, implementation, testing, security, data, operations,
 * content) and its scale; the capabilities are then folded into the fewest
 * seats that can deliver them safely:
 *
 * - small or simple work: one specialist covers every capability (solo);
 * - medium work: the specialist plus, when the risk calls for it, an
 *   independent reviewer that is activated only on demand;
 * - large work (a new system, a shop, a platform): separate seats for the
 *   capabilities that cannot share a head — design, build, test, security —
 *   led by a lead who delegates and merges (hierarchical process).
 *
 * Specialists come from the role catalog (219 roles): "Laravel" picks the
 * Laravel engineer, not a generic one. Every seat carries what it must hand
 * back (expected output), whether it is always active or on demand, and its
 * cost; the plan shows the solo cost next to the team cost and why the
 * difference is worth paying. Seats never talk to each other directly: every
 * flow is a structured handoff through the lead and the Chief of Staff.
 */
export class TeamPlanner {
  constructor({ domains = null, teams = null, agents = null, performance = null, roles = null } = {}) {
    this.domains = domains;
    this.teams = teams;
    this.agents = agents;
    this.performance = performance;
    this.roles = roles;
  }

  blueprint(domainId) {
    try {
      return this.domains?.get(domainId)?.blueprint ?? null;
    } catch {
      return null;
    }
  }

  roleCatalog() {
    return this.roles ?? loadRoleCatalog();
  }

  /**
   * Catalog specialists named by the request ("laravel", "flutter", "nginx"),
   * best match first.
   */
  specialists(text) {
    let normalized = " " + normalizeText(text ?? "") + " ";
    for (const [persian, latin] of PERSIAN_ALIASES) {
      if (normalized.includes(normalizeText(persian))) {
        normalized += latin + " ";
      }
    }
    return this.roleCatalog()
      .map((role) => {
        const name = normalizeText(role.specialization ?? "").trim();
        if (!name || name.length < 2 || AMBIGUOUS_SPECIALIZATIONS.has(name)) {
          return null;
        }
        const pattern = new RegExp("(^|[^a-z0-9])" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s.-]?") + "([^a-z0-9]|$)");
        return pattern.test(normalized) ? { role: role.id, department: role.department, title: role.title, length: name.length } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
  }

  /**
   * Which capabilities the request needs, how large it is, and how risky.
   */
  assess(intent) {
    const text = normalizeText(intent.request ?? (intent.tokens ?? []).join(" "));
    const software = intent.domain === "software";
    const building = ["build", "fill"].includes(intent.verb) || (software && intent.verb === "draft");
    const scale = SIGNALS.small.test(text) && !SIGNALS.large.test(text)
      ? "small"
      : building && SIGNALS.large.test(text) && intent.complexity >= 0.3
        ? "large"
        : intent.complexity >= 0.55 ? "medium" : "small";
    const capabilities = [];
    const add = (id, reason, activation = "always") => {
      if (!capabilities.some((entry) => entry.id === id)) {
        capabilities.push({ id, reason, activation });
      }
    };
    if (software && building) {
      add("implementation", "the request builds or changes software");
      if (scale === "large") {
        add("architecture", "a new system needs its structure decided before it is built");
        add("testing", "a new system needs its risky paths tested independently");
      } else if (SIGNALS.testing.test(text)) {
        add("testing", "the request asks for tests");
      }
      if (SIGNALS.securityExplicit.test(text)) {
        add("security", "the request asks for security work");
      } else if (SIGNALS.security.test(text)) {
        add("security", "the work touches payments, sign-in or user data", scale === "large" ? "always" : "on-demand");
      }
      if (SIGNALS.data.test(text)) {
        add("data", "the data model is part of the request", scale === "large" ? "always" : "on-demand");
      }
      if (SIGNALS.operations.test(text)) {
        add("operations", "the result has to be deployed or run on a server");
      }
      if (SIGNALS.content.test(text)) {
        add("content", "the request includes content or SEO");
      }
    } else if (software && SIGNALS.securityExplicit.test(text)) {
      add("security", "the request is a security review");
    }
    return { scale, software, building, capabilities };
  }

  /**
   * Decide the smallest team that can deliver the intent.
   */
  plan(intent, { maxAgents = 6, forceTeam = false } = {}) {
    const domainId = intent.domain ?? "business";
    const blueprint = this.blueprint(domainId);
    const assessment = this.assess(intent);
    if (assessment.software && assessment.capabilities.length) {
      return this.capabilityPlan(intent, { domainId, blueprint, assessment, maxAgents, forceTeam });
    }
    return this.classicPlan(intent, { domainId, blueprint, assessment, maxAgents, forceTeam });
  }

  /**
   * Software work: capabilities folded into the fewest seats.
   */
  capabilityPlan(intent, { domainId, blueprint, assessment, maxAgents, forceTeam }) {
    const { scale, capabilities } = assessment;
    const named = this.specialists(intent.request ?? "");
    const rationale = [];
    const engineer = named.find((entry) => ["engineering", "mobile", "ai"].includes(entry.department))
      ?? blueprint?.members?.find((member) => /engineer|developer/.test(member.role) && !/qa|test/.test(member.role))
      ?? CAPABILITIES.implementation.fallback;
    const pick = (capability) => {
      const spec = CAPABILITIES[capability];
      if (capability === "implementation") {
        return engineer;
      }
      const fromRequest = spec.catalog ? named.find((entry) => spec.catalog.test(entry.role)) : null;
      const fromBlueprint = blueprint?.members?.find((member) =>
        (capability === "testing" && /qa|test/.test(member.role)) ||
        (capability === "architecture" && /architect/.test(member.role)) ||
        (capability === "operations" && /devops|docker|operations/.test(member.role)));
      return fromRequest ?? fromBlueprint ?? spec.fallback;
    };

    const seats = [];
    const onDemand = [];
    const always = capabilities.filter((entry) => entry.activation === "always");
    const solo = !forceTeam && (scale === "small" || intent.complexity < 0.3) && !["L4", "L5"].includes(intent.authority);

    if (solo) {
      // One specialist covers everything that can share a head.
      seats.push({ ...engineer, purpose: "deliver the change end to end", primary: true, covers: always.map((entry) => entry.id) });
      rationale.push("کار کوچک است؛ یک متخصص (" + engineer.role + ") همهٔ بخش‌ها را انجام می‌دهد و تیم تشکیل نمی‌شود.");
    } else {
      // Separate heads only where separation is the point: whoever designs
      // is not whoever builds a large system, and whoever builds never tests
      // or security-reviews their own work.
      const separate = scale === "large" ? ["architecture", "implementation", "testing", "security", "operations", "content"] : ["implementation", "security", "operations", "content"];
      const foldTarget = { architecture: "implementation", testing: "implementation", data: scale === "large" ? "architecture" : "implementation" };
      for (const entry of always) {
        if (separate.includes(entry.id)) {
          const role = pick(entry.id);
          const existing = seats.find((seat) => seat.role === role.role);
          if (existing) {
            existing.covers.push(entry.id);
          } else {
            seats.push({ ...role, purpose: entry.reason, covers: [entry.id] });
          }
        }
      }
      for (const entry of always) {
        if (separate.includes(entry.id)) {
          continue;
        }
        const target = seats.find((seat) => seat.covers.includes(foldTarget[entry.id] ?? "implementation")) ?? seats[0];
        target?.covers.push(entry.id);
        rationale.push("بخش «" + entry.id + "» به " + (target?.role ?? engineer.role) + " سپرده شد؛ نفر جدا لازم نیست.");
      }
      if (!seats.length) {
        seats.push({ ...engineer, purpose: "deliver the change end to end", covers: ["implementation"] });
      }
      seats.sort((a, b) => stageOrder(a.covers) - stageOrder(b.covers));
      seats[0].primary = true;
      const architect = seats.find((seat) => seat.covers.includes("architecture"));
      if (seats.length >= 3 && architect) {
        // The architect already holds the whole picture, so it leads: one
        // seat fewer than a separate manager.
        architect.lead = true;
        architect.purpose = "decide the structure, delegate the work and merge the handoffs";
        architect.covers.push("coordination");
        rationale.push("کار بزرگ است (" + scale + ")؛ " + seats.length + " بخش مستقل دارد و معمار، راهبر تیم هم هست (نفر اضافه برای مدیریت لازم نیست).");
      } else if (seats.length >= 3) {
        const lead = blueprint?.lead ?? { role: "program-manager", department: "delivery" };
        seats.unshift({ ...lead, purpose: "own the outcome, delegate the work and merge the handoffs", lead: true, covers: ["coordination"] });
        rationale.push("کار بزرگ است (" + scale + ")؛ " + (seats.length - 1) + " بخش مستقل دارد، پس یک راهبر کار را تقسیم و نتیجه را یکپارچه می‌کند.");
      } else if (seats.length === 2) {
        rationale.push("دو بخش مستقل لازم است؛ کار زنجیره‌ای پیش می‌رود و راهبر جدا لازم نیست.");
      } else {
        rationale.push("یک متخصص (" + seats[0].role + ") کافی است.");
      }
    }

    for (const entry of capabilities.filter((item) => item.activation === "on-demand")) {
      const role = pick(entry.id);
      if (seats.some((seat) => seat.role === role.role) || onDemand.some((seat) => seat.role === role.role)) {
        continue;
      }
      onDemand.push({ ...role, purpose: entry.reason, covers: [entry.id], trigger: triggerFor(entry.id) });
      rationale.push("«" + role.role + "» فقط در صورت نیاز فعال می‌شود: " + triggerFor(entry.id));
    }
    if (["L4", "L5"].includes(intent.authority) && !seats.some((seat) => /review|security|qa|compliance/.test(seat.role))) {
      const reviewer = { role: "qa-engineer", department: "qa" };
      seats.push({ ...reviewer, purpose: "verify independently before an irreversible action", covers: ["review"] });
      rationale.push("اقدام غیرقابل‌بازگشت است؛ یک بازبین مستقل قبل از ثبت اضافه شد.");
    }

    return this.finish(intent, { domainId, seats: seats.slice(0, maxAgents), onDemand, rationale, scale, capabilities });
  }

  /**
   * Every other domain: a lead and the domain's core role when the work is
   * multi-step, specialists for unavoidable needs, a reviewer for anything
   * irreversible.
   */
  classicPlan(intent, { domainId, blueprint, assessment, maxAgents, forceTeam }) {
    const seats = [];
    const onDemand = [];
    const rationale = [];
    const lead = blueprint?.lead ?? { role: "program-manager", department: "delivery" };
    const named = this.specialists(intent.request ?? "").filter((entry) => !["engineering", "mobile"].includes(entry.department) || intent.domain === "software");
    const analystRole = named[0] ?? blueprint?.members?.[0] ?? { role: "analyst", department: "research" };

    if (intent.complexity < 0.3 && !forceTeam && !intent.externalAction) {
      seats.push({ ...analystRole, purpose: "answer the request end to end", primary: true });
      rationale.push("درخواست ساده است؛ یک متخصص کافی است.");
    } else {
      seats.push({ ...lead, purpose: "own the outcome and review the result", primary: true, lead: true });
      rationale.push("کار چند مرحله‌ای است؛ یک راهبر برای بازبینی خروجی لازم است.");
      seats.push({ ...analystRole, purpose: "do the core work of the domain" });
    }

    for (const need of intent.needs ?? []) {
      const specialist = SPECIALIST_BY_NEED[need];
      if (!specialist) {
        continue;
      }
      const unavoidable = ["browse", "form-fill"].includes(need);
      if (!unavoidable && intent.complexity < 0.3) {
        continue;
      }
      if (seats.some((seat) => seat.role === specialist.role)) {
        continue;
      }
      if (seats.length >= maxAgents) {
        break;
      }
      seats.push({ role: specialist.role, department: specialist.department, purpose: specialist.reason });
      rationale.push("افزودن " + specialist.role + ": " + specialist.reason);
    }

    if (["L4"].includes(intent.authority) && seats.length < maxAgents && !seats.some((seat) => /review|compliance|counsel/.test(seat.role))) {
      const reviewer = blueprint?.members?.find((member) => /review|counsel|audit|qa|compliance/.test(member.role))
        ?? { role: "compliance-reviewer", department: "legal" };
      seats.push({ ...reviewer, purpose: "verify before an irreversible action" });
      rationale.push("اقدام غیرقابل‌بازگشت است؛ یک بازبین قبل از ثبت اضافه شد.");
    } else if (["legal", "tax", "finance", "accounting"].includes(intent.domain) && ["draft", "build"].includes(intent.verb) && !seats.slice(1).some((seat) => /review|compliance|audit/.test(seat.role))) {
      // Accuracy-critical drafts get a reviewer, but only when the draft is
      // about to leave the system: it waits on demand until then. The
      // reviewer is never the seat that wrote the draft.
      const reviewer = blueprint?.members?.find((member) => /review|audit|compliance/.test(member.role) && !seats.some((seat) => seat.role === member.role))
        ?? { role: "compliance-reviewer", department: "legal" };
      onDemand.push({ ...reviewer, purpose: "re-check figures and wording before the draft is sent", trigger: "before the draft leaves the system (send, file or publish)" });
      rationale.push("پیش‌نویس حساس است؛ بازبین فقط پیش از ارسال فعال می‌شود.");
    }

    if (intent.complexity > 0.75 && blueprint?.members?.length && seats.length < maxAgents) {
      for (const member of blueprint.members) {
        if (seats.length >= maxAgents) {
          break;
        }
        if (!seats.some((seat) => seat.role === member.role)) {
          seats.push({ ...member, purpose: "specialist depth for a complex engagement" });
        }
      }
      rationale.push("پیچیدگی بالاست؛ تیم تا اندازه نقشه دامنه گسترش یافت.");
    }
    return this.finish(intent, { domainId, seats, onDemand, rationale, scale: assessment.scale, capabilities: assessment.capabilities });
  }

  /**
   * Costs, process, delegation flows and the final plan shape.
   */
  finish(intent, { domainId, seats, onDemand, rationale, scale, capabilities }) {
    const perSeat = Math.round(TOKENS_PER_AGENT * (0.6 + intent.complexity));
    const process = seats.length <= 1 ? "solo" : seats.some((seat) => seat.lead) ? "hierarchical" : "sequential";
    const lead = seats.find((seat) => seat.lead) ?? null;
    const workers = seats.filter((seat) => !seat.lead);
    const flows = process === "hierarchical"
      ? workers.flatMap((seat) => [
          { from: lead.role, to: seat.role, kind: "delegate", carries: "task, inputs and expected output" },
          { from: seat.role, to: lead.role, kind: "handoff", carries: "done, findings, artifacts, open questions" }
        ])
      : process === "sequential"
        ? workers.slice(1).map((seat, index) => ({ from: workers[index].role, to: seat.role, kind: "handoff", carries: "the previous seat's artifacts and open questions" }))
        : [];
    const handoffTokens = flows.length * TOKENS_PER_HANDOFF;
    const estimatedTokens = seats.length * perSeat + handoffTokens;
    // One person doing every always-needed part, sequentially.
    const alwaysNeeded = (capabilities ?? []).filter((entry) => entry.activation !== "on-demand").length;
    const soloEstimatedTokens = seats.length <= 1 ? seats.length * perSeat + handoffTokens : Math.round(perSeat * (1 + 0.35 * Math.max(0, alwaysNeeded - 1)));
    if (seats.length > 1) {
      rationale.push(
        "هزینهٔ تیم حدود " + estimatedTokens + " توکن در برابر " + soloEstimatedTokens +
        " توکن برای یک نفر؛ تفاوت بابت جداسازی طراحی، ساخت و بازبینی پرداخت می‌شود."
      );
    }
    return {
      domain: domainId,
      size: seats.length,
      scale,
      process,
      seats: seats.map((seat, index) => ({
        order: index + 1,
        role: seat.role,
        department: seat.department ?? null,
        lead: Boolean(seat.lead),
        purpose: seat.purpose,
        covers: seat.covers ?? [],
        expectedOutput: expectedOutput(seat),
        activation: "always",
        allowDelegation: Boolean(seat.lead),
        historicalReliability: this.reliability(seat.role)
      })),
      onDemand: onDemand.map((seat) => ({
        role: seat.role,
        department: seat.department ?? null,
        purpose: seat.purpose,
        covers: seat.covers ?? [],
        trigger: seat.trigger,
        expectedOutput: expectedOutput(seat),
        activation: "on-demand",
        estimatedTokens: perSeat
      })),
      flows,
      coordination: "seats never talk directly; every delegation and handoff is a structured packet through " + (lead ? lead.role + " and " : "") + "the Chief of Staff",
      capabilities: (capabilities ?? []).map((entry) => entry.id),
      estimatedTokens,
      soloEstimatedTokens,
      estimatedCostClass: estimatedTokens > 90000 ? "high" : estimatedTokens > 40000 ? "medium" : "low",
      rationale
    };
  }

  reliability(role) {
    const stats = this.performance?.[role];
    if (!stats) {
      return null;
    }
    return { runs: stats.runs, successRate: stats.successRate };
  }

  /**
   * Bring an on-demand seat into the plan when its trigger fires (a failed
   * check, a change that touches payments, a draft about to be sent).
   */
  escalate(plan, role, { reason = null } = {}) {
    const seat = plan.onDemand?.find((entry) => entry.role === role);
    if (!seat) {
      throw new Error("No on-demand seat " + role + " in this plan");
    }
    const seats = [...plan.seats, { ...seat, order: plan.seats.length + 1, lead: false, activation: "always", allowDelegation: false, historicalReliability: this.reliability(role), escalatedBecause: reason ?? seat.trigger }];
    const perSeat = seat.estimatedTokens ?? TOKENS_PER_AGENT;
    return {
      ...plan,
      size: seats.length,
      seats,
      onDemand: plan.onDemand.filter((entry) => entry.role !== role),
      estimatedTokens: plan.estimatedTokens + perSeat + 2 * TOKENS_PER_HANDOFF,
      rationale: [...plan.rationale, "«" + role + "» فعال شد: " + (reason ?? seat.trigger)]
    };
  }

  /**
   * Materialize the plan as a real team with one agent per always-active
   * seat. On-demand seats stay in the plan and cost nothing until escalated.
   */
  form(plan, { goal, name = null }) {
    if (!this.teams || !this.agents) {
      throw new Error("Team formation needs the team and agent engines");
    }
    const team = this.teams.create({
      name: name ?? plan.domain + "-jit-team",
      domain: plan.domain,
      mission: goal
    });
    const created = [];
    for (const seat of plan.seats) {
      if (!team.members.some((member) => member.role === seat.role)) {
        this.teams.addMember(team.id, { role: seat.role, department: seat.department, lead: seat.lead });
      }
      const agent = this.agents.create({
        name: seat.role + "-" + team.id,
        role: seat.role,
        department: seat.department,
        team: team.id,
        mission: goal + " — " + seat.purpose + (seat.expectedOutput ? " Expected output: " + seat.expectedOutput + "." : "")
      });
      this.teams.linkAgent(team.id, seat.role, agent.id);
      created.push(agent);
    }
    for (const member of this.teams.get(team.id).members) {
      if (!member.agent) {
        this.teams.removeMember(team.id, member.role);
      }
    }
    this.teams.setStatus(team.id, "active");
    return { team: this.teams.get(team.id), agents: created, onDemand: plan.onDemand ?? [] };
  }
}

function stageOrder(covers = []) {
  const order = ["architecture", "data", "implementation", "content", "testing", "security", "operations", "review"];
  return Math.min(...covers.map((entry) => (order.includes(entry) ? order.indexOf(entry) : order.length)), order.length);
}

function triggerFor(capability) {
  return {
    security: "when the change touches sign-in, payments, uploads or personal data, and always before release",
    data: "when the change needs a new table, a migration or a heavy query",
    testing: "when a check fails or the change reaches a shared path",
    operations: "when the change has to be deployed"
  }[capability] ?? "when the lead asks for it";
}

function expectedOutput(seat) {
  if (seat.lead && !(seat.covers ?? []).some((entry) => CAPABILITIES[entry])) {
    return "one merged result for the owner, with every seat's handoff checked";
  }
  const covers = seat.covers ?? [];
  if (covers.length) {
    return covers.map((entry) => CAPABILITIES[entry]?.expectedOutput ?? (entry === "review" ? "an independent check of the result before it is committed" : null)).filter(Boolean).join("; ");
  }
  return seat.purpose ?? null;
}

export { TOKENS_PER_AGENT, TOKENS_PER_HANDOFF, SPECIALIST_BY_NEED, CAPABILITIES };
