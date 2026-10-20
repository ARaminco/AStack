import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { appendLedger, atomicJson, economyDirectory, readEconomyConfig, readJson } from "./storage.mjs";
import { Limits } from "./limits.mjs";
import { redactSecretsStrict } from "../lib/text.mjs";

/** Prompts travel on stdin; Windows command arguments are strictly quoted. */
export function runProcess(command, args, { cwd, input = "", timeoutMs = 120000 } = {}) {
  return new Promise((resolveResult) => {
    const windows = process.platform === "win32" && command === "codex";
    if (windows && args.some((value) => /["%!^\r\n]/.test(value))) {
      resolveResult({ ok: false, stdout: "", reason: "Unsupported character in Windows Codex arguments" });
      return;
    }
    const child = spawn(command, windows ? args.map((value) => '"' + value + '"') : args, { cwd, shell: windows, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let reason = null;
    const timer = setTimeout(() => {
      reason = "Delegate timed out";
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-4 * 1024 * 1024); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8192); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveResult({ ok: false, stdout, stderr, reason: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveResult({ ok: code === 0 && !reason, stdout, stderr, reason: reason ?? (code ? stderr || "Codex exited " + code : null) });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export async function localModels({ config = {}, fetcher = fetch } = {}) {
  try {
    const response = await fetcher((config.local?.url ?? "http://localhost:11434") + "/api/tags", { signal: AbortSignal.timeout(700) });
    if (!response.ok) {
      return [];
    }
    return (await response.json()).models?.filter((model) => !/embed|bge-|e5-|bert|minilm/i.test(model.name + " " + (model.details?.family ?? "") + " " + (model.details?.families ?? []).join(" "))).map((model) => model.name) ?? [];
  } catch {
    return [];
  }
}

export async function codexAvailability({ home = homedir(), directory = economyDirectory(home), codexRoot = join(home, ".codex", "sessions"), run = runProcess, cwd = process.cwd(), clock = () => Date.now() } = {}) {
  const limits = new Limits({ directory });
  try {
    const { latestCodexLimits } = await import("./usage-meter.mjs");
    limits.captureCodex(latestCodexLimits(codexRoot));
  } catch {
    // A missing or rotating log leaves the last known official capture intact.
  }
  const rate = limits.read().codex?.rate_limits;
  if (rate?.primary?.used_percent >= 90 && (!rate.primary.resets_at || rate.primary.resets_at * 1000 > clock())) {
    return { available: false, reason: "Codex primary limit is at least 90%", rate_limits: rate };
  }
  const path = join(directory, "codex-login.json");
  let login = readJson(path);
  if (!login.capturedAt || clock() - login.capturedAt >= 600000) {
    const result = await run("codex", ["login", "status"], { cwd, timeoutMs: 5000 });
    login = { available: result.ok && /Logged in using ChatGPT/i.test(result.stdout + " " + (result.stderr ?? "")), capturedAt: clock() };
    atomicJson(path, login);
  }
  return { ...login, rate_limits: rate, reason: login.available ? null : "Codex ChatGPT login is unavailable" };
}

export async function delegate({ to = "auto", task, cwd = process.cwd(), mode = "read", effort = "medium", schema = null, schema_json = null, images = [], timeoutMs = null, ...options } = {}) {
  // Codex building or editing takes minutes, not seconds: 30 min for write work, 10 min for reading.
  timeoutMs ??= mode === "write" ? 1800000 : 600000;
  const directory = options.directory ?? economyDirectory(options.home ?? homedir());
  const run = options.run ?? runProcess;
  let engine = to;
  let temporary = null;
  let result;
  try {
    const config = options.config ?? readEconomyConfig(cwd);
    if (!["codex", "local", "auto"].includes(to) || !["read", "write"].includes(mode) || !["low", "medium", "high"].includes(effort) || typeof task !== "string" || !task.trim()) {
      throw new Error("Invalid delegate request");
    }
    const availability = to === "local" ? null : await codexAvailability({ home: options.home, directory, codexRoot: options.codexRoot, run, cwd });
    engine = to === "auto" ? availability.available ? "codex" : "local" : to;
    if (engine === "codex") {
      if (!availability.available) {
        throw new Error(availability.reason);
      }
      mkdirSync(directory, { recursive: true });
      temporary = mkdtempSync(join(directory, "delegate-"));
      const outputPath = join(temporary, "lastmsg.txt");
      let schemaPath = schema ? resolve(cwd, schema) : null;
      if (schema_json) {
        schemaPath = join(temporary, "schema.json");
        writeFileSync(schemaPath, JSON.stringify(typeof schema_json === "string" ? JSON.parse(schema_json) : schema_json));
      }
      const args = ["exec", "--skip-git-repo-check", "-s", mode === "read" ? "read-only" : "workspace-write", "--json", "-c", "model_reasoning_effort='" + effort + "'", "-o", outputPath];
      if (config.codex_model) {
        args.push("-m", config.codex_model);
      }
      if (schemaPath) {
        args.push("--output-schema", schemaPath);
      }
      for (const path of images) {
        args.push("-i", resolve(cwd, path));
      }
      args.push("-");
      const execution = await run("codex", args, { cwd, input: task, timeoutMs });
      let usage = null;
      let output = "";
      for (const line of execution.stdout.split("\n")) {
        try {
          const event = JSON.parse(line);
          if (event.usage) {
            usage = event.usage;
          }
          if (event.item?.type === "agent_message") {
            output = event.item.text;
          }
        } catch {
          // Non-JSON diagnostics never become token records.
        }
      }
      try {
        output = readFileSync(outputPath, "utf8");
      } catch {
        // Some older executables only emit the JSON agent_message event.
      }
      result = { ok: execution.ok, engine, output, usage, reason: execution.reason };
    } else {
      if (images.length || mode !== "read" || !/classif|extract|summari[sz]|طبقه بندی|استخراج|خلاصه/i.test(task) || !/[:\n][\s\S]*\S/.test(task)) {
        throw new Error("Local delegation requires a text-only classification, extraction or summary task with supplied text");
      }
      const models = await localModels({ config, fetcher: options.fetcher });
      const model = config.local?.model ?? models[0];
      if (!model || !models.includes(model)) {
        throw new Error("No local text model is available");
      }
      const response = await (options.fetcher ?? fetch)((config.local?.url ?? "http://localhost:11434") + "/api/generate", {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ model, stream: false, prompt: "Use only the supplied text. Do not claim to read files or use tools.\n" + task })
      });
      if (!response.ok) {
        throw new Error("Local model HTTP " + response.status);
      }
      const answer = await response.json();
      result = { ok: !answer.error, engine: "local", output: answer.response ?? "", usage: { input_tokens: answer.prompt_eval_count ?? 0, output_tokens: answer.eval_count ?? 0 }, reason: answer.error ?? null };
    }
  } catch (error) {
    result = { ok: false, engine, output: "", usage: null, reason: error.message };
  } finally {
    if (temporary) {
      try {
        rmSync(temporary, { recursive: true, force: true });
      } catch {
        // Cleanup cannot break the calling runtime.
      }
    }
  }
  try {
    appendLedger(directory, { kind: "delegate", engine: result.engine, ok: result.ok, usage: result.usage, reason: result.reason ? redactSecretsStrict(result.reason) : null });
  } catch {
    // Delegation still returns its result when accounting is unavailable.
  }
  return result;
}
