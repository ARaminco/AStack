export class Orchestrator {
  constructor({ departments, providers, workflows, memory, eventBus, projects }) {
    this.departments = departments;
    this.providers = providers;
    this.workflows = workflows;
    this.memory = memory;
    this.eventBus = eventBus;
    this.projects = projects ?? null;
  }

  analyzeIntent(input) {
    const text = String(input || "").toLowerCase();
    const scored = this.departments
      .map((department) => {
        const haystack = [department.id, department.name, ...(department.roles ?? [])].join(" ").toLowerCase();
        const tokens = [...new Set(haystack.split(/[-\s]+/))].filter((token) => token.length > 2);
        return { department, score: tokens.filter((token) => text.includes(token)).length };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.department.id.localeCompare(b.department.id));
    return {
      summary: input || "درخواست عمومی برای بازبینی Enterprise",
      departments: scored.length
        ? scored.slice(0, 5).map((entry) => entry.department)
        : this.departments.filter((department) => ["architecture", "engineering", "qa"].includes(department.id)),
      workflow: this.workflows.select(input || "review"),
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

  run(input) {
    this.eventBus.emit("orchestrator.started", { input });
    const intent = this.analyzeIntent(input);
    const provider = this.providers.find((item) => item.id === "claude-code") ?? this.providers[0];
    const result = {
      intent: intent.summary,
      provider: provider.id,
      workflow: intent.workflow.id,
      departments: intent.departments.map((department) => department.id),
      answer: [
        ...this.activeProjectBriefing(),
        "Orchestrator درخواست را تحلیل کرد.",
        "Workflow انتخاب‌شده: " + intent.workflow.id,
        "Departmentهای فعال: " + intent.departments.map((department) => department.name).join("، "),
        "Provider پیش‌فرض: " + provider.name,
        "گام بعدی: context پروژه خوانده شود، خروجی roleها merge شود و پاسخ نهایی فارسی ارائه شود."
      ]
    };
    this.eventBus.emit("orchestrator.completed", result);
    return result;
  }
}
