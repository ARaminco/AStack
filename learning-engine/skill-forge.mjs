import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { slugify } from "../lib/text.mjs";

export const skillStatuses = ["candidate", "draft", "active", "trusted", "deprecated"];

const ACTION_FA = {
  review: "بازبینی", build: "ساخت", fix: "رفع اشکال", report: "گزارش‌نویسی", file: "بایگانی",
  analyze: "تحلیل", extract: "استخراج", close: "بستن دوره", draft: "تنظیم پیش‌نویس",
  deploy: "استقرار", monitor: "پایش", handle: "انجام"
};

/**
 * The skill forge turns a mined pattern into a real, installed skill package.
 *
 * The generated skill has the same shape as a hand written one — SKILL.md,
 * rules, checklist and examples — plus a machine readable skill.json that
 * carries the evidence it was built from and the metrics that will promote or
 * retire it later.
 */
export class SkillForge {
  constructor(root, { clock, memory, eventBus } = {}) {
    this.root = root;
    this.directory = join(root, "skills", "learned");
    this.clock = clock ?? (() => new Date());
    this.memory = memory ?? null;
    this.eventBus = eventBus ?? null;
  }

  now() {
    return this.clock().toISOString();
  }

  path(id) {
    return join(this.directory, id);
  }

  exists(id) {
    return existsSync(join(this.path(id), "skill.json"));
  }

  read(id) {
    const path = join(this.path(id), "skill.json");
    if (!existsSync(path)) {
      throw new Error("Unknown learned skill: " + id);
    }
    return JSON.parse(readFileSync(path, "utf8"));
  }

  list() {
    if (!existsSync(this.directory)) {
      return [];
    }
    return readdirSafe(this.directory)
      .filter((name) => existsSync(join(this.directory, name, "skill.json")))
      .map((name) => this.read(name))
      .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
  }

  save(manifest) {
    const directory = this.path(manifest.id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "skill.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    this.snapshot(manifest);
    return manifest;
  }

  /**
   * Every saved manifest is also written as an immutable version, so a skill
   * that degrades after a website change can be rolled back to the version
   * that worked.
   */
  snapshot(manifest) {
    const directory = join(this.path(manifest.id), "versions");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "v" + manifest.version + ".json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    return directory;
  }

  /**
   * Build (or refresh) a skill package from a mined candidate.
   */
  forge(candidate, { status = "draft" } = {}) {
    const id = uniqueId(this.directory, candidate.id);
    const previous = this.exists(id) ? this.read(id) : null;
    const manifest = {
      id,
      name: candidate.title,
      nameFa: buildPersianName(candidate),
      source: "learned",
      status: previous?.status && previous.status !== "candidate" ? previous.status : status,
      version: (previous?.version ?? 0) + 1,
      createdAt: previous?.createdAt ?? this.now(),
      updatedAt: this.now(),
      lastUsedAt: previous?.lastUsedAt ?? null,
      domains: [candidate.domain],
      action: candidate.action,
      keywords: candidate.keywords,
      tools: [...new Set(candidate.procedure.map((step) => step.tool).filter(Boolean))],
      signatures: candidate.signatures,
      confidence: candidate.confidence,
      procedure: candidate.procedure,
      guardrails: candidate.guardrails,
      evidence: {
        episodes: candidate.episodes,
        occurrences: candidate.occurrences,
        distinctDays: candidate.distinctDays,
        spanDays: candidate.spanDays,
        successRate: candidate.successRate,
        stability: candidate.stability,
        impact: candidate.impact
      },
      metrics: previous?.metrics ?? { uses: 0, successes: 0, failures: 0, successRate: 0, avgDurationMs: 0 },
      history: [...(previous?.history ?? []), { at: this.now(), event: previous ? "refined" : "forged", occurrences: candidate.occurrences, confidence: candidate.confidence }].slice(-40)
    };
    this.save(manifest);
    this.writeDocuments(manifest, candidate);
    this.memory?.facets?.append("procedural", {
      title: "skill: " + manifest.name,
      body: manifest.procedure.map((step) => step.order + ". " + step.label).join("\n"),
      domain: candidate.domain,
      tags: ["skill", manifest.id, manifest.status],
      refs: candidate.episodes,
      confidence: manifest.confidence,
      source: "skill-forge"
    });
    this.eventBus?.emit("skill.forged", { id: manifest.id, status: manifest.status, confidence: manifest.confidence });
    return manifest;
  }

  writeDocuments(manifest, candidate) {
    const directory = this.path(manifest.id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "SKILL.md"), renderSkill(manifest, candidate), "utf8");
    writeFileSync(join(directory, "rules.md"), renderRules(manifest), "utf8");
    writeFileSync(join(directory, "checklist.md"), renderChecklist(manifest), "utf8");
    writeFileSync(join(directory, "examples.md"), renderExamples(manifest, candidate), "utf8");
  }

  setStatus(id, status) {
    if (!skillStatuses.includes(status)) {
      throw new Error("Unknown skill status: " + status + ". Use: " + skillStatuses.join(", "));
    }
    const manifest = this.read(id);
    manifest.status = status;
    manifest.updatedAt = this.now();
    manifest.history = [...(manifest.history ?? []), { at: this.now(), event: "status", status }].slice(-40);
    this.save(manifest);
    this.eventBus?.emit("skill.status", { id, status });
    return manifest;
  }
}

