import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "../lib/text.mjs";

/**
 * Graphify adapter: a code knowledge graph as a token-budgeted context source.
 *
 * Graphify (PyPI `graphifyy`, command `graphify`) parses the workspace with
 * tree-sitter into graphify-out/graph.json and answers questions with a scoped
 * subgraph instead of raw files. AStack drives it rather than letting its
 * per-platform installers write CLAUDE.md and AGENTS.md separately: the
 * guidance lives once in the shared contract, both runtimes reach the graph
 * through the astack MCP server, and every answer is capped by an AStack
 * budget and metered, so savings are measured rather than assumed.
 */

export const GRAPHIFY_PACKAGE = "graphifyy";
const DEFAULTS = { enabled: true, output: "graphify-out", query_budget: 1500, max_budget: 4000 };

function defaultRun(command, args, { cwd, timeout = 600000 } = {}) {
  try {
    const stdout = execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }
    });
    return { ok: true, stdout: String(stdout ?? ""), stderr: "" };
  } catch (error) {
    return {
      ok: false,
      missing: error.code === "ENOENT",
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? error.message ?? "")
    };
  }
}

/** Trim text to a token budget on a line boundary and say what was cut. */
export function fitToBudget(text, budget) {
  const tokens = estimateTokens(text);
  if (tokens <= budget) {
    return { text, tokens, truncated: false };
  }
  const kept = [];
  let used = 0;
  for (const line of text.split(/\r?\n/)) {
    const cost = estimateTokens(line) + 1;
    if (used + cost > budget) {
      break;
    }
    kept.push(line);
    used += cost;
  }
  kept.push("… truncated at " + budget + " tokens (" + tokens + " available); narrow the question or raise --budget");
  return { text: kept.join("\n"), tokens: used, truncated: true };
}

export class GraphifyAdapter {
  constructor(workspaceRoot, { config = {}, run = defaultRun, clock } = {}) {
    this.root = workspaceRoot;
    this.config = { ...DEFAULTS, ...config };
    this.run = run;
    this.clock = clock ?? (() => new Date());
    this.output = join(workspaceRoot, this.config.output);
    this.usagePath = join(workspaceRoot, ".astack", "context", "graphify-usage.jsonl");
    this.benchmarkPath = join(workspaceRoot, ".astack", "context", "graphify-benchmark.json");
    this.versionCache = undefined;
  }

  graphify(args, options = {}) {
    return this.run("graphify", args, { cwd: this.root, ...options });
  }

  version() {
    if (this.versionCache !== undefined) {
      return this.versionCache;
    }
    const result = this.graphify(["--version"], { timeout: 20000 });
    this.versionCache = result.ok ? (/(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1] ?? result.stdout.trim()) : null;
    return this.versionCache;
  }

  installed() {
    return Boolean(this.version());
  }

  graphPath() {
    return join(this.output, "graph.json");
  }

  git(args) {
    const result = this.run("git", args, { cwd: this.root, timeout: 10000 });
    return result.ok ? result.stdout.trim() : null;
  }

