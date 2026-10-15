import { parseArgs } from "../delivery-engine/cli.mjs";
import { significant } from "../skill-hub/scanner.mjs";
import { oneLine, requesterOf } from "../skill-hub/online/online.mjs";

const out = (line) => console.log(line);

function truthy(value) {
  return value !== undefined && value !== false && value !== "false";
}

function engineOf(runtime, t) {
  if (!runtime.skillOnline) {
    throw new Error(t("cli.skillOnline.unavailable"));
  }
  return runtime.skillOnline;
}

function popularity(hit) {
  if (hit.popularityKind === "official") {
    return "official";
  }
  return hit.popularity === null || hit.popularity === undefined ? "-" : Number(hit.popularity).toLocaleString("en-US") + " " + hit.popularityKind;
}

function withHint(error, t) {
  if (error?.hint) {
    const wrapped = new Error(error.message + "\n  " + t("cli.skillOnline.hint", { command: error.hint }));
    wrapped.hint = error.hint;
    return wrapped;
  }
  return error;
}

/**
 * `astack skill online <search|show|get|approve|status>`
 *
 * Free values (a query, an id) may follow "--". `approve` is the owner's
 * decision and is refused over MCP and in unattended runs.
 */
export async function runSkillOnlineCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "status", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const engine = engineOf(runtime, t);
  const json = truthy(flags.json);
  const requireSearched = truthy(flags.fromSearch);
  const requester = requesterOf(flags.requester ? String(flags.requester) : null);
  const finding = (entry) => "- [" + entry.severity + "] " + entry.rule + " " + oneLine(entry.file, 160) + ":" + entry.line + " " + oneLine(entry.excerpt, 90);

  try {
    if (action === "search") {
      const query = positionals.join(" ");
      const result = await engine.search(query, {
        sources: flags.source ? String(flags.source) : null,
        limit: flags.limit ? Number(flags.limit) : null,
        refresh: truthy(flags.refresh),
        requester
      });
      if (json) {
        out(JSON.stringify(result, null, 2));
        return;
      }
      out(t("cli.skillOnline.searchTitle", { query: result.query, count: result.results.length }));
      for (const hit of result.results) {
        out("- " + oneLine(hit.id, 200) + " | " + oneLine(hit.name, 120) + " | " + popularity(hit) + " | " + hit.sources.join(",") + " | score " + hit.score + (hit.description ? " | " + oneLine(hit.description, 90) : ""));
      }
      for (const source of result.sources) {
        if (source.ok) {
          out("  " + t("cli.skillOnline.sourceOk", { source: source.source, count: source.count, cached: source.cached ? t("cli.skillOnline.cached") : "" }).trimEnd());
          for (const warning of source.warnings ?? []) {
            out("    " + t("cli.skillOnline.sourceWarning", { part: warning.part, error: warning.error }) + (warning.hint ? " — " + t("cli.skillOnline.hint", { command: warning.hint }) : ""));
          }
        } else {
          out("  " + t("cli.skillOnline.sourceFailed", { source: source.source, error: source.error }) + (source.hint ? " — " + t("cli.skillOnline.hint", { command: source.hint }) : ""));
        }
      }
      if (result.results.length) {
        out(t("cli.skillOnline.searchHint"));
      }
      return;
    }
    if (action === "show") {
      const result = await engine.show(positionals[0], { requireSearched, requester });
      if (json) {
        out(JSON.stringify(result, null, 2));
        return;
      }
      const findings = significant(result.scan.findings);
      out(t("cli.skillOnline.showTitle", { id: result.hit.id, risk: result.scan.risk, findings: findings.length, scripts: result.scan.scripts.length, tokens: result.tokens }));
      out(t("cli.skillOnline.origin", { url: result.origin.url, revision: result.origin.commit ?? result.origin.version ?? "-" }));
      if (result.scan.risk === "blocked") {
        out(t("cli.skillOnline.wouldRefuse"));
      } else if (result.scan.requiresReview) {
        out(t("cli.skillOnline.requiresReview"));
      }
      for (const entry of findings.slice(0, Number(flags.findings ?? 12))) {
        out(finding(entry));
      }
      if (result.wrapped === null || result.withheld) {
        out(t("cli.skillOnline.withheld"));
        return;
      }
      out(t("cli.skillOnline.dataNotice"));
      out("");
      out(result.wrapped);
      return;
    }
    if (action === "get") {
      const result = await engine.get(positionals[0], { pack: flags.pack ? String(flags.pack) : null, dryRun: truthy(flags.dryRun), requireSearched, requester });
      if (json) {
        out(JSON.stringify(result, null, 2));
        return;
      }
      const findings = significant(result.scan.findings);
      const values = {
        id: result.id ?? result.hit.id,
        source: result.hit.id,
        registry: result.origin.registry,
        url: result.origin.url,
        revision: result.origin.commit ? result.origin.commit.slice(0, 12) : result.origin.version ?? "-",
        risk: result.risk ?? result.scan.risk,
        findings: findings.length,
        pack: result.pack,
        path: result.path ?? "",
        command: result.approveCommand ?? ""
      };
      out(t("cli.skillOnline.get." + result.status, values));
      for (const entry of findings.filter((item) => item.severity === "high" || item.severity === "critical").slice(0, 8)) {
        out(finding(entry));
      }
      if (result.status === "imported" || result.status === "flagged") {
        out(t(result.approval === "approved" ? "cli.skillOnline.approvalKept" : "cli.skillOnline.pendingApproval", values));
        out(t("cli.skillOnline.ownerLine", values));
      }
      if (result.status === "refused") {
        process.exitCode = 2;
      }
      return;
    }
    if (action === "approve") {
      const result = await engine.approve(positionals[0], { by: "owner-cli" });
      if (json) {
        out(JSON.stringify(result, null, 2));
        return;
      }
      out(t(result.autoSelect ? "cli.skillOnline.approved" : "cli.skillOnline.approvedReviewOnly", { id: result.id, risk: result.risk }));
      return;
    }
    if (action === "status") {
      const status = engine.status();
      out(t("cli.skillOnline.status", { state: status.enabled ? t("cli.skillHub.enabled") : t("cli.skillOnline.disabled"), sources: status.sources.join(", "), limit: status.limit, minutes: status.cacheMinutes, pack: status.pack }));
      return;
    }
  } catch (error) {
    throw withHint(error, t);
  }
  throw new Error(t("cli.skillOnline.unknownAction", { action }));
}