function readdirSafe(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function uniqueId(directory, base) {
  return slugify(base, { fallback: "learned-skill" });
}

function buildPersianName(candidate) {
  const verb = ACTION_FA[candidate.action] ?? "انجام";
  const subject = candidate.keywords.filter((keyword) => keyword !== verb).slice(0, 3).join(" ");
  return subject ? verb + " " + subject : verb + " " + candidate.domain;
}

function renderSkill(manifest, candidate) {
  const lines = [];
  lines.push("# " + manifest.nameFa + " (" + manifest.name + ")");
  lines.push("");
  lines.push("> این skill به‌صورت خودکار از " + manifest.evidence.occurrences + " اجرای واقعی ساخته شده است. وضعیت: " + manifest.status + " | اعتماد: " + manifest.confidence);
  lines.push("");
  lines.push("## سیاست مشترک");
  lines.push("این skill سیاست زبان مرکزی را از `../../../system/language-policy.md` inherit می‌کند و نباید قواعد زبان را داخل خود تکرار کند.");
  lines.push("");
  lines.push("## ماموریت");
  lines.push("این skill کار تکراری «" + manifest.name + "» را در دامنه " + manifest.domains.join("، ") + " با همان کیفیتی اجرا می‌کند که در اجراهای موفق قبلی ثبت شده است.");
  lines.push("");
  lines.push("## چه زمانی استفاده شود");
  lines.push("- وقتی درخواست شامل این نشانه‌ها باشد: " + manifest.keywords.slice(0, 8).join("، "));
  lines.push("- وقتی دامنه تشخیص‌داده‌شده " + manifest.domains.join("، ") + " است.");
  lines.push("- وقتی خروجی باید با اجراهای قبلی سازگار و قابل‌مقایسه باشد.");
  lines.push("");
  lines.push("## پروتکل اجرا");
  for (const step of manifest.procedure) {
    lines.push(
      step.order + ". " + step.label +
      (step.tool ? " (ابزار: " + step.tool + ")" : "") +
      (step.required ? "" : " — اختیاری، در " + Math.round(step.share * 100) + "٪ اجراها دیده شده")
    );
  }
  lines.push("");
  lines.push("## نکات آموخته‌شده");
  if (manifest.guardrails.length) {
    for (const rail of manifest.guardrails) {
      lines.push("- " + rail.note + " (منبع: " + rail.from + ")");
    }
  } else {
    lines.push("- تا امروز شکست ثبت‌شده‌ای برای این الگو وجود ندارد؛ هر شکست جدید به‌صورت خودکار به این بخش اضافه می‌شود.");
  }
  lines.push("");
  lines.push("## قالب خروجی");
  lines.push("- خلاصه کار انجام‌شده");
  lines.push("- گام‌های اجراشده با نتیجه هر گام");
  lines.push("- خروجی‌ها و مسیر فایل‌های تولیدشده");
  lines.push("- ریسک باقی‌مانده و اقدام بعدی");
  lines.push("");
  lines.push("## بازخورد");
  lines.push("پس از هر اجرا نتیجه را ثبت کنید تا این skill دقیق‌تر شود:");
  lines.push("");
  lines.push("```");
  lines.push("astack learn feedback " + manifest.id + " --outcome done --note \"...\"");
  lines.push("```");
  lines.push("");
  lines.push("## شواهد");
  lines.push("- اجراهای مرجع: " + (candidate?.episodes ?? manifest.evidence.episodes).slice(0, 10).join("، "));
  lines.push("- نرخ موفقیت تاریخی: " + Math.round(manifest.evidence.successRate * 100) + "٪");
  lines.push("- میانگین زمان هر اجرا: " + Math.round((manifest.evidence.impact?.avgDurationMs ?? 0) / 1000) + " ثانیه");
  lines.push("");
  return lines.join("\n");
}

function renderRules(manifest) {
  const lines = ["# قواعد " + manifest.nameFa, ""];
  lines.push("- گام‌های الزامی این skill قابل حذف نیستند: " + manifest.procedure.filter((step) => step.required).map((step) => step.label).join("، "));
  lines.push("- هر انحراف از پروتکل باید در گزارش نهایی با دلیل ثبت شود.");
  lines.push("- خروجی برای مالک فارسی است؛ مسیرها، دستورها و شناسه‌ها انگلیسی می‌مانند.");
  lines.push("- اگر ورودی با نشانه‌های این skill هم‌خوانی ندارد، اجرای آن متوقف و به Orchestrator برگردانده شود.");
  for (const rail of manifest.guardrails) {
    lines.push("- پیشگیری از تکرار خطا: " + rail.note);
  }
  lines.push("");
  return lines.join("\n");
}

function renderChecklist(manifest) {
  const lines = ["# چک‌لیست " + manifest.nameFa, ""];
  for (const step of manifest.procedure) {
    lines.push("- [ ] " + step.label + (step.required ? " (الزامی)" : " (اختیاری)"));
  }
  lines.push("- [ ] ثبت نتیجه با `astack learn feedback " + manifest.id + "`");
  lines.push("");
  return lines.join("\n");
}

function renderExamples(manifest, candidate) {
  const lines = ["# نمونه‌های واقعی " + manifest.nameFa, ""];
  const samples = candidate?.samples ?? [];
  if (!samples.length) {
    lines.push("- هنوز نمونه‌ای ثبت نشده است.");
    return lines.join("\n") + "\n";
  }
  for (const sample of samples) {
    lines.push("## " + sample.id);
    lines.push("- درخواست: " + sample.task);
    lines.push("- نتیجه: " + sample.outcome);
    if (sample.artifacts?.length) {
      lines.push("- خروجی‌ها: " + sample.artifacts.join("، "));
    }
    lines.push("");
  }
  return lines.join("\n");
}
