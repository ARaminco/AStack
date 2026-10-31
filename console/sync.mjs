/**
 * "Sync everything" for the Aramis dashboard: one button that brings every
 * local index and memory up to date, whichever Claude account is signed in.
 *
 * Chats, projects and AStack memory live on this computer and do not belong to
 * an account, so the steps below work the same after an account switch. The one
 * step that talks to Anthropic (titles on the phone copy) uses the signed-in
 * account and only sees that account's phone sessions.
 *
 * Steps run one after another; one failing never stops the rest, and no secret
 * ever appears in a result.
 */

const STEP_TIMEOUT_MS = 90000;

function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const short = (error) => String(error?.message ?? error ?? "error").replace(/[\u0000-\u001f]/g, " ").slice(0, 160);

export class ConsoleSync {
  constructor(server) {
    this.server = server;
    this.running = null;
    this.last = null;
  }

  status() {
    return { running: Boolean(this.running), last: this.last };
  }

  async run() {
    if (this.running) {
      return this.running;
    }
    this.running = this.execute().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async execute() {
    const { runtime, projects } = this.server;
    const startedAt = Date.now();
    const steps = [];
    const step = async (id, task, skipReason = null) => {
      if (skipReason) {
        steps.push({ id, ok: true, skipped: true, detail: { reason: skipReason } });
        return;
      }
      const began = Date.now();
      try {
        const detail = await withTimeout(Promise.resolve().then(task), STEP_TIMEOUT_MS);
        steps.push({ id, ok: true, detail: detail ?? {}, ms: Date.now() - began });
      } catch (error) {
        steps.push({ id, ok: false, error: short(error), ms: Date.now() - began });
      }
    };

    await step("projects", async () => {
      await projects.warm({});
      const list = projects.projects();
      return { projects: list.length, sessions: list.reduce((sum, entry) => sum + Number(entry.sessions ?? 0), 0) };
    });

    await step(
      "claudeMemory",
      () => {
        const report = runtime.interop.importClaudeMemory();
        return { imported: report.imported ?? 0, updated: report.updated ?? 0, unchanged: report.unchanged ?? 0 };
      },
      typeof runtime.interop?.importClaudeMemory === "function" ? null : "no-interop"
    );

    await step(
      "memory",
      () => {
        const report = runtime.interop.importLegacy();
        return { imported: report?.imported ?? 0, updated: report?.updated ?? 0, unchanged: report?.unchanged ?? 0 };
      },
      typeof runtime.interop?.importLegacy === "function" ? null : "no-interop"
    );

    const phoneOff = projects.syncRemote === false || projects.titles?.config?.sync_remote === false;
    await step(
      "phoneTitles",
      async () => {
        const totals = await projects.titles.syncRemote({ all: true });
        return { sessions: totals.sessions ?? 0, pushed: totals.pushed ?? 0, localOnly: totals.localOnly ?? 0, failed: totals.failed ?? 0 };
      },
      phoneOff ? "disabled" : null
    );

    await step("accounts", async () => {
      const data = await this.server.accounts.list();
      return { accounts: (data.accounts ?? []).length, active: data.active?.email ?? null };
    });

    const failed = steps.filter((entry) => !entry.ok).length;
    const result = { ok: failed === 0, failed, steps, took: Date.now() - startedAt, at: this.server.clock().toISOString(), account: steps.find((entry) => entry.id === "accounts")?.detail?.active ?? null };
    this.last = result;
    this.server.runtime.audit?.record({ actor: "owner@console", action: "console-sync", target: "all", riskLevel: "L1", result: steps.map((entry) => entry.id + (entry.ok ? (entry.skipped ? ":skipped" : ":ok") : ":failed")).join(" ") });
    return result;
  }
}
