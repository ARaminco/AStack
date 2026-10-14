import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { redactSecrets } from "../lib/text.mjs";

/**
 * Execution engines for unattended runs.
 *
 * An engine takes the compact work order and returns text. It never decides
 * what is allowed: the runner checks the automation policy, the authority
 * ceiling and the budget before an engine is called, and turns any approval
 * request in the answer into a real approval record.
 *
 * Every engine reads its prompt from stdin, so no task text ever reaches a
 * command line, a shell or a process listing.
 */

const OUTPUT_CAP = 4 * 1024 * 1024;

/**
 * The environment of every runner child process. `ASTACK_UNATTENDED=1` makes
 * `astack approval approve|reject` (and the approval engine itself) refuse to
 * decide anything, so an unattended model can never approve its own request.
 */
export function unattendedEnv(base = process.env) {
  return { ...base, ASTACK_UNATTENDED: "1" };
}

/** The only tools an unattended run gets at ceiling L0-L2 or from a non-owner source. */
export const READ_ONLY_CLAUDE_TOOLS = ["Read", "Grep", "Glob"];

/**
 * Always denied, whatever `runner.claude.disallowed_tools` says: writing to
 * AStack's own state (approvals, audit, policy) or deciding an approval from
 * inside a run would let a model forge the owner's consent.
 */
export const MANDATORY_CLAUDE_DENIED = [
  "Write(.astack/**)",
  "Edit(.astack/**)",
  "MultiEdit(.astack/**)",
  "NotebookEdit(.astack/**)",
  "Write(**/.astack/**)",
  "Edit(**/.astack/**)",
  "MultiEdit(**/.astack/**)",
  "Bash(astack approval:*)",
  "Bash(node bin/astack.mjs approval:*)",
  "Bash(npx astack approval:*)",
  "Bash(*astack approval*)",
  "Bash(*astack.mjs approval*)",
  "Bash(*.astack*)"
];

/** Permission modes an unattended Claude run may use. */
export const CLAUDE_PERMISSION_MODES = ["default", "dontAsk", "acceptEdits", "plan"];

// Codex arguments that would switch its sandbox or approval policy off.
const CODEX_FORBIDDEN_ARGS = [
  /^--dangerously-bypass-approvals-and-sandbox$/i,
  /^--yolo$/i,
  /^--full-auto$/i,
  /^(?:-s|--sandbox)(?:=.*)?$/i,
  /^(?:-a|--ask-for-approval)(?:=.*)?$/i,
  /sandbox_mode/i,
  /approval_policy/i,
  /sandbox_permissions/i,
  /danger-full-access/i
];

/**
 * Refuse codex `args` that disable its sandbox or approvals; `-c key=value`
 * overrides of those keys are refused in the joined and the split form.
 */
export function checkCodexArgs(args) {
  const list = (args ?? []).map(String);
  for (let index = 0; index < list.length; index += 1) {
    const argument = list[index];
    if (CODEX_FORBIDDEN_ARGS.some((pattern) => pattern.test(argument))) {
      throw new Error("runner.codex.args " + argument + " is refused for unattended runs");
    }
    if (/^(?:-c|--config)$/i.test(argument) && /sandbox|approval/i.test(list[index + 1] ?? "")) {
      throw new Error("runner.codex.args " + argument + " " + list[index + 1] + " is refused for unattended runs");
    }
  }
  return list;
}

/**
 * Resolve a command name to something `spawn` can start without a shell.
 * On Windows an npm shim (`claude.cmd`) is unwrapped to the binary or the
 * script it calls; a shell is used only as the last resort.
 */
