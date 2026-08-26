import { parseArgs } from "../delivery-engine/cli.mjs";
import { authorityLevels, authorityMeaning } from "../trust-engine/authority.mjs";

const out = (line) => console.log(line);

function table(rows) {
  for (const row of rows) {
    out(String(row).startsWith("-") ? String(row) : "- " + row);
  }
}

export function runAuthorityCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "show", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const authority = runtime.authority;

  if (action === "show" || action === "levels") {
    const policy = authority.describe();
    out(t("cli.authority.title", { level: policy.defaultLevel }));
    table(authorityLevels.map((level) => level + " — " + authorityMeaning[level].fa));
    out(t("cli.authority.scopes"));
    table([
      "autonomous: " + policy.autonomous.join(", "),
      "requires approval: " + policy.requireApproval.join(", "),
      ...Object.entries(policy.domains).map(([key, value]) => "domain " + key + ": " + value),
      ...Object.entries(policy.tools).map(([key, value]) => "tool " + key + ": " + value),
      ...Object.entries(policy.sites).map(([key, value]) => "site " + key + ": " + value)
    ]);
    return;
  }
  if (action === "default") {
    authority.setDefault(positionals[0]);
    out(t("cli.authority.defaultSet", { level: positionals[0] }));
    return;
  }
  if (action === "set") {
    authority.setScope(positionals[0], positionals[1], positionals[2]);
    out(t("cli.authority.scopeSet", { kind: positionals[0], key: positionals[1], level: positionals[2] }));
    return;
  }
  if (action === "check") {
    const decision = authority.evaluate({
      action: positionals.join(" ") || "action",
      level: String(flags.level ?? "L3"),
      domain: flags.domain ? String(flags.domain) : null,
      tool: flags.tool ? String(flags.tool) : null,
      site: flags.site ? String(flags.site) : null
    });
    out(t("cli.authority.decision", {
      level: decision.level,
      state: decision.blocked ? "blocked" : decision.requiresApproval ? "approval" : "allowed",
      reason: decision.reason
    }));
    return;
  }
  throw new Error(t("cli.authority.unknownAction", { action }));
}

export function runApprovalCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "list", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const approvals = runtime.approvals;

  if (action === "list") {
    const list = approvals.list({ state: flags.state ? String(flags.state) : null, limit: Number(flags.limit ?? 20) });
    out(t("cli.approval.listTitle", { count: list.length }));
    table(list.map((entry) => entry.id + " | " + entry.state + " | " + entry.level + " | " + entry.action + " | " + entry.summary.slice(0, 60)));
    return;
  }
  if (action === "pending") {
    const list = approvals.pending();
    out(t("cli.approval.pendingTitle", { count: list.length }));
    for (const entry of list) {
      out("- " + entry.id + " | " + entry.action + " | " + entry.summary);
      out("    parameters: " + JSON.stringify(entry.parameters));
      out("    mission: " + (entry.mission ?? "-") + " | expires: " + entry.expiresAt);
    }
    return;
  }
  if (action === "show") {
    out(JSON.stringify(approvals.get(positionals[0]), null, 2));
    return;
  }
  if (action === "approve" || action === "reject") {
    const record = action === "approve"
      ? approvals.approve(positionals[0], { by: String(flags.by ?? "owner"), note: flags.note ? String(flags.note) : null })
      : approvals.reject(positionals[0], { by: String(flags.by ?? "owner"), note: flags.note ? String(flags.note) : null });
    out(t("cli.approval.decided", { id: record.id, state: record.state, receipt: record.receipt?.id ?? "-" }));
    return;
  }
  if (action === "request") {
    const record = approvals.request({
      action: String(flags.action ?? positionals[0]),
      summary: positionals.slice(1).join(" ") || String(flags.summary ?? ""),
      level: String(flags.level ?? "L4"),
      mission: flags.mission ? String(flags.mission) : null,
      tool: flags.tool ? String(flags.tool) : null,
      target: flags.target ? String(flags.target) : null
    });
    out(t("cli.approval.requested", { id: record.id, action: record.action }));
    return;
  }
  throw new Error(t("cli.approval.unknownAction", { action }));
}

