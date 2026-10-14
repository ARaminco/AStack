/**
 * The fixed command set the owner can type. Anything else is a request.
 *   /status  /pending  /runs  /stop <id>  /help  (/approve, /deny are decisions)
 */
export async function runCommand(engine, { channelId, text, reply }) {
  const [rawName, ...rest] = text.slice(1).split(/\s+/);
  const name = String(rawName ?? "").toLowerCase().replace(/@.*$/, "");
  const argument = rest.join(" ").trim();
  const t = (key, vars) => engine.t(key, vars);
  const runtime = engine.runtime ?? {};

  if (name === "help" || name === "start" || name === "راهنما") {
    await reply(t("command.help"));
    return { action: "command", command: "help" };
  }

  if (name === "status" || name === "وضعیت") {
    const chief = runtime.chief ?? engine.chief;
    const lines = [t("command.statusTitle")];
    if (chief) {
      const standup = chief.standup();
      lines.push(...(standup.capsule?.lines ?? []).slice(0, 6).map((line) => "- " + line));
      if (standup.missions) {
        lines.push(t("command.statusMissions", { missions: standup.missions.missions, active: standup.missions.active, waiting: standup.missions.waitingApproval }));
      }
      lines.push(t("command.statusPending", { count: standup.pendingApprovals.length }));
    } else if (engine.approvals) {
      lines.push(t("command.statusPending", { count: engine.approvals.pending().length }));
    }
    lines.push(t("command.statusRunner", { state: runtime.runner?.execute ? t("command.runnerOn") : t("command.runnerOff") }));
    await reply(lines.join("\n"));
    return { action: "command", command: "status" };
  }

  if (name === "pending" || name === "تاییدها") {
    const pending = engine.approvals?.pending() ?? [];
    if (!pending.length) {
      await reply(t("approval.none"));
      return { action: "command", command: "pending", count: 0 };
    }
    const lines = [t("command.pendingTitle", { count: pending.length })];
    for (const approval of pending.slice(0, 15)) {
      const prompt = engine.ensurePrompt(approval.id);
      lines.push(t("command.pendingItem", { code: prompt.code, action: approval.action, summary: String(approval.summary ?? "").slice(0, 80) }));
    }
    lines.push(t("command.pendingHint"));
    await reply(lines.join("\n"));
    return { action: "command", command: "pending", count: pending.length };
  }

  if (name === "runs" || name === "اجراها") {
    const lines = [t("command.runsTitle")];
    let entries = [];
    if (runtime.runner?.list) {
      entries = (await runtime.runner.list({ limit: 5 })).map((run) => run.id + " | " + run.status + " | " + String(run.summary ?? run.objective ?? "").slice(0, 60));
    } else if (runtime.missions ?? engine.missions) {
      entries = (runtime.missions ?? engine.missions).list({ limit: 5 }).map((mission) => mission.id + " | " + mission.state + " | " + mission.title.slice(0, 60));
    }
    if (!entries.length) {
      await reply(t("command.runsEmpty"));
      return { action: "command", command: "runs", count: 0 };
    }
    lines.push(...entries.map((entry) => "- " + entry));
    await reply(lines.join("\n"));
    return { action: "command", command: "runs", count: entries.length };
  }

  if (name === "stop" || name === "توقف") {
    if (!argument) {
      await reply(t("command.stopUsage"));
      return { action: "command", command: "stop", ok: false };
    }
    try {
      const runner = runtime.runner;
      const missions = runtime.missions ?? engine.missions;
      let stopped = null;
      if (runner && typeof (runner.stop ?? runner.cancel) === "function") {
        stopped = await (runner.stop ?? runner.cancel).call(runner, argument, { reason: "owner@" + channelId });
      } else if (missions && /^M-/.test(argument)) {
        // Pausing is reversible: `astack mission resume` picks it up again.
        stopped = missions.pause(argument, { reason: "stopped by owner@" + channelId });
      } else if (runner?.get && missions) {
        const run = await runner.get(argument);
        if (run?.missionId) {
          stopped = missions.pause(run.missionId, { reason: "stopped by owner@" + channelId });
        }
      }
      if (!stopped) {
        await reply(t("command.stopFailed", { reason: t("command.stopUnknown") }));
        return { action: "command", command: "stop", ok: false };
      }
      engine.audit?.record({ actor: "owner@" + channelId, tool: "gateway", action: "gateway-stop", target: argument, riskLevel: "L1", result: "stopped" });
      await reply(t("command.stopped", { id: argument }));
      return { action: "command", command: "stop", ok: true };
    } catch (error) {
      await reply(t("command.stopFailed", { reason: error.message }));
      return { action: "command", command: "stop", ok: false };
    }
  }

  await reply(t("command.unknown"));
  return { action: "command", command: name, unknown: true };
}
