export class Orchestrator {
  constructor({ departments, providers, workflows, memory, eventBus }) {
    this.departments = departments;
    this.providers = providers;
    this.workflows = workflows;
    this.memory = memory;
    this.eventBus = eventBus;
  }

  analyzeIntent(input) {
    const text = String(input || "").toLowerCase();
    const matches = this.departments.filter((department) => {
      const haystack = [department.id, department.name, ...(department.roles ?? [])].join(" ").toLowerCase();
      return haystack.split(/[-\s]+/).some((token) => token.length > 2 && text.includes(token));
    });
    return {
      summary: input || "درخواست عمومی برای بازبینی Enterprise",
      departments: matches.length ? matches.slice(0, 5) : this.departments.filter((department) => ["architecture", "engineering", "qa"].includes(department.id)),
      workflow: this.workflows.select(input || "review"),
    };
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
