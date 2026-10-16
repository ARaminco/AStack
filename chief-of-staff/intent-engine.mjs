import { normalizeText, uniqueTokens } from "../lib/text.mjs";

const VERBS = [
  { verb: "monitor", level: "L1", patterns: [/monitor|watch|poll|uptime|پایش|چک کن|رصد|هر ?[0-9]+ ?(دقیقه|ساعت|روز)|هر ?(چند|روز|ساعت)/] },
  { verb: "find", level: "L1", patterns: [/find|search|where|locate|پیدا کن|کجا|جست ?و ?جو|بگرد/] },
  { verb: "analyze", level: "L1", patterns: [/analy[sz]e|review|audit|assess|check|تحلیل|بازبینی|حسابرسی|ارزیابی|بررسی/] },
  { verb: "explain", level: "L1", patterns: [/explain|what is|status|tell me|توضیح|وضعیت|چیست|بگو/] },
  { verb: "draft", level: "L2", patterns: [/draft|prepare|write|compose|report|پیش ?نویس|تنظیم کن|بنویس|گزارش|آماده کن|تهیه کن/] },
  { verb: "build", level: "L2", patterns: [/build|create|implement|develop|\bdesign (a|an|the)\b|بساز|ایجاد|پیاده ?سازی|توسعه|طراحی کن|راه ?اندازی کن/] },
  { verb: "fill", level: "L3", patterns: [/fill|complete the form|enter|update|پر کن|تکمیل کن|وارد کن|به ?روزرسانی/] },
  { verb: "submit", level: "L4", patterns: [/submit|file it|send it|pay|transfer|delete|publish|ارسال کن|ثبت کن|ثبت نهایی|پرداخت|حذف کن|منتشر|سابمیت/] }
];

const LEVELS = ["L0", "L1", "L2", "L3", "L4", "L5"];

// Changing something that already exists (3.3.0): in software work it is
// building; anywhere else it is a draft (a corrected contract, a note added
// to a case file), never more.
const EDIT_WORDS = /\b(fix|add|refactor|correct|revise|amend)\b|رفع کن|اضافه کن|اصلاح کن|درست کن|ویرایش کن/;
const BUILD = /build|create|implement|develop|design|refactor|\b(fix|add)\b|بساز|ایجاد|پیاده ?سازی|توسعه|طراحی|رفع کن|اضافه کن|اصلاح کن|درست کن/;
// Feature noun phrases of a product being built. Only these are set aside
// before the verbs are read; a real "pay the invoice" keeps its L4.
const FEATURE_PHRASES = /\b(online|card|in-app) payments?\b|\bpayment (page|gateway|module|form|flow|method|integration)s?\b|\bcheckout( page| flow)?\b|\b(login|sign-?in|sign-?up) (page|form|flow|screen)s?\b|درگاه پرداخت|پرداخت (آنلاین|اینترنتی|درون ?برنامه ?ای)|با پرداخت|صفحه ?(ی )?(ورود|پرداخت|ثبت ?نام)|فرم (ورود|پرداخت|ثبت ?نام)/g;

const EXTERNAL = /portal|website|site|login|browser|url|http|سایت|پورتال|سامانه|لینک|ورود/;
const PAST_REFERENCE = /same as|like last time|previously|again|as before|قبل|قبلا|دفعه قبل|همان ?طور|مثل قبل|دوباره/;
const TIME_HINT = /(today|tomorrow|this week|next week|quarter|deadline|امروز|فردا|این هفته|هفته آینده|فصل|مهلت|سررسید)/;
const MULTI_STEP = /( and | then |, |،| و | سپس |بعد از)/g;

/**
 * Intent engine.
 *
 * Turns a sentence into the few decisions everything downstream depends on:
 * what the owner wants done, how far outside the system it reaches, how
 * complex it is, whether it refers to work already done, and what a finished
 * answer looks like.
 */
export class IntentEngine {
  constructor({ domains = null, clock } = {}) {
    this.domains = domains;
    this.clock = clock ?? (() => new Date());
  }