export function resolveCommand(command, { env = process.env, platform = process.platform } = {}) {
  const raw = String(command ?? "").trim();
  if (!raw) {
    return null;
  }
  const extensions = platform === "win32"
    ? ["", ...String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((entry) => entry.toLowerCase())]
    : [""];
  const candidates = [];
  if (isAbsolute(raw) || raw.includes("/") || raw.includes("\\")) {
    candidates.push(...extensions.map((extension) => resolve(raw + extension)));
  } else {
    const pathValue = env.PATH ?? env.Path ?? "";
    for (const directory of pathValue.split(delimiter).filter(Boolean)) {
      for (const extension of extensions) {
        candidates.push(join(directory, raw + extension));
      }
    }
  }
  for (const candidate of candidates) {
    let isFile = false;
    try {
      isFile = statSync(candidate).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      continue;
    }
    const extension = extname(candidate).toLowerCase();
    if (platform === "win32" && extension === "") {
      // A POSIX shell shim next to the .cmd; Windows cannot execute it.
      continue;
    }
    if (platform === "win32" && [".cmd", ".bat"].includes(extension)) {
      const unwrapped = unwrapShim(candidate);
      if (unwrapped) {
        return unwrapped;
      }
      return { file: candidate, prefix: [], shell: true, path: candidate };
    }
    return { file: candidate, prefix: [], shell: false, path: candidate };
  }
  return null;
}

function unwrapShim(path) {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const base = dirname(path);
  const targets = [...text.matchAll(/"%(?:dp0|~dp0)%\\?([^"]+\.(?:exe|js|cjs|mjs))"/gi)].map((match) => match[1]);
  for (const target of targets) {
    const full = join(base, target);
    if (!existsSync(full)) {
      continue;
    }
    if (/\.exe$/i.test(full)) {
      return { file: full, prefix: [], shell: false, path };
    }
    return { file: process.execPath, prefix: [full], shell: false, path };
  }
  return null;
}

/**
 * Spawn a resolved command, write the prompt to stdin and collect the output.
 */
export function runProcess(resolved, args, { input = "", cwd, timeoutMs = 900000, env = unattendedEnv() } = {}) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    if (resolved.shell) {
      for (const argument of args) {
        if (/["%^&|<>!\r\n]/.test(String(argument))) {
          resolvePromise({ code: null, stdout: "", stderr: "", error: new Error("refusing to pass an unsafe argument through the shell: " + String(argument).slice(0, 40)), durationMs: 0 });
          return;
        }
      }
    }
    const finalArgs = [...resolved.prefix, ...args].map((argument) => (resolved.shell && /\s/.test(argument) ? "\"" + argument + "\"" : argument));
    let child = null;
    try {
      child = spawn(resolved.shell ? "\"" + resolved.file + "\"" : resolved.file, finalArgs, {
        cwd,
        env,
        shell: resolved.shell,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      resolvePromise({ code: null, stdout: "", stderr: "", error, durationMs: 0 });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ...result, stdout, stderr, durationMs: Date.now() - started });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      finish({ code: null, error: new Error("timed out after " + Math.round(timeoutMs / 1000) + "s") });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (stdout.length < OUTPUT_CAP) {
        stdout += chunk.toString("utf8");
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < OUTPUT_CAP) {
        stderr += chunk.toString("utf8");
      }
    });
    child.on("error", (error) => finish({ code: null, error }));
    child.on("close", (code) => finish({ code, error: null }));
    child.stdin.on("error", () => {});
    child.stdin.end(input, "utf8");
  });
}

function probe(resolved, args) {
  try {
    const result = spawnSync(resolved.shell ? "\"" + resolved.file + "\"" : resolved.file, [...resolved.prefix, ...args], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
      shell: resolved.shell
    });
    if (result.error || result.status !== 0) {
      return null;
    }
    return String(result.stdout ?? "").trim().split(/\r?\n/)[0] ?? "";
  } catch {
    return null;
  }
}

class BaseEngine {
  constructor(id, { config = {}, policy = null } = {}) {
    this.id = id;
    this.config = config ?? {};
    this.policy = policy;
    this.cache = null;
  }

  /** The automation policy decides whether a spawned binary may run at all. */
  policyVerdict(command) {
    return this.policy?.allowCommand ? this.policy.allowCommand(command) : { allowed: true, reason: "no automation policy" };
  }
}

/**
 * Claude Code headless: `claude -p --output-format json`.
 */
