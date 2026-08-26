import { execFile } from "node:child_process";
import { redactSecrets } from "../lib/text.mjs";

export const jobKinds = [
  "http-check",
  "command",
  "agent-missions",
  "context-refresh",
  "learning-mine",
  "memory-consolidate",
  "project-digest",
  "signal-process",
  "browser-task",
  "heartbeat"
];

function ok(summary, extra = {}) {
  return { status: "ok", summary, ...extra };
}

function failed(summary, extra = {}) {
  return { status: "failed", summary, ...extra };
}

function readPath(source, path) {
  return String(path)
    .split(".")
    .filter(Boolean)
    .reduce((value, segment) => (value === null || value === undefined ? value : value[segment]), source);
}

/**
 * Watch a web service. This is the workhorse job: an owner asks for "check
 * this endpoint every ten minutes" and gets latency, status, body assertions,
 * incident tracking and recovery detection out of it.
 */
async function httpCheck(job, context) {
  const payload = job.payload ?? {};
  const url = payload.url;
  if (!url) {
    return failed("http-check needs payload.url");
  }
  const verdict = context.policy?.allowHost(url) ?? { allowed: true };
  if (!verdict.allowed) {
    return failed("blocked by automation policy: " + verdict.reason);
  }
  const expect = payload.expect ?? {};
  const started = Date.now();
  const headers = { "user-agent": "AStack-Scheduler/1.0", ...(payload.headers ?? {}) };
  if (payload.browserProfile && context.services?.browser) {
    const cookie = context.services.browser.cookieHeader(payload.browserProfile, url);
    if (cookie) {
      headers.cookie = cookie;
    }
  }
  let response = null;
  let body = "";
  try {
    response = await fetch(url, {
      method: payload.method ?? "GET",
      headers,
      body: payload.body ? (typeof payload.body === "string" ? payload.body : JSON.stringify(payload.body)) : undefined,
      redirect: payload.redirect ?? "follow",
      signal: AbortSignal.timeout(job.policy?.timeoutMs ?? 15000)
    });
    body = await response.text();
  } catch (error) {
    return failed("request failed: " + error.message, { metrics: { latencyMs: Date.now() - started, ok: false } });
  }
  const latencyMs = Date.now() - started;
  const metrics = { status: response.status, latencyMs, bytes: body.length, ok: response.ok };
  const problems = [];
  const expectedStatus = expect.status ?? null;
  if (expectedStatus !== null && response.status !== Number(expectedStatus)) {
    problems.push("status " + response.status + " != " + expectedStatus);
  }
  if (expectedStatus === null && !response.ok) {
    problems.push("http status " + response.status);
  }
  if (expect.contains && !body.includes(String(expect.contains))) {
    problems.push("body does not contain " + JSON.stringify(String(expect.contains)));
  }
  if (expect.notContains && body.includes(String(expect.notContains))) {
    problems.push("body contains forbidden text " + JSON.stringify(String(expect.notContains)));
  }
  if (expect.maxLatencyMs && latencyMs > Number(expect.maxLatencyMs)) {
    problems.push("latency " + latencyMs + "ms > " + expect.maxLatencyMs + "ms");
  }
  if (expect.json?.path) {
    try {
      const value = readPath(JSON.parse(body), expect.json.path);
      metrics.jsonValue = value;
      if ("equals" in expect.json && String(value) !== String(expect.json.equals)) {
        problems.push("json " + expect.json.path + " = " + JSON.stringify(value) + " != " + JSON.stringify(expect.json.equals));
      }
    } catch (error) {
      problems.push("json assertion failed: " + error.message);
    }
  }
  const summary = "HTTP " + response.status + " in " + latencyMs + "ms";
  if (problems.length) {
    return failed(summary + " — " + problems.join("; "), { metrics, output: redactSecrets(body.slice(0, 600)) });
  }
  return ok(summary, { metrics });
}

async function runCommand(job, context) {
  const payload = job.payload ?? {};
  if (!payload.command) {
    return failed("command job needs payload.command");
  }
  const verdict = context.policy?.allowInvocation
    ? context.policy.allowInvocation(payload.command, payload.args ?? [])
    : { allowed: true };
  if (!verdict.allowed) {
    return failed("blocked by automation policy: " + verdict.reason);
  }
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      payload.command,
      payload.args ?? [],
      {
        cwd: payload.cwd ? payload.cwd : context.root,
        timeout: job.policy?.timeoutMs ?? 60000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, ...(payload.env ?? {}) }
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - started;
        const output = redactSecrets(String(stdout ?? "").slice(-4000));
        if (error) {
          resolve(
            failed("exit " + (error.code ?? "error") + ": " + (error.message ?? "").slice(0, 200), {
              metrics: { durationMs, exitCode: error.code ?? null },
              output: output + redactSecrets(String(stderr ?? "").slice(-2000))
            })
          );
          return;
        }
        resolve(ok("command finished in " + durationMs + "ms", { metrics: { durationMs, exitCode: 0 }, output }));
      }
    );
  });
}

