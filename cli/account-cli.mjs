import { parseArgs } from "../delivery-engine/cli.mjs";
import { AccountError, ClaudeAccounts, countLiveTurns, turnsFilePath } from "../console/accounts.mjs";

const out = (line) => console.log(line);

function pick(accounts, name) {
  const wanted = String(name ?? "").trim().toLowerCase();
  return accounts.find((account) => account.id === wanted || String(account.email).toLowerCase() === wanted || (account.label && account.label.toLowerCase() === wanted)) ?? null;
}

/**
 * astack account list|save|switch|usage|label|remove
 * The same service the console uses (console/accounts.mjs); tokens are never printed.
 * Changing the login (save, switch, label, remove) is refused in unattended
 * processes (chat and runner children) by the service itself.
 */
export async function runAccountCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const k = (key, params) => t("console.accounts.cli." + key, params);
  // The localized text of an error code; the English message stays as the fallback.
  const known = (code, params, fallback) => {
    if (!code) {
      return fallback;
    }
    const key = "console.accounts.errors." + code;
    const text = t(key, params ?? {});
    return text && text !== key ? text : fallback;
  };
  const [action = "list", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  // Console chat turns are recorded on disk by the running console, so a switch here refuses like the console does.
  const accounts = new ClaudeAccounts({ runtime, chatTurns: () => countLiveTurns(turnsFilePath(runtime)) });
  try {
    if (["list", "ls", "status"].includes(action)) {
      const state = await accounts.list();
      if (flags.json) {
        out(JSON.stringify(state, null, 2));
        return;
      }
      out(state.active.email ? k("current", { email: state.active.email, plan: state.active.plan ?? "-" }) : k("currentNone"));
      if (state.active.email && !state.active.profileId) {
        out(k("currentUnsaved"));
      }
      if (!state.accounts.length) {
        out(k("none"));
      }
      for (const account of state.accounts) {
        out(k("row", { mark: account.active ? "*" : " ", email: account.email, label: account.label ? " (" + account.label + ")" : "", id: account.id, plan: account.plan ?? "-" }));
      }
      out(k("running", { count: state.running.length }));
      if (state.chatTurnsRunning) {
        out(k("chatTurns", { count: state.chatTurnsRunning }));
      }
      return;
    }
    if (action === "save") {
      const profile = accounts.save({ label: typeof flags.label === "string" ? flags.label : null });
      out(k("saved", { email: profile.email, id: profile.id }));
      return;
    }
    if (action === "switch") {
      if (!positionals[0]) {
        throw new Error(k("needName"));
      }
      const target = pick(accounts.profiles(), positionals.join(" "));
      if (!target) {
        throw new Error(k("unknown", { name: positionals.join(" ") }));
      }
      const result = await accounts.switch(target.id, { force: flags.force === true });
      out(k("switched", { email: result.active.email ?? target.email }));
      for (const warning of result.warnings) {
        out(k("warning", { text: t("console.accounts.warnings." + warning) }));
      }
      return;
    }
    if (action === "usage") {
      const target = positionals[0] ? pick(accounts.profiles(), positionals.join(" ")) : null;
      if (positionals[0] && !target) {
        throw new Error(k("unknown", { name: positionals.join(" ") }));
      }
      const usage = await accounts.usage(target?.id ?? null);
      if (flags.json) {
        out(JSON.stringify(usage, null, 2));
        return;
      }
      if (usage.error) {
        out(k("usageFailed", { error: known(usage.code, { status: usage.status ?? "" }, usage.error) }));
        return;
      }
      out(k("usageHead", { email: target?.email ?? accounts.activeEmail() ?? "-" }));
      out(k("usageLine", { name: k("five"), pct: usage.fiveHour.pct ?? "-", resets: usage.fiveHour.resetsAt ?? "-" }));
      out(k("usageLine", { name: k("seven"), pct: usage.sevenDay.pct ?? "-", resets: usage.sevenDay.resetsAt ?? "-" }));
      return;
    }
    if (action === "label" || action === "remove" || action === "rm") {
      const target = pick(accounts.profiles(), positionals[0]);
      if (!positionals[0]) {
        throw new Error(k("needName"));
      }
      if (!target) {
        throw new Error(k("unknown", { name: positionals[0] }));
      }
      if (action === "label") {
        accounts.label(target.id, positionals.slice(1).join(" "));
        out(k("labeled", { id: target.id }));
      } else {
        accounts.remove(target.id);
        out(k("removed", { id: target.id }));
      }
      return;
    }
    out(k("usage"));
  } catch (error) {
    if (error instanceof AccountError) {
      const text = known(error.code, error.details ?? {}, error.message);
      throw new Error(error.code === "turn-running" ? text + " " + k("forceHint") : text);
    }
    throw error;
  }
}
