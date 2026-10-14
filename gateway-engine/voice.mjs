import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "scripts", "transcribe.py");

export const VOICE_DEFAULTS = {
  enabled: true,
  model: "large-v3-turbo",
  language: "fa",
  device: "auto",
  python: process.platform === "win32" ? "python" : "python3",
  timeout_s: 300,
  allow_approvals: false
};

/**
 * Local Persian voice notes.
 *
 * A voice note is transcribed on this machine with faster-whisper through a
 * small Python script (`python -I`, so nothing from the working directory is
 * imported). The model is loaded per note and the process exits afterwards,
 * releasing the GPU for other work. Spawning Python goes through the
 * automation policy like every other unattended command.
 */
export class VoiceTranscriber {
  constructor({ config = {}, policy = null, spawnImpl = spawn } = {}) {
    this.config = { ...VOICE_DEFAULTS, ...config };
    this.policy = policy;
    this.spawnImpl = spawnImpl;
    this.script = SCRIPT;
  }

  args(extra) {
    return ["-I", this.script, ...extra];
  }

  permitted(args) {
    const verdict = this.policy?.allowInvocation?.(this.config.python, args) ?? { allowed: true };
    return verdict;
  }

  run(extra, { timeoutMs }) {
    const args = this.args(extra);
    const verdict = this.permitted(args);
    if (!verdict.allowed) {
      return Promise.resolve({ ok: false, error: verdict.reason, policy: true });
    }
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const child = this.spawnImpl(this.config.python, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
      const timer = setTimeout(() => {
        child.kill();
        finish({ ok: false, error: "transcription timed out after " + Math.round(timeoutMs / 1000) + "s" });
      }, timeoutMs);
      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => finish({ ok: false, error: "could not start " + this.config.python + ": " + error.message }));
      child.on("close", () => {
        const line = stdout.trim().split(/\r?\n/).pop() ?? "";
        try {
          finish(JSON.parse(line));
        } catch {
          finish({ ok: false, error: (stderr.trim().split(/\r?\n/).pop() ?? "no output").slice(0, 300) });
        }
      });
    });
  }

  async detect() {
    if (!existsSync(this.script)) {
      return { ok: false, error: "transcribe.py is missing" };
    }
    return this.run(["--check"], { timeoutMs: 60000 });
  }

  async transcribe(path, overrides = {}) {
    const options = { ...this.config, ...overrides };
    if (!existsSync(path)) {
      return { ok: false, error: "audio file not found" };
    }
    return this.run(["--model", String(options.model), "--language", String(options.language), "--device", String(options.device), path], {
      timeoutMs: Number(options.timeout_s) * 1000
    });
  }

  setupCommand() {
    return { command: this.config.python, args: ["-m", "pip", "install", "--user", "faster-whisper"] };
  }
}
