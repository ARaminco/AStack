import { parseArgs } from "../delivery-engine/cli.mjs";

const out = (line) => console.log(line);

export function runGraphifyCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "status", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const graphify = runtime.graphify;

  if (action === "status") {
    const status = graphify.status();
    out(t("cli.graphify.statusTitle"));
    out("- " + (status.installed ? t("cli.graphify.installed", { version: status.version }) : t("cli.graphify.notInstalled")));
    const graph = status.graph;
    out("- " + (graph.built
      ? t("cli.graphify.graph", { path: graph.path, nodes: graph.nodes ?? "?", edges: graph.edges ?? "?", at: String(graph.builtAt).slice(0, 16).replace("T", " "), state: graph.stale ? t("cli.graphify.stale") : t("cli.graphify.fresh") })
      : t("cli.graphify.noGraph")));
    out("- " + t(status.hooks ? "cli.graphify.hooksOn" : "cli.graphify.hooksOff"));
    out("- " + t("cli.graphify.budget", status.budget));
    const usage = status.usage;
    out("- " + t("cli.graphify.usage", { queries: usage.queries, served: usage.tokensServed, truncated: usage.truncated }));
    if (usage.benchmark) {
      out("- " + t("cli.graphify.benchmark", { reduction: usage.benchmark.reduction, avg: usage.benchmark.avgQueryTokens, naive: usage.benchmark.naiveTokens, saved: usage.estimatedSaved ?? "-" }));
    }
    return;
  }
  if (action === "setup" || action === "upgrade") {
    const result = graphify.setup({ upgrade: action === "upgrade" || Boolean(flags.upgrade), hooks: !flags.noHooks, build: !flags.noBuild });
    for (const step of result.steps) {
      out("- " + (step.ok ? "✓ " : step.fallback ? "↷ " : "✗ ") + step.step + (step.detail ? " — " + step.detail : ""));
    }
    out(result.ok ? t("cli.graphify.ready", { version: result.version }) : t("cli.graphify.setupFailed"));
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }
  if (action === "build" || action === "update") {
    const step = graphify.build({ force: Boolean(flags.force) });
    out((step.ok ? "✓ " : "✗ ") + step.step + " — " + step.detail);
    if (!step.ok) {
      process.exitCode = 1;
    }
    return;
  }
  if (["query", "explain", "path", "affected"].includes(action)) {
    const terms = action === "path" ? positionals.slice(0, 2) : [positionals.join(" ")];
    const result = graphify.ask(action, terms, { budget: flags.budget });
    out(result.text);
    if (result.ok) {
      out(t("cli.graphify.served", { tokens: result.tokens, budget: result.budget }));
    } else {
      process.exitCode = 1;
    }
    return;
  }
  if (action === "benchmark") {
    const report = graphify.benchmark();
    out(report ? t("cli.graphify.benchmark", { reduction: report.reduction, avg: report.avgQueryTokens, naive: report.naiveTokens, saved: "-" }) : t("cli.graphify.noGraph"));
    return;
  }
  throw new Error(t("cli.graphify.unknownAction", { action }));
}