async function agentMissions(job, context) {
  const agents = context.services?.agents;
  if (!agents) {
    return failed("agent engine is not available");
  }
  const dispatched = agents.runDue();
  return ok("dispatched " + dispatched.length + " agent missions", {
    metrics: { dispatched: dispatched.length },
    output: dispatched.map((entry) => entry.agentId + " " + entry.assignmentId + " -> " + entry.workOrder).join("\n")
  });
}

async function contextRefresh(job, context) {
  const engine = context.services?.context;
  if (!engine) {
    return failed("context engine is not available");
  }
  const index = engine.build({ force: Boolean(job.payload?.force) });
  return ok("indexed " + index.stats.files + " files (" + index.stats.parsed + " parsed, " + index.stats.reused + " reused)", {
    metrics: { files: index.stats.files, parsed: index.stats.parsed, durationMs: index.stats.durationMs }
  });
}

async function learningMine(job, context) {
  const learning = context.services?.learning;
  if (!learning) {
    return failed("learning engine is not available");
  }
  const forged = learning.autoForge({ domain: job.payload?.domain ?? null });
  return ok(forged.length ? "forged or refined " + forged.length + " skills" : "no new skill pattern reached its threshold", {
    metrics: { forged: forged.length },
    output: forged.map((skill) => skill.id + " (" + skill.status + ", conf " + skill.confidence + ")").join("\n")
  });
}

async function memoryConsolidate(job, context) {
  const memory = context.services?.memory;
  if (!memory) {
    return failed("memory engine is not available");
  }
  const report = memory.consolidate(job.payload ?? {});
  return ok("merged " + report.merged + ", decayed " + report.decayed + ", dropped " + report.dropped + ", kept " + report.kept, { metrics: report });
}

async function projectDigest(job, context) {
  const projects = context.services?.projects;
  if (!projects) {
    return failed("project engine is not available");
  }
  const projectId = job.payload?.project;
  const list = projectId ? [projects.get(projectId)] : projects.list().filter((project) => project.phase !== "closed");
  if (!list.length) {
    return ok("no open project to report");
  }
  const summaries = list.map((project) => {
    const status = projects.status(project.id);
    return project.id + ": health " + status.health.score + "/100 (" + status.health.rag + ")";
  });
  return ok("reported " + list.length + " projects", { output: summaries.join("\n"), metrics: { projects: list.length } });
}

async function signalProcess(job, context) {
  const signals = context.services?.signals;
  if (!signals) {
    return failed("signal engine is not available");
  }
  const processed = await signals.processQueue({ limit: job.payload?.limit ?? 50 });
  return ok("processed " + processed.length + " inbound signals", {
    metrics: { processed: processed.length },
    output: processed.map((entry) => entry.id + " -> " + entry.reactions.map((reaction) => reaction.action).join(",")).join("\n")
  });
}

async function browserTask(job, context) {
  const browser = context.services?.browser;
  if (!browser) {
    return failed("browser engine is not available");
  }
  const payload = job.payload ?? {};
  const result = await browser.run({
    profile: payload.profile ?? "default",
    url: payload.url,
    steps: payload.steps ?? [],
    capture: payload.capture ?? ["screenshot"],
    evidence: payload.evidence ?? null,
    timeoutMs: job.policy?.timeoutMs ?? 60000
  });
  return result.ok
    ? ok(result.summary, { metrics: result.metrics, output: (result.artifacts ?? []).join("\n") })
    : failed(result.summary, { metrics: result.metrics, output: (result.artifacts ?? []).join("\n") });
}

async function heartbeat(job) {
  return ok("heartbeat " + (job.payload?.label ?? job.id));
}

export const handlers = {
  "http-check": httpCheck,
  command: runCommand,
  "agent-missions": agentMissions,
  "context-refresh": contextRefresh,
  "learning-mine": learningMine,
  "memory-consolidate": memoryConsolidate,
  "project-digest": projectDigest,
  "signal-process": signalProcess,
  "browser-task": browserTask,
  heartbeat
};

export function describeKind(kind) {
  return {
    "http-check": "پایش سرویس وب با بررسی وضعیت، تأخیر و محتوای پاسخ",
    command: "اجرای یک فرمان مجاز در پس‌زمینه",
    "agent-missions": "ارسال مأموریت‌های سررسیدشده ایجنت‌ها",
    "context-refresh": "به‌روزرسانی نقشه زمینه و ایندکس فضای کاری",
    "learning-mine": "کشف الگوهای تکراری و ساخت خودکار skill",
    "memory-consolidate": "تجمیع و پالایش حافظه چندوجهی",
    "project-digest": "گزارش سلامت پروژه‌های باز",
    "signal-process": "پردازش صف هوک‌های ورودی",
    "browser-task": "اجرای سناریوی مرورگر داخلی و ثبت شواهد",
    heartbeat: "ضربان زنده‌بودن زمان‌بند"
  }[kind] ?? kind;
}