export class ClaudeEngine extends BaseEngine {
  constructor(options = {}) {
    super("claude", options);
    this.command = this.config.command ?? "claude";
    this.permissionMode = this.config.permission_mode ?? "dontAsk";
    this.allowedTools = toList(this.config.allowed_tools ?? DEFAULT_CLAUDE_TOOLS);
    this.disallowedTools = toList(this.config.disallowed_tools ?? DEFAULT_CLAUDE_DENIED);
    this.model = this.config.model ?? null;
    // Unattended runs load no MCP servers unless the owner names a config:
    // least privilege, and the tool schemas would cost tokens on every run.
    this.strictMcp = this.config.strict_mcp !== false;
    this.mcpConfig = this.config.mcp_config ?? null;
    // Only the built-in tools the allow list names are loaded, and skills stay
    // off unless enabled: every tool schema and skill listing is paid for on
    // every unattended run, before the model writes a word.
    this.tools = toList(this.config.tools ?? [...new Set(this.allowedTools.map((tool) => tool.split("(")[0]))]);
    this.skills = this.config.skills === true;
    this.costClass = "metered";
  }

  describe({ refresh = false } = {}) {
    if (this.cache && !refresh) {
      return this.cache;
    }
    const resolved = resolveCommand(this.command);
    const version = resolved ? probe(resolved, ["--version"]) : null;
    const verdict = this.policyVerdict(this.command);
    this.cache = {
      id: this.id,
      kind: "cli",
      command: this.command,
      path: resolved?.path ?? null,
      version,
      installed: Boolean(resolved && version !== null),
      allowedByPolicy: verdict.allowed,
      policyReason: verdict.reason,
      available: Boolean(resolved && version !== null && verdict.allowed),
      permissionMode: this.permissionMode,
      allowedTools: this.allowedTools,
      costClass: this.costClass,
      detail: !resolved
        ? "claude was not found on PATH (set runner.claude.command)"
        : version === null
          ? "claude did not answer --version"
          : !verdict.allowed
            ? verdict.reason
            : "Claude Code " + version
    };
    return this.cache;
  }

  /**
   * `readOnly` (the runner sets it at ceiling L0-L2 and for every run that is
   * not the owner's own request) forces the read-only tool set and `dontAsk`,
   * whatever the configuration says. Wider configured tools apply only at L3+
   * for the owner's own requests (cli, console, gateway).
   */
  args({ budgetUsd = null, resumeSession = null, model = null, readOnly = false } = {}) {
    if (this.permissionMode === "bypassPermissions") {
      throw new Error("runner.claude.permission_mode bypassPermissions is refused: widen runner.claude.allowed_tools instead");
    }
    if (!CLAUDE_PERMISSION_MODES.includes(String(this.permissionMode))) {
      throw new Error("runner.claude.permission_mode " + this.permissionMode + " is refused: use one of " + CLAUDE_PERMISSION_MODES.join(", "));
    }
    const permissionMode = readOnly ? "dontAsk" : this.permissionMode;
    const allowedTools = readOnly ? READ_ONLY_CLAUDE_TOOLS : this.allowedTools;
    const tools = readOnly ? READ_ONLY_CLAUDE_TOOLS : this.tools;
    const disallowedTools = [...new Set([...this.disallowedTools, ...MANDATORY_CLAUDE_DENIED])];
    const args = ["-p", "--output-format", "json", "--permission-mode", permissionMode];
    if (model ?? this.model) {
      args.push("--model", String(model ?? this.model));
    }
    if (this.strictMcp) {
      args.push("--strict-mcp-config");
    }
    if (this.mcpConfig) {
      args.push("--mcp-config", String(this.mcpConfig));
    }
    if (!this.skills) {
      args.push("--disable-slash-commands");
    }
    if (tools.length) {
      args.push("--tools", ...tools);
    }
    if (resumeSession) {
      args.push("--resume", String(resumeSession));
    }
    if (disallowedTools.length) {
      args.push("--disallowedTools", ...disallowedTools);
    }
    if (allowedTools.length) {
      args.push("--allowedTools", ...allowedTools);
    }
    if (budgetUsd !== null && budgetUsd !== undefined) {
      // Also terminates the variadic tool lists above.
      args.push("--max-budget-usd", String(Number(budgetUsd).toFixed(2)));
    }
    return args;
  }