  /** Whether the graph exists and whether code changed after it was built. */
  graph() {
    const path = this.graphPath();
    if (!existsSync(path)) {
      return { built: false, path: this.config.output + "/graph.json" };
    }
    const builtAt = statSync(path).mtime;
    let nodes = null;
    let edges = null;
    let commit = null;
    try {
      const data = JSON.parse(readFileSync(path, "utf8"));
      nodes = data.nodes?.length ?? null;
      edges = (data.links ?? data.edges)?.length ?? null;
      commit = data.built_at_commit ?? null;
    } catch {
      // A graph being rewritten by a hook is reported without counts.
    }
    // Stale when HEAD moved past the commit the graph was built at, or when an
    // uncommitted file changed after the build.
    const head = this.git(["rev-parse", "HEAD"]);
    const movedOn = Boolean(commit && head && !head.startsWith(commit) && !commit.startsWith(head));
    const dirty = (this.git(["status", "--porcelain", "--untracked-files=no"]) ?? "")
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.slice(3).startsWith(this.config.output));
    const stale = movedOn || dirty.some((line) => {
      const file = join(this.root, line.slice(3).trim());
      return existsSync(file) && statSync(file).mtime > builtAt;
    });
    return { built: true, path: this.config.output + "/graph.json", builtAt: builtAt.toISOString(), commit, nodes, edges, stale };
  }

  hooks() {
    const result = this.graphify(["hook", "status"], { timeout: 20000 });
    return result.ok ? /installed/i.test(result.stdout) && !/not installed/i.test(result.stdout) : false;
  }

  status() {
    const version = this.version();
    return {
      enabled: this.config.enabled !== false,
      installed: Boolean(version),
      version,
      graph: version || existsSync(this.graphPath()) ? this.graph() : { built: false },
      hooks: version ? this.hooks() : false,
      budget: { query: this.config.query_budget, max: this.config.max_budget },
      usage: this.usage()
    };
  }

  /**
   * Install or upgrade graphify as an isolated tool. uv is preferred, then
   * pipx, then a user-level pip install, matching graphify's own guidance.
   */
  setup({ upgrade = false, hooks = true, build = true } = {}) {
    const steps = [];
    const attempts = this.installed() && upgrade
      ? [["uv", ["tool", "upgrade", GRAPHIFY_PACKAGE]], ["pipx", ["upgrade", GRAPHIFY_PACKAGE]], ["python", ["-m", "pip", "install", "--user", "--upgrade", GRAPHIFY_PACKAGE]]]
      : [["uv", ["tool", "install", GRAPHIFY_PACKAGE]], ["pipx", ["install", GRAPHIFY_PACKAGE]], ["python", ["-m", "pip", "install", "--user", GRAPHIFY_PACKAGE]]];
    if (!this.installed() || upgrade) {
      let done = false;
      for (const [command, args] of attempts) {
        const result = this.run(command, args, { cwd: this.root, timeout: 900000 });
        steps.push({ step: command + " " + args.join(" "), ok: result.ok, fallback: !result.ok, detail: (result.ok ? result.stdout : result.stderr).trim().split(/\r?\n/).slice(-2).join(" ") });
        if (result.ok) {
          done = true;
          break;
        }
      }
      this.versionCache = undefined;
      if (!done || !this.installed()) {
        return { ok: false, version: null, steps };
      }
    }
    if (hooks && !this.hooks()) {
      const result = this.graphify(["hook", "install"], { timeout: 60000 });
      steps.push({ step: "graphify hook install", ok: result.ok, detail: (result.ok ? result.stdout : result.stderr).trim().split(/\r?\n/).slice(-1).join(" ") });
    }
    if (build) {
      steps.push(this.build());
    }
    // A failed installer that a later one replaced is a fallback, not a failure.
    return { ok: steps.every((step) => step.ok || step.fallback), version: this.version(), steps };
  }

  /** Rebuild the code graph. AST only: local, no model calls, no API key. */
  build({ force = false } = {}) {
    if (!this.installed()) {
      return { step: "graphify update .", ok: false, detail: "graphify is not installed: astack graphify setup" };
    }
    const result = this.graphify(["update", ".", ...(force ? ["--force"] : [])]);
    const summary = /Rebuilt:[^\n]*/.exec(result.stdout)?.[0] ?? (result.ok ? "graph up to date" : result.stderr.trim().split(/\r?\n/).slice(-1)[0]);
    return { step: "graphify update ." + (force ? " --force" : ""), ok: result.ok, detail: summary };
  }

  budget(requested) {
    const value = Number(requested ?? this.config.query_budget);
    return Math.max(200, Math.min(Number.isFinite(value) ? value : this.config.query_budget, this.config.max_budget));
  }

  /**
   * Ask the graph. Every call is capped by the budget and metered: what was
   * served, against the naive cost of reading the corpus.
   */
  ask(kind, terms, { budget } = {}) {
    if (!this.installed()) {
      return { ok: false, text: "graphify is not installed. Run: astack graphify setup", tokens: 0 };
    }
    if (!existsSync(this.graphPath())) {
      return { ok: false, text: "No code graph yet. Run: astack graphify build", tokens: 0 };
    }
    const limit = this.budget(budget);
    const args = {
      query: ["query", terms[0], "--budget", String(limit)],
      path: ["path", terms[0], terms[1]],
      explain: ["explain", terms[0]],
      affected: ["affected", terms[0]]
    }[kind];
    if (!args || terms.some((term) => !String(term ?? "").trim())) {
      return { ok: false, text: "Usage: astack graphify " + kind + " <terms>", tokens: 0 };
    }
    const result = this.graphify(args, { timeout: 120000 });
    const raw = (result.ok ? result.stdout : result.stderr || result.stdout).trim();
    const fitted = fitToBudget(raw || "(no result)", limit);
    if (result.ok) {
      this.meter({ kind, terms, tokens: fitted.tokens, truncated: fitted.truncated, budget: limit });
    }
    const graph = this.graph();
    const note = graph.stale ? "\n(note: the graph is older than the latest code change; astack graphify build)" : "";
    return { ok: result.ok, text: fitted.text + note, tokens: fitted.tokens, truncated: fitted.truncated, budget: limit };
  }

  meter(entry) {
    mkdirSync(join(this.root, ".astack", "context"), { recursive: true });
    appendFileSync(this.usagePath, JSON.stringify({ at: this.clock().toISOString(), ...entry }) + "\n", "utf8");
  }

  /** Graphify's own token benchmark, cached so status can report savings. */
  benchmark() {
    if (!this.installed() || !existsSync(this.graphPath())) {
      return null;
    }
    const result = this.graphify(["benchmark"], { timeout: 300000 });
    if (!result.ok) {
      return null;
    }
    const number = (pattern) => Number((pattern.exec(result.stdout)?.[1] ?? "").replace(/,/g, "")) || null;
    const report = {
      at: this.clock().toISOString(),
      naiveTokens: number(/~([\d,]+) tokens \(naive\)/),
      avgQueryTokens: number(/Avg query cost:\s*~([\d,]+)/),
      reduction: Number(/Reduction:\s*([\d.]+)x/.exec(result.stdout)?.[1] ?? 0) || null
    };
    mkdirSync(join(this.root, ".astack", "context"), { recursive: true });
    writeFileSync(this.benchmarkPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    return report;
  }

  usage() {
    const entries = existsSync(this.usagePath)
      ? readFileSync(this.usagePath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        }).filter(Boolean)
      : [];
    const benchmark = existsSync(this.benchmarkPath) ? JSON.parse(readFileSync(this.benchmarkPath, "utf8")) : null;
    const served = entries.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0);
    const naive = benchmark?.naiveTokens ? benchmark.naiveTokens * entries.length : null;
    return {
      queries: entries.length,
      tokensServed: served,
      truncated: entries.filter((entry) => entry.truncated).length,
      benchmark,
      estimatedSaved: naive === null ? null : Math.max(0, naive - served)
    };
  }

  /** One line for the session-start context, identical in both runtimes. */
  contextLine() {
    if (this.config.enabled === false) {
      return null;
    }
    if (!this.installed()) {
      return existsSync(this.graphPath())
        ? "Code graph: " + this.config.output + "/graph.json exists but graphify is not installed here (astack graphify setup)."
        : null;
    }
    const graph = this.graph();
    if (!graph.built) {
      return "Code graph: not built yet — astack graphify build (local AST, no API cost).";
    }
    return (
      "Code graph: " + (graph.nodes ?? "?") + " nodes, " + (graph.edges ?? "?") + " edges" +
      (graph.stale ? " (stale: astack graphify build)" : "") +
      ". Ask it before grepping or reading files: astack_graph_query (budget " + this.config.query_budget + " tokens)."
    );
  }
}