  analyze(request, { domain = null } = {}) {
    const text = normalizeText(request ?? "");
    const tokens = uniqueTokens(request ?? "");
    const resolvedDomain = domain ?? this.domains?.detect(request)?.id ?? null;
    // Building software: "online payment" or "the login page" are features of
    // the thing being built, not a payment to make or a portal to visit.
    const building = resolvedDomain === "software" && BUILD.test(text);
    const verbText = building ? text.replace(FEATURE_PHRASES, " ") : text;
    const order = (a, b) => LEVELS.indexOf(b.level) - LEVELS.indexOf(a.level) || a.index - b.index;
    let matched = VERBS.map((entry, index) => ({ ...entry, index }))
      .filter((entry) => entry.patterns.some((pattern) => pattern.test(verbText)));
    if (EDIT_WORDS.test(verbText)) {
      const verb = building ? "build" : "draft";
      if (!matched.some((entry) => entry.verb === verb)) {
        const index = VERBS.findIndex((entry) => entry.verb === verb);
        matched.push({ ...VERBS[index], index });
      }
    }
    if (building) {
      // Building wins over drafting at the same level.
      matched = matched.filter((entry) => entry.verb !== "draft");
    }
    matched.sort(order);
    const primary = matched[0] ?? { verb: "explain", level: "L1" };
    const stepHints = (text.match(MULTI_STEP) ?? []).length;
    const external = EXTERNAL.test(verbText);
    const past = PAST_REFERENCE.test(text);
    const deadline = TIME_HINT.test(text);
    const words = tokens.length;
    const complexity = clamp(
      0.12 +
        Math.min(0.3, words / 60) +
        Math.min(0.24, stepHints * 0.06) +
        (matched.length > 1 ? 0.12 : 0) +
        (external ? 0.14 : 0) +
        (["submit", "fill", "build"].includes(primary.verb) ? 0.16 : 0) +
        (["legal", "tax", "finance", "accounting"].includes(resolvedDomain) ? 0.08 : 0),
      0.05,
      1
    );
    return {
      request,
      verb: primary.verb,
      authority: primary.level,
      domain: resolvedDomain,
      externalAction: external,
      referencesPast: past,
      hasDeadline: deadline,
      stepHints,
      complexity: Number(complexity.toFixed(3)),
      tokens: tokens.slice(0, 16),
      deliverable: this.deliverable(primary.verb, resolvedDomain),
      needs: this.capabilityNeeds({ verb: primary.verb, external, domain: resolvedDomain, text }),
      questions: this.openQuestions({ verb: primary.verb, external, text }),
      at: this.clock().toISOString()
    };
  }

  deliverable(verb, domain) {
    const byVerb = {
      monitor: "a monitoring job plus the first observation",
      find: "the located items with their exact locations",
      explain: "a short Persian answer with sources",
      analyze: "findings ordered by severity with evidence",
      draft: "a draft document ready for owner review",
      build: "the built change plus verification output",
      fill: "a completed but uncommitted form with a screenshot",
      submit: "the committed action plus its receipt and evidence"
    };
    const byDomain = {
      legal: "case brief",
      tax: "filing package",
      accounting: "closing report",
      finance: "financial analysis",
      software: "release-ready change"
    };
    return byVerb[verb] + (byDomain[domain] ? " (" + byDomain[domain] + ")" : "");
  }

  capabilityNeeds({ verb, external, domain, text }) {
    const needs = new Set();
    if (external) {
      needs.add("browse");
    }
    if (/document|pdf|scan|invoice|contract|سند|قرارداد|فاکتور|اسکن/.test(text)) {
      needs.add("extract");
    }
    if (/(code|repo|deploy|test|کد|مخزن|استقرار)/.test(text)) {
      needs.add("map");
    }
    if (["monitor"].includes(verb)) {
      needs.add("schedule");
    }
    if (["submit", "fill"].includes(verb)) {
      needs.add("form-fill");
    }
    if (["legal", "tax", "accounting", "finance"].includes(domain)) {
      needs.add("recall");
    }
    return [...needs];
  }

  openQuestions({ verb, external, text }) {
    const questions = [];
    if (verb === "submit" && !/approve|approved|تایید|تأیید/.test(text)) {
      questions.push("آیا اجازه ثبت نهایی داده شده است یا باید قبل از ارسال متوقف شوم؟");
    }
    if (external && !/https?:\/\//.test(text)) {
      questions.push("نشانی دقیق سامانه کدام است؟");
    }
    return questions;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export { VERBS };