  async run({ prompt, cwd, timeoutMs, budgetUsd = null, resumeSession = null, model = null, toolScope = "read-only" }) {
    const resolved = resolveCommand(this.command);
    if (!resolved) {
      return { ok: false, error: "claude was not found on PATH", text: "", costUsd: 0 };
    }
    let args = [];
    try {
      args = this.args({ budgetUsd, resumeSession, model, readOnly: toolScope !== "configured" });
    } catch (error) {
      return { ok: false, error: error.message, text: "", costUsd: 0 };
    }
    const result = await runProcess(resolved, args, { input: prompt, cwd, timeoutMs, env: unattendedEnv() });
    const parsed = parseClaudeJson(result.stdout);
    if (parsed) {
      const isError = Boolean(parsed.is_error) || (parsed.subtype && parsed.subtype !== "success");
      return {
        ok: !isError,
        error: isError ? "claude reported " + (parsed.subtype ?? "an error") + (parsed.result ? ": " + String(parsed.result).slice(0, 300) : "") : null,
        text: String(parsed.result ?? ""),
        costUsd: Number(parsed.total_cost_usd ?? 0) || 0,
        sessionId: parsed.session_id ?? null,
        turns: parsed.num_turns ?? null,
        tokens: (parsed.usage?.input_tokens ?? 0) + (parsed.usage?.output_tokens ?? 0),
        durationMs: result.durationMs
      };
    }
    return {
      ok: false,
      error: redactSecrets((result.error?.message ?? "exit " + result.code) + " " + result.stderr.slice(-400)).trim(),
      text: redactSecrets(result.stdout.slice(-2000)),
      costUsd: 0,
      durationMs: result.durationMs
    };
  }
}

/** Read-only by default: the runner itself turns approval requests into records. */
export const DEFAULT_CLAUDE_TOOLS = ["Read", "Grep", "Glob"];
export const DEFAULT_CLAUDE_DENIED = ["Bash(astack approval approve:*)", "Bash(node bin/astack.mjs approval approve:*)", ...MANDATORY_CLAUDE_DENIED];

