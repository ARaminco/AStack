export class Orchestrator {
  constructor({ departments, providers, workflows, memory, eventBus, projects, domains, teams, agents, missions, approvals, scheduler, learning, context }) {
    this.departments = departments;
    this.providers = providers;
    this.workflows = workflows;
    this.memory = memory;
    this.eventBus = eventBus;
    this.projects = projects ?? null;
    this.domains = domains ?? null;
    this.teams = teams ?? null;
    this.agents = agents ?? null;
    this.missions = missions ?? null;
    this.approvals = approvals ?? null;
    this.scheduler = scheduler ?? null;
    this.learning = learning ?? null;
    this.context = context ?? null;
  }

  analyzeIntent(input) {
    const text = String(input || "").toLowerCase();
    const domain = this.domains?.detect(text) ?? null;
    const scored = this.departments
      .map((department) => {
        const haystack = [department.id, department.name, ...(department.roles ?? [])].join(" ").toLowerCase();
        const tokens = [...new Set(haystack.split(/[-\s]+/))].filter((token) => token.length > 2);
        return { department, score: tokens.filter((token) => text.includes(token)).length };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.department.id.localeCompare(b.department.id));
    const domainDepartments = domain
      ? domain.departments.map((id) => this.departments.find((department) => department.id === id)).filter(Boolean)
      : [];
    const merged = dedupeById([
      ...scored.slice(0, 5).map((entry) => entry.department).filter((department) => !domain || domain.departments.includes(department.id)),
      ...domainDepartments,
      ...scored.slice(0, 2).map((entry) => entry.department)
    ]).slice(0, 6);
    const departments = merged.length
      ? merged
      : this.departments.filter((department) => ["business", "research", "documentation"].includes(department.id));
    const keywordWorkflow = this.workflows.selectStrict ? this.workflows.selectStrict(text) : this.workflows.select(text);
    const workflow = keywordWorkflow
      ?? (domain && this.workflows.byId ? this.workflows.byId(domain.workflow) : null)
      ?? this.workflows.select(text || "review");
    return {
      summary: input || "درخواست عمومی برای بازبینی Enterprise",
      domain,
      departments,
      workflow
    };
  }

  activeProjectBriefing() {
    if (!this.projects) {
      return [];
    }
    try {
      const open = this.projects.list().filter((project) => project.phase !== "closed");
      if (!open.length) {
        return [];
      }
      const current = open.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
      const status = this.projects.status(current.id);
      const ragNames = { green: "سبز", amber: "زرد", red: "قرمز" };
      const phaseNames = { initiation: "آغاز", planning: "برنامه‌ریزی", execution: "اجرا", closing: "اختتام", closed: "بسته‌شده" };
      const lines = [
        "پروژه فعال: " + current.name + " — سلامت " + status.health.score + " از 100 (" + (ragNames[status.health.rag] ?? status.health.rag) + ")، فاز " + (phaseNames[current.phase] ?? current.phase)
      ];
      const action = status.nextActions[0];
      if (action) {
        lines.push("اقدام بعدی پیشنهادی برای پروژه: " + action.code + (action.params.itemId ? " " + action.params.itemId : "") + (action.params.title ? " (" + action.params.title + ")" : ""));
      }
      return lines;
    } catch {
      return [];
    }
  }

  leadershipBriefing() {
    const lines = [];
    try {
      const teams = this.teams?.list().filter((team) => team.status === "active") ?? [];
      if (teams.length) {
        lines.push("تیم‌های فعال: " + teams.map((team) => team.name + " (" + team.domain + ")").join("، "));
      }
      const due = this.agents?.due().length ?? 0;
      if (due) {
        lines.push("مأموریت‌های سررسیدشده ایجنت‌ها: " + due + " مورد آماده اجرا — دستور: astack agent run-due");
      }
      const awaiting = this.agents?.openRuns().length ?? 0;
      if (awaiting) {
        lines.push("خروجی‌های در انتظار بازبینی رهبر: " + awaiting + " مورد — دستور: astack lead review");
      }
    } catch {
      return lines;
    }
    return lines;
  }

  /**
   * What the autonomy layer is holding right now: work already retrieved for
   * this request, missions in flight, decisions waiting for the owner and
   * background jobs that need attention.
   */
  autonomyBriefing(input) {
    const lines = [];
    try {
      const skills = this.learning?.match(input ?? "", { limit: 2 }) ?? [];
      if (skills.length) {
        lines.push("مهارت آموخته‌شده مرتبط: " + skills.map((skill) => skill.id + " (" + skill.status + ")").join("، ") + " — دستور: astack skill show " + skills[0].id);
      }
      const waiting = this.approvals?.pending() ?? [];
      if (waiting.length) {
        lines.push("در انتظار تصمیم شما: " + waiting.length + " مورد — دستور: astack approval pending");
      }
      const missionStatus = this.missions?.status() ?? null;
      if (missionStatus?.active) {
        lines.push("مأموریت‌های در جریان: " + missionStatus.active + " مورد — دستور: astack mission list");
      }
      const jobs = this.scheduler?.status() ?? null;
      if (jobs?.due) {
        lines.push("کارهای پس‌زمینه سررسیدشده: " + jobs.due + " مورد — دستور: astack schedule tick");
      }
      if (jobs?.incidents) {
        lines.push("حادثه‌های باز پایش: " + jobs.incidents + " مورد — دستور: astack schedule incidents");
      }
      const context = this.context?.stats() ?? null;
      if (context?.built) {
        lines.push("نقشه زمینه آماده است: " + context.files + " فایل ایندکس‌شده — دستور: astack context map \"" + String(input ?? "").slice(0, 40) + "\"");
      }
    } catch {
      return lines;
    }
    return lines;
  }

  run(input) {
    this.eventBus.emit("orchestrator.started", { input });
    const intent = this.analyzeIntent(input);
    const provider = this.providers.find((item) => item.id === "claude-code") ?? this.providers[0];
    const answer = ["Orchestrator درخواست را تحلیل کرد."];
    if (intent.domain) {
      answer.push("دامنه تشخیص‌داده‌شده: " + intent.domain.nameFa + " (" + intent.domain.id + ")");
    }
    answer.push("Workflow انتخاب‌شده: " + intent.workflow.id);
    answer.push("Departmentهای فعال: " + intent.departments.map((department) => department.name).join("، "));
    answer.push("Provider پیش‌فرض: " + provider.name);
    answer.push(...this.leadershipBriefing());
    answer.push(...this.activeProjectBriefing());
    answer.push(...this.autonomyBriefing(input));
    answer.push("گام بعدی: context خوانده شود، خروجی نقش‌ها merge شود و پاسخ نهایی فارسی ارائه شود.");
    const result = {
      intent: intent.summary,
      domain: intent.domain?.id ?? null,
      provider: provider.id,
      workflow: intent.workflow.id,
      departments: intent.departments.map((department) => department.id),
      answer
    };
    this.eventBus.emit("orchestrator.completed", result);
    return result;
  }
}

function dedupeById(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      result.push(item);
    }
  }
  return result;
}