export function runAuditCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "list", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const audit = runtime.audit;

  if (action === "list") {
    const entries = audit.list({
      limit: Number(flags.limit ?? 20),
      action: flags.action ? String(flags.action) : null,
      mission: flags.mission ? String(flags.mission) : null,
      project: flags.project ? String(flags.project) : null,
      riskLevel: flags.level ? String(flags.level) : null
    });
    out(t("cli.audit.listTitle", { count: entries.length }));
    table(entries.map((entry) =>
      entry.id + " | " + entry.timestamp.slice(0, 19) + " | " + entry.actor + " | " + entry.action +
      " | " + entry.riskLevel + " | " + (entry.approval ?? "-") + " | " + (entry.result ?? "").slice(0, 50)
    ));
    return;
  }
  if (action === "show") {
    const entry = audit.get(positionals[0]);
    if (!entry) {
      throw new Error("Unknown audit record: " + positionals[0]);
    }
    out(JSON.stringify(entry, null, 2));
    return;
  }
  if (action === "stats") {
    const stats = audit.stats({ month: flags.month ? String(flags.month) : null });
    out(t("cli.audit.statsTitle", { records: stats.records, approved: stats.approved, evidence: stats.withEvidence }));
    table(Object.entries(stats.byAction).slice(0, 15).map(([key, value]) => key + ": " + value));
    return;
  }
  throw new Error(t("cli.audit.unknownAction", { action }));
}

export function runSecretCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "list", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const secrets = runtime.secrets;

  if (action === "list") {
    const list = secrets.list();
    out(t("cli.secret.listTitle", { count: list.length }));
    table(list.map((entry) => entry.reference + " | " + entry.source + " | " + (entry.available ? "available" : "missing") + " | env " + entry.envVariable));
    return;
  }
  if (action === "register") {
    const record = secrets.register({
      reference: positionals[0],
      description: flags.describe ? String(flags.describe) : "",
      source: String(flags.source ?? "env"),
      site: flags.site ? String(flags.site) : null,
      scope: flags.scope ? String(flags.scope).split(",").map((entry) => entry.trim()) : [],
      expiresAt: flags.expires ? String(flags.expires) : null
    });
    out(t("cli.secret.registered", { reference: record.reference, env: record.envVariable }));
    return;
  }
  if (action === "describe") {
    out(JSON.stringify(secrets.describe(positionals[0]), null, 2));
    return;
  }
  if (action === "check") {
    out(t("cli.secret.check", { reference: positionals[0], available: secrets.available(positionals[0]) ? "yes" : "no" }));
    return;
  }
  if (action === "remove") {
    const record = secrets.remove(positionals[0]);
    out(t("cli.secret.removed", { reference: record?.reference ?? positionals[0] }));
    return;
  }
  throw new Error(t("cli.secret.unknownAction", { action }));
}

export function runToolCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "list", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const tools = runtime.tools;

  if (action === "list") {
    const list = tools.list({ status: flags.status ? String(flags.status) : null });
    out(t("cli.tool.listTitle", { count: list.length }));
    table(list.map((tool) => tool.id + " | " + tool.status + " | " + tool.riskLevel + " | " + (tool.capabilities ?? []).join(",")));
    return;
  }
  if (action === "catalog") {
    const catalog = tools.catalog({ budget: Number(flags.budget ?? 500) });
    table(catalog.lines);
    out(t("cli.tool.catalogSummary", { tools: catalog.tools, total: catalog.total, tokens: catalog.tokens }));
    return;
  }
  if (action === "search") {
    table(tools.search(positionals.join(" "), { limit: Number(flags.limit ?? 5) }).map((tool) => tool.id + " | " + tool.status + " | " + tool.riskLevel + " | score " + tool.score));
    return;
  }
  if (action === "inspect") {
    out(JSON.stringify(tools.inspect(positionals[0]), null, 2));
    return;
  }
  if (action === "stats") {
    out(JSON.stringify(tools.stats(), null, 2));
    return;
  }
  throw new Error(t("cli.tool.unknownAction", { action }));
}

export async function runRuntimeCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "list", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);

  if (action === "list") {
    const list = runtime.runtimes.list();
    out(t("cli.runtime.listTitle", { count: list.length }));
    table(list.map((entry) => entry.id + " | " + entry.status + " | " + (entry.available ? "available" : "unavailable") + " | " + (entry.capabilities ?? []).join(",")));
    return;
  }
  if (action === "status") {
    table(runtime.runtimes.status().map((entry) => entry.runtime + " | sessions " + entry.sessions + " | active " + entry.active + " | completed " + entry.completed));
    return;
  }
  if (action === "test") {
    const id = positionals[0] ?? "mock";
    const adapter = runtime.runtimes.get(id);
    const session = adapter.start({ role: "diagnostic", objective: "runtime self test" });
    const result = await adapter.run(session.id);
    out(t("cli.runtime.tested", { id, state: result.state, session: session.id }));
    return;
  }
  if (action === "route") {
    const decision = runtime.modelRouter.route({
      task: positionals.join(" "),
      risk: String(flags.risk ?? "L1"),
      contextTokens: Number(flags.context ?? 0)
    });
    out(t("cli.runtime.routed", { taskClass: decision.taskClass, tier: decision.tier, runtime: decision.runtime ?? "-", reason: decision.reason }));
    return;
  }
  if (action === "performance") {
    out(JSON.stringify(runtime.modelRouter.performance(), null, 2));
    return;
  }
  throw new Error(t("cli.runtime.unknownAction", { action }));
}