export function parseClaudeJson(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) {
    return null;
  }
  const attempts = [text, ...text.split(/\r?\n/).reverse()];
  for (const attempt of attempts) {
    try {
      const value = JSON.parse(attempt);
      if (Array.isArray(value)) {
        const result = [...value].reverse().find((entry) => entry?.type === "result");
        if (result) {
          return result;
        }
        continue;
      }
      if (value && typeof value === "object" && ("result" in value || value.type === "result")) {
        return value;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Codex: `codex exec` with the prompt on stdin and a read-only sandbox.
 */
export class CodexEngine extends BaseEngine {
  constructor(options = {}) {
    super("codex", options);
    this.command = this.config.command ?? "codex";
    this.sandbox = this.config.sandbox ?? "read-only";
    // Checked in args(): a refused argument fails the run, not the runtime.
    this.extraArgs = toList(this.config.args ?? []);
    this.model = this.config.model ?? null;
    this.costClass = "metered";
    this.scratch = options.scratch ?? null;
  }

  describe({ refresh = false } = {}) {
    if (this.cache && !refresh) {
      return this.cache;
    }
    const resolved = resolveCommand(this.command);
    const version = resolved ? probe(resolved, ["--version"]) : null;
    const verdict = this.policyVerdict(this.command);
    this.cache = {
      id: this.id,
      kind: "cli",
      command: this.command,
      path: resolved?.path ?? null,
      version,
      installed: Boolean(resolved && version !== null),
      allowedByPolicy: verdict.allowed,
      policyReason: verdict.reason,
      available: Boolean(resolved && version !== null && verdict.allowed),
      sandbox: this.sandbox,
      costClass: this.costClass,
      detail: !resolved ? "codex was not found on PATH (set runner.codex.command)" : version === null ? "codex did not answer --version" : !verdict.allowed ? verdict.reason : "Codex " + version
    };
    return this.cache;
  }

  /**
   * `readOnly` (ceiling L0-L2, or not the owner's own request) forces the
   * read-only sandbox whatever `runner.codex.sandbox` says.
   */
  args({ lastMessageFile, model = null, readOnly = false }) {
    if (this.sandbox === "danger-full-access") {
      throw new Error("runner.codex.sandbox danger-full-access is refused for unattended runs");
    }
    const extra = checkCodexArgs(this.extraArgs);
    const args = ["exec", "--skip-git-repo-check", "--sandbox", readOnly ? "read-only" : this.sandbox, "--output-last-message", lastMessageFile];
    if (model ?? this.model) {
      args.push("--model", String(model ?? this.model));
    }
    args.push(...extra, "-");
    return args;
  }

  async run({ prompt, cwd, timeoutMs, runId = "run", model = null, toolScope = "read-only" }) {
    const resolved = resolveCommand(this.command);
    if (!resolved) {
      return { ok: false, error: "codex was not found on PATH", text: "", costUsd: 0 };
    }
    const directory = this.scratch ?? join(cwd, ".astack", "runner", "scratch");
    mkdirSync(directory, { recursive: true });
    const lastMessageFile = join(directory, runId + ".codex.txt");
    let args = [];
    try {
      args = this.args({ lastMessageFile, model, readOnly: toolScope !== "configured" });
    } catch (error) {
      return { ok: false, error: error.message, text: "", costUsd: 0 };
    }
    const result = await runProcess(resolved, args, { input: prompt, cwd, timeoutMs, env: unattendedEnv() });
    let text = "";
    if (existsSync(lastMessageFile)) {
      text = readFileSync(lastMessageFile, "utf8");
      rmSync(lastMessageFile, { force: true });
    }
    if (result.error || result.code !== 0) {
      return {
        ok: false,
        error: redactSecrets((result.error?.message ?? "exit " + result.code) + " " + result.stderr.slice(-400)).trim(),
        text: text || redactSecrets(result.stdout.slice(-2000)),
        costUsd: 0,
        durationMs: result.durationMs
      };
    }
    // codex exec does not report a price; the run is recorded with cost null.
    return { ok: true, text: text || result.stdout, costUsd: null, durationMs: result.durationMs };
  }
}

/**
 * A local model over the Ollama HTTP API. The endpoint is owner
 * configuration, never inbound content. A loopback endpoint is a local model;
 * anything else has to pass the automation policy's network rules.
 */
export class OllamaEngine extends BaseEngine {
  constructor(options = {}) {
    super("ollama", options);
    this.url = String(this.config.url ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
    this.model = this.config.model ?? null;
    this.costClass = "free";
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  hostVerdict() {
    let host = "";
    try {
      host = new URL(this.url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    } catch {
      return { allowed: false, reason: "invalid runner.ollama.url: " + this.url };
    }
    if (["127.0.0.1", "localhost", "::1"].includes(host)) {
      return { allowed: true, reason: "loopback model endpoint" };
    }
    return this.policy?.allowHost ? this.policy.allowHost(this.url) : { allowed: true, reason: "no automation policy" };
  }

  async describe({ refresh = false } = {}) {
    if (this.cache && !refresh) {
      return this.cache;
    }
    const verdict = this.hostVerdict();
    let models = [];
    let reachable = false;
    if (verdict.allowed) {
      try {
        const response = await this.fetch(this.url + "/api/tags", { signal: AbortSignal.timeout(2500) });
        if (response.ok) {
          reachable = true;
          models = ((await response.json()).models ?? []).map((model) => model.name).filter(Boolean);
        }
      } catch {
        reachable = false;
      }
    }
    const model = this.model ?? pickModel(models);
    const modelInstalled = Boolean(model && (models.includes(model) || models.includes(model + ":latest")));
    this.cache = {
      id: this.id,
      kind: "http",
      url: this.url,
      model,
      models: [...new Set(models)],
      installed: reachable,
      allowedByPolicy: verdict.allowed,
      policyReason: verdict.reason,
      available: Boolean(verdict.allowed && reachable && modelInstalled),
      costClass: this.costClass,
      detail: !verdict.allowed
        ? verdict.reason
        : !reachable
          ? "no Ollama server answered at " + this.url
          : !model
            ? "Ollama answers but no chat model is installed"
            : !modelInstalled
              ? "model " + model + " is not installed (ollama pull " + model + ")"
              : "Ollama " + model
    };
    return this.cache;
  }

  async run({ prompt, system = null, timeoutMs = 300000, history = [], model: requested = null }) {
    const verdict = this.hostVerdict();
    if (!verdict.allowed) {
      return { ok: false, error: "blocked by automation policy: " + verdict.reason, text: "", costUsd: 0 };
    }
    const description = await this.describe();
    const model = requested ?? description.model;
    if (!model) {
      return { ok: false, error: description.detail, text: "", costUsd: 0 };
    }
    const messages = [];
    if (system) {
      messages.push({ role: "system", content: system });
    }
    messages.push(...history, { role: "user", content: prompt });
    const started = Date.now();
    try {
      const response = await this.fetch(this.url + "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages, stream: false, options: this.config.options ?? undefined }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        return { ok: false, error: "ollama HTTP " + response.status + ": " + String(body.error ?? "").slice(0, 200), text: "", costUsd: 0 };
      }
      return {
        ok: true,
        text: String(body.message?.content ?? ""),
        costUsd: 0,
        model,
        tokens: (body.prompt_eval_count ?? 0) + (body.eval_count ?? 0),
        durationMs: Date.now() - started
      };
    } catch (error) {
      return { ok: false, error: "ollama request failed: " + error.message, text: "", costUsd: 0, durationMs: Date.now() - started };
    }
  }
}

function pickModel(models) {
  return models.find((name) => !/embed|bge|nomic|minilm/i.test(name)) ?? null;
}

/**
 * Deterministic engine for tests and dry runs. An objective containing
 * `[approval]` asks for an approval; `[fail]` fails; a continuation after an
 * approval completes.
 */
export class MockEngine extends BaseEngine {
  constructor(options = {}) {
    super("mock", options);
    this.costUsd = Number(options.costUsd ?? this.config.cost_usd ?? 0);
    this.costClass = "free";
    this.calls = [];
  }

  describe() {
    return { id: this.id, kind: "mock", installed: true, allowedByPolicy: true, available: true, costClass: this.costClass, detail: "deterministic mock engine" };
  }

  async run({ prompt, resumeSession = null, continuation = false, toolScope = "read-only" }) {
    this.calls.push({ prompt, resumeSession, continuation, toolScope });
    const objective = /## Objective\r?\n([^\n]*)/.exec(prompt)?.[1] ?? "";
    if (objective.includes("[fail]")) {
      return { ok: false, error: "mock failure", text: "", costUsd: this.costUsd, sessionId: "mock-session" };
    }
    if (objective.includes("[approval]") && !continuation) {
      return {
        ok: true,
        text: "Prepared the draft.\nAPPROVAL-REQUEST: send-report | L4 | send the prepared report to the client\nStopped before sending.",
        costUsd: this.costUsd,
        sessionId: "mock-session"
      };
    }
    return {
      ok: true,
      text: (continuation ? "continued after approval: " : "mock completed: ") + objective,
      costUsd: this.costUsd,
      sessionId: resumeSession ?? "mock-session"
    };
  }
}

function toList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

export function createEngines({ config = {}, policy = null, fetch = undefined, scratch = null } = {}) {
  return {
    claude: new ClaudeEngine({ config: config.claude ?? {}, policy }),
    codex: new CodexEngine({ config: config.codex ?? {}, policy, scratch }),
    ollama: new OllamaEngine({ config: config.ollama ?? {}, policy, fetch }),
    mock: new MockEngine({ config: config.mock ?? {} })
  };
}
