import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../delivery-engine/cli.mjs";

const out = (line) => console.log(line);

function scopeOf(flags) {
  return { project: flags.project ? String(flags.project) : null, all: flags.all === true };
}

function describe(result, t) {
  const id = String(result.id ?? "").slice(0, 8);
  if (result.status === "renamed") {
    return t("cli.session.renamed", { id, from: result.from || "-", title: result.title });
  }
  if (result.status === "would-rename") {
    return t("cli.session.wouldRename", { id, from: result.from || "-", title: result.title });
  }
  if (result.status === "kept-owner") {
    return t("cli.session.keptOwner", { id, title: result.title });
  }
  if (result.status === "restored") {
    return t("cli.session.restored", { id, from: result.from, title: result.title });
  }
  if (result.status === "error") {
    return t("cli.session.error", { id: id || "?", error: result.error });
  }
  return t("cli.session.skipped", { id, reason: result.reason ?? result.status });
}

function describeRemote(remote, t) {
  if (!remote.remote) {
    return t("cli.session.remoteLocal");
  }
  return remote.failed ? t("cli.session.remoteFailed", { failed: remote.failed, reason: remote.reason ?? "-" }) : t("cli.session.remotePushed", { pushed: remote.pushed });
}

/**
 * astack session list|digest|title|apply|undo|find|sync|status
 */
