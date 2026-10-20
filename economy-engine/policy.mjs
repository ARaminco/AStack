export const DEFAULT_ROUTES = { search: "haiku", "bulk-read": "sonnet", build: "sonnet", write: "sonnet", other: "sonnet", review: "opus", plan: "opus", legal: "opus" };
export const DEFAULT_CAPS = { green: 4, amber: 3, red: 2, critical: 1 };
export const DEFAULT_BUDGETS = { green: 160000, amber: 120000, red: 90000, critical: 90000 };

export function modelClass(model) {
  return ["haiku", "sonnet", "opus", "fable"].find((name) => String(model ?? "").toLowerCase().includes(name)) ?? "unknown";
}

const rank = (model) => ({ haiku: 1, sonnet: 2, opus: 3, fable: 3, unknown: 3 })[modelClass(model)];
const normalize = (text) => String(text ?? "").toLowerCase().replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/\u200c/g, " ");

export function classify(input = {}) {
  const type = normalize(input.subagent_type);
  for (const [pattern, job] of [
    [/^(case-analyst|legal-reviewer|legal-drafter)$/, "legal"],
    [/^(qa-inspector|security-officer|code-review.*)$/, "review"],
    [/^(web-engineer|infra-operator)$/, "build"],
    [/^paralegal$/, "bulk-read"], [/^content-editor$/, "write"], [/^explore$/, "search"], [/^plan$/, "plan"]
  ]) {
    if (pattern.test(type)) {
      return job;
    }
  }
  // Legal work is the one class that raises the model, so it is recognised only from the agent type and the short
  // description, or from unmistakable legal words anywhere (court, lawsuit, lawyer); generic words such as "case" or
  // "contract" never make a job legal ("test case", "API contract").
  const head = normalize([type, input.description].join(" ")) + " " + normalize(input.prompt).match(/(court|lawsuit|lawyer|litigation)|دادگاه|دادخواست|وکیل/g)?.join(" ");
  if (/\b(legal|court|lawsuit|lawyer|advocate|litigation|settlement agreement)\b|حقوقی|دادگاه|دادخواست|وکیل|وکالت|لایحه|توافق نامه|تسویه/.test(head)) {
    return "legal";
  }
  const text = normalize([type, input.description, input.prompt].join(" "));
  for (const [pattern, job] of [
    [/\b(review|audit|verify|qa|security|inspect|critique|adjudicate)\b|بازبینی|ممیزی|بررسی|امنیت|ارزیابی|نقد/, "review"],
    [/\b(plan|architecture|design system|strategy)\b|برنامه ریزی|معماری|راهبرد|استراتژی|سیستم طراحی/, "plan"],
    [/\b(bulk|ocr|extract|scan)\b|\b(read|summari[sz]e)\b[\s\S]*\b(files|pages|documents|many)\b|استخراج|اسکن|خواندن|بخوان|صفحات|فایل ها/, "bulk-read"],
    [/\b(implement|build|write code|ui|page|component|refactor|fix|test|migrate)\b|پیاده سازی|بساز|ساخت|کدنویسی|رابط کاربری|کامپوننت|بازنویسی|اصلاح|آزمون|تست|مهاجرت/, "build"],
    [/\b(search|find|locate|grep|list|inventory)\b|جستجو|جست وجو|پیدا|فهرست|بیاب/, "search"],
    [/\b(draft|article|translate|copy|write)\b|پیش نویس|مقاله|ترجمه|متن|بنویس/, "write"]
  ]) {
    if (pattern.test(text)) {
      return job;
    }
  }
  return "other";
}

export function decideRoute(input = {}, { pressure = "green", config = {}, running = 0, inheritedModel = null } = {}) {
  const job = classify(input);
  let target = { ...DEFAULT_ROUTES, ...config.routes }[job];
  const protectedWork = /security|irreversible|production|امنیت|برگشت ناپذیر|محیط عملیاتی/i.test(input.prompt ?? "");
  if (pressure === "amber" && ["review", "plan"].includes(job) && !protectedWork && rank(target) > 2) {
    target = "sonnet";
  }
  if (["red", "critical"].includes(pressure) && job !== "legal" && rank(target) > 2) {
    target = "sonnet";
  }
  const requested = input.model ?? inheritedModel ?? config.default_subagent_model ?? "sonnet";
  let model = rank(requested) <= rank(target) ? requested : target;
  if (input.model && config.respect_explicit === true) {
    model = input.model;
  }
  if (job === "legal") {
    model = rank(requested) >= 3 && modelClass(requested) !== "unknown" ? requested : "opus";
  }
  const cap = ({ ...DEFAULT_CAPS, ...config.parallel_cap })[pressure] ?? DEFAULT_CAPS.green;
  const budget = ({ ...DEFAULT_BUDGETS, ...config.context_budget })[pressure] ?? DEFAULT_BUDGETS.green;
  // The Agent tool takes an alias; a full model id from frontmatter is passed on as its alias.
  if (modelClass(model) !== "unknown") {
    model = modelClass(model);
  }
  return {
    job, model, pressure, cap, budget, denied: running >= cap,
    lowered: rank(model) < rank(requested) && job !== "legal",
    delegate: ["red", "critical"].includes(pressure) && ["build", "bulk-read"].includes(job),
    reason: job === "legal" ? "Legal work requires opus" : rank(model) < rank(requested) ? "Lowered to the job and pressure budget" : "Caller model is within policy"
  };
}
