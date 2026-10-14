import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "../delivery-engine/cli.mjs";
import { BridgeManager } from "../gateway-engine/bridge-manager.mjs";
import { formatForChat, maskId } from "../gateway-engine/format.mjs";
import { createService } from "../gateway-engine/service.mjs";

const out = (line) => console.log(line);

/**
 * astack gateway status | test <channel> | send --to owner --text "..." [--yes]
 *                | poll --once | serve | voice setup|test <file>
 *                | owners | owner add|remove <channel> <id> [--group]
 *                | whatsapp setup|pair|start|stop|status
 */
export async function runGatewayCommand({ runtime, i18n, tokens }) {
  const t = (key, vars) => i18n.t("cli.gateway." + key, vars);
  const [action = "status", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const gateway = runtime.gateway.bind(runtime);

  if (action === "status") {
    const status = gateway.status();
    if (flags.json) {
      out(JSON.stringify(status, null, 2));
      return;
    }
    out(t("statusTitle", { state: status.enabled ? t("enabled") : t("disabled") }));
    out(t("runner", { state: status.runner ? "runner" : "chief (plan only)" }));
    for (const [id, channel] of Object.entries(status.channels)) {
      out(t("channelLine", { id, enabled: channel.enabled ? "on" : "off", configured: channel.configured ? "ok" : "no", owners: channel.owners, groups: channel.groups, ignored: channel.ignored }));
      if (channel.enabled) {
        for (const item of channel.missing) {
          out(t("missing", { item }));
        }
      }
    }
    out(t("voiceLine", status.voice));
    return;
  }

  if (action === "test") {
    const id = positionals[0] ?? "cli";
    try {
      const health = await gateway.channel(id).health();
      out(t(health.ok ? "testOk" : "testFailed", { channel: id, detail: health.detail, error: health.detail }));
      if (!health.ok) {
        process.exitCode = 1;
      }
    } catch (error) {
      out(t("testFailed", { channel: id, error: error.message }));
      process.exitCode = 1;
    }
    return;
  }

  if (action === "send") {
    const text = String(flags.text ?? positionals.join(" "));
    const files = flags.file ? [String(flags.file)] : [];
    if (String(flags.to ?? "owner") !== "owner") {
      throw new Error("gateway send only goes to the owner (--to owner)");
    }
    const channel = flags.channel ? String(flags.channel) : null;
    const targets = gateway.ownerTargets(channel);
    if (!flags.yes) {
      out(t("sendDryRun"));
      for (const target of targets) {
        out(t("sendTarget", { channel: target.channel, target: maskId(target.target) }));
      }
      out(t("sendText"));
      out(formatForChat(text));
      return;
    }
    const result = await gateway.notify({ text, level: String(flags.level ?? "info"), files, channel });
    for (const entry of result.results.filter((item) => !item.ok)) {
      out(t("sendFailed", { channel: entry.channel, target: entry.target, error: entry.error }));
    }
    out(t("sendDone", { sent: result.sent }));
    return;
  }

  if (action === "poll") {
    const result = await gateway.pollOnce({ channel: flags.channel ? String(flags.channel) : null, timeoutS: 0 });
    for (const entry of result.channels) {
      if (entry.error) {
        out(t("pollError", { channel: entry.channel, error: entry.error }));
        continue;
      }
      const outcomes = (entry.outcomes ?? []).map((outcome) => outcome.action).join(", ") || "-";
      out(t("pollDone", { channel: entry.channel, received: entry.received ?? 0, outcomes }));
    }
    out(t("pollSummary", { announced: result.announced, flushed: result.flushed }));
    return;
  }

  if (action === "serve") {
    // Foreground service, for systems where the AStack daemon is not installed.
    const service = createService({ runtime, log: out });
    await service.start();
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await service.stop();
    return;
  }

  if (action === "owners") {
    out(t("ownersTitle"));
    for (const id of ["whatsapp-wapi", "whatsapp-bridge", "whatsapp-cloud", "telegram"]) {
      const owners = gateway.owners(id);
      const groups = gateway.groups(id);
      out(t("ownerLine", { channel: id, entries: [...owners.map(maskId), ...groups.map((group) => "group " + maskId(group))].join(", ") || "-" }));
    }
    return;
  }

  if (action === "owner") {
    const [verb, channel, entry] = positionals;
    if (!["add", "remove"].includes(verb) || !channel || !entry) {
      throw new Error("usage: astack gateway owner add|remove <channel> <id> [--group]");
    }
    const list = gateway.editOwners(channel, entry, { remove: verb === "remove", group: Boolean(flags.group) });
    out(t("ownerSaved", { channel, count: list.length }));
    return;
  }

  if (action === "voice") {
    const voice = gateway.voice();
    const [verb = "status", file] = positionals;
    if (verb === "setup" || verb === "status") {
      const detected = await voice.detect();
      out(t("voiceCheck", { state: detected.ok ? detected.faster_whisper + " (cuda devices: " + (detected.cuda_devices ?? 0) + ")" : detected.error }));
      if (detected.policy) {
        out(t("voicePolicyHint", { python: voice.config.python }));
      }
      if (verb === "setup" && !detected.ok && !detected.policy) {
        const install = voice.setupCommand();
        out(t("voiceSetupHint", { command: install.command + " " + install.args.join(" ") }));
        if (flags.yes) {
          const verdict = runtime.automationPolicy.allowInvocation(install.command, install.args);
          if (!verdict.allowed) {
            out(t("voicePolicyHint", { python: voice.config.python }));
            process.exitCode = 1;
            return;
          }
          const result = spawnSync(install.command, install.args, { stdio: "inherit" });
          process.exitCode = result.status ?? 1;
        }
      }
      return;
    }
    if (verb === "test") {
      if (!file) {
        throw new Error("usage: astack gateway voice test <audio file> [--language fa] [--model large-v3-turbo]");
      }
      const result = await voice.transcribe(file, {
        ...(flags.language ? { language: String(flags.language) } : {}),
        ...(flags.model ? { model: String(flags.model) } : {}),
        ...(flags.device ? { device: String(flags.device) } : {})
      });
      if (!result.ok) {
        out(t("voiceCheck", { state: result.error }));
        if (result.policy) {
          out(t("voicePolicyHint", { python: voice.config.python }));
        }
        process.exitCode = 1;
        return;
      }
      out(t("voiceResult", { text: result.text }));
      out(t("voiceMeta", result));
      return;
    }
    throw new Error(t("unknownAction", { action: "voice " + verb }));
  }

  if (action === "whatsapp") {
    const [verb = "status"] = positionals;
    const manager = new BridgeManager(join(gateway.directory, "bridge"), {
      policy: runtime.automationPolicy,
      config: gateway.channelConfig("whatsapp-bridge"),
      log: out
    });
    const allowed = { allowedUsers: gateway.owners("whatsapp-bridge"), allowedGroups: gateway.groups("whatsapp-bridge") };
    if (verb === "status") {
      const status = await manager.status();
      out(t("bridgeStatus", { ...status, installed: status.installed ? "yes" : "no", paired: status.paired ? "yes" : "no" }));
      return;
    }
    if (verb === "setup") {
      out(t("bridgeWarning"));
      out(t("bridgeSetup", { path: manager.appDirectory }));
      const result = manager.setup({ dryRun: Boolean(flags.dryRun) });
      if (result.dryRun) {
        out(JSON.stringify(result, null, 2));
        return;
      }
      if (!result.ok) {
        out(t("bridgeSetupFailed", { reason: result.reason ?? result.output ?? "exit " + result.exitCode }));
        process.exitCode = 1;
        return;
      }
      const check = manager.selfTest();
      out(check.ok ? t("bridgeSetupDone") : t("bridgeSetupFailed", { reason: check.reason ?? check.output }));
      if (!check.ok) {
        process.exitCode = 1;
      }
      return;
    }
    if (verb === "pair") {
      out(t("bridgeWarning"));
      const result = manager.pair(allowed);
      if (!result.ok) {
        out(t("bridgeFailed", { reason: result.reason ?? "exit " + result.exitCode }));
        process.exitCode = 1;
      }
      return;
    }
    if (verb === "start") {
      const result = await manager.start(allowed);
      out(result.ok ? t("bridgeStarted", { pid: result.pid }) : t("bridgeFailed", { reason: result.reason }));
      if (!result.ok) {
        process.exitCode = 1;
      }
      return;
    }
    if (verb === "stop") {
      const result = await manager.stop();
      out(result.ok ? t("bridgeStopped") : t("bridgeFailed", { reason: result.reason ?? result.state }));
      return;
    }
    throw new Error(t("unknownAction", { action: "whatsapp " + verb }));
  }

  throw new Error(t("unknownAction", { action }));
}