export async function runSessionCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "status", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const titles = runtime.sessionTitles;

  if (action === "status") {
    const status = titles.status(scopeOf(flags));
    out(t("cli.session.statusTitle", { state: status.enabled ? t("cli.session.on") : t("cli.session.off") }));
    out("- " + t("cli.session.projects", { projects: status.projects.join(", ") || "-" }));
    out("- " + t("cli.session.counts", status.counts));
    out("- " + t("cli.session.rules", { turns: status.config.first_after_turns, minutes: status.config.first_after_minutes, recheck: status.config.recheck_turns.join(", ") || "-", length: status.config.max_length }));
    out("- " + t("cli.session.remoteSetting", { state: status.config.sync_remote ? t("cli.session.on") : t("cli.session.off") }));
    out("- " + t("cli.session.history", { renamed: status.renamed, batch: status.lastBatch ?? "-" }));
    return;
  }
  if (action === "list") {
    const sessions = titles.sessions({ ...scopeOf(flags), weak: flags.weak === true });
    for (const session of sessions) {
      out(session.id.slice(0, 8) + "  " + session.lastAt.slice(0, 10) + "  " + session.source.padEnd(6) + "  " + session.project.slice(0, 28).padEnd(28) + "  " + (session.title || "(" + t("cli.session.untitled") + ")"));
    }
    out(t("cli.session.listed", { count: sessions.length }));
    return;
  }
  if (action === "digest") {
    const digest = titles.digest({ ...scopeOf(flags), weak: flags.weak === true });
    const json = JSON.stringify(digest, null, 1);
    if (flags.out) {
      writeFileSync(String(flags.out), json);
      out(t("cli.session.digestWritten", { count: digest.length, path: String(flags.out) }));
    } else {
      out(json);
    }
    return;
  }
  if (action === "title") {
    const session = flags.session ? String(flags.session) : null;
    const title = positionals.join(" ");
    if (!session || !title) {
      throw new Error(t("cli.session.titleUsage"));
    }
    const result = titles.setTitle(session, title, {
      force: flags.force === true,
      dryRun: flags.dryRun === true,
      runtime: flags.runtime ? String(flags.runtime) : null
    });
    out(describe(result, t));
    if (result.status === "renamed") {
      out("- " + describeRemote(await titles.pushRemote(titles.resolve(result.id), result.title), t));
    }
    return;
  }
  if (action === "apply") {
    const file = positionals[0];
    if (!file) {
      throw new Error(t("cli.session.applyUsage"));
    }
    const entries = JSON.parse(readFileSync(file, "utf8"));
    const report = titles.apply(entries, { force: flags.force === true, dryRun: flags.dryRun === true, runtime: flags.runtime ? String(flags.runtime) : null });
    for (const result of report.results) {
      out(describe(result, t));
    }
    const renamed = report.results.filter((result) => result.status === "renamed");
    out(t("cli.session.applied", { renamed: renamed.length, total: report.results.length, batch: report.batch ?? "-" }));
    if (renamed.length) {
      const remote = { pushed: 0, failed: 0 };
      for (const result of renamed) {
        const pushed = await titles.pushRemote(titles.resolve(result.id), result.title);
        remote.pushed += pushed.pushed;
        remote.failed += pushed.failed;
      }
      out("- " + t("cli.session.remoteTotals", remote));
    }
    return;
  }
  if (action === "undo") {
    const report = titles.undo({ batch: flags.batch ? String(flags.batch) : null, session: flags.session ? String(flags.session) : null });
    for (const result of report.results) {
      out(describe(result, t));
    }
    if (!report.results.length) {
      out(t("cli.session.nothingToUndo"));
      return;
    }
    // Only the chats this undo restored go to the phone, nothing else.
    const remote = { pushed: 0, failed: 0 };
    for (const result of report.results.filter((entry) => entry.status === "restored")) {
      const pushed = await titles.pushRemote(result.file, result.title);
      remote.pushed += pushed.pushed;
      remote.failed += pushed.failed;
    }
    out("- " + t("cli.session.remoteTotals", remote));
    return;
  }
  if (action === "find") {
    const query = positionals.join(" ");
    if (!query) {
      throw new Error(t("cli.session.findUsage"));
    }
    const hits = titles.find(query, { ...scopeOf(flags), limit: Number(flags.limit) > 0 ? Number(flags.limit) : 5 });
    if (!hits.length) {
      out(t("cli.session.noMatch"));
      return;
    }
    for (const hit of hits) {
      out(hit.id.slice(0, 8) + "  " + hit.lastAt.slice(0, 10) + "  " + hit.project.slice(0, 28).padEnd(28) + "  " + hit.title + "  (" + hit.score + ")");
    }
    return;
  }
  if (action === "hook") {
    // astack session hook status|install|remove — the user-level prompt hook
    // that watches every chat on this machine. It runs the canonical core
    // (~/.astack/core), which `astack update` keeps current.
    const step = positionals[0] ?? "status";
    if (step === "status") {
      const status = titles.userHookStatus();
      out(t(status.installed ? "cli.session.userHookOn" : "cli.session.userHookOff", { path: status.path, command: status.command ?? "-" }));
      return;
    }
    if (step !== "install" && step !== "remove") {
      throw new Error(t("cli.session.hookUsage"));
    }
    const canonical = join(homedir(), ".astack", "core", "bin", "astack.mjs");
    const cli = flags.cli ? String(flags.cli) : existsSync(canonical) ? canonical : titles.cli;
    const result = titles.installUserHook({ cli, dryRun: flags.dryRun === true, remove: step === "remove" });
    out(t(result.changed ? (step === "remove" ? "cli.session.userHookRemoved" : "cli.session.userHookInstalled") : "cli.session.userHookUnchanged", { path: result.path, backup: result.backup ?? "-" }));
    return;
  }
  if (action === "remote-logs") {
    // astack session remote-logs list|add <dir> — where Remote Control servers
    // write their per-chat logs (--debug-file); phone chats are linked from them.
    const step = positionals[0] ?? "list";
    if (step === "add") {
      titles.addRemoteLogDir(positionals[1]);
    } else if (step !== "list") {
      throw new Error(t("cli.session.remoteLogsUsage"));
    }
    const map = titles.remoteMap();
    out(t("cli.session.remoteLogs", { dirs: titles.remoteLogDirs().join(", ") || "-", linked: map.size }));
    return;
  }
  if (action === "sync") {
    const totals = await titles.syncRemote({ ...scopeOf(flags), session: flags.session ? String(flags.session) : null });
    out(t("cli.session.synced", totals));
    for (const [reason, count] of Object.entries(totals.reasons)) {
      out("- " + reason + ": " + count);
    }
    return;
  }
  throw new Error(t("cli.session.unknownAction", { action }));
}
