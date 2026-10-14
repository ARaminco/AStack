import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * OS keychain and password-manager backends for the secret broker.
 *
 * A credential registered with `source: "vault:<backend>"` keeps its value in
 * the operating system's own secret store instead of an environment variable:
 *
 *   vault:windows    DPAPI for the current user (PowerShell SecureString);
 *                    ciphertext in .astack/vault/<provider>.<name>.dpapi
 *   vault:macos      login keychain via `security`
 *   vault:linux      Secret Service via `secret-tool`
 *   vault:bitwarden  `bw get password <item>` (read only)
 *   vault:1password  `op read <op://…>` (read only)
 *
 * Values travel through stdin, never argv, are never logged and are never
 * written in plaintext. Every backend is reached through an injectable `run`
 * so tests can exercise the flow without touching a real keychain.
 */

export const VAULT_BACKENDS = ["windows", "macos", "linux", "bitwarden", "1password"];

const PLATFORM_BACKEND = { win32: "windows", darwin: "macos", linux: "linux" };

const BACKEND_INFO = {
  windows: { cli: "powershell", platform: "win32", writable: true },
  macos: { cli: "security", platform: "darwin", writable: true },
  linux: { cli: "secret-tool", platform: "linux", writable: true },
  bitwarden: { cli: "bw", platform: null, writable: false },
  "1password": { cli: "op", platform: null, writable: false }
};

function defaultRun(command, args, { input = null, timeoutMs = 20000, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    input: input ?? undefined,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error ?? null };
}

/**
 * Find an executable on PATH without spawning anything.
 */
export function findExecutable(name, { env = process.env, platform = process.platform } = {}) {
  const paths = String(env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter).filter(Boolean);
  const extensions = platform === "win32" ? String(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  for (const directory of paths) {
    for (const extension of ["", ...extensions]) {
      const candidate = join(directory, name + extension);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        continue;
      }
    }
  }
  return null;
}

function encodedCommand(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

// Plaintext arrives base64 encoded on stdin so any character survives the
// console code page; DPAPI ciphertext leaves on stdout.
const DPAPI_PROTECT = [
  "$ErrorActionPreference = 'Stop'",
  "$b = [Console]::In.ReadToEnd().Trim()",
  "$v = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b))",
  "$s = ConvertTo-SecureString -String $v -AsPlainText -Force",
  "Remove-Variable v, b",
  "[Console]::Out.Write((ConvertFrom-SecureString -SecureString $s))"
].join("; ");

const DPAPI_UNPROTECT = [
  "$ErrorActionPreference = 'Stop'",
  "$c = [Console]::In.ReadToEnd().Trim()",
  "$s = ConvertTo-SecureString -String $c",
  "$p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)",
  "try { $v = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }",
  "[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v)))"
].join("; ");

function quoteForSecurity(value) {
  return "\"" + String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\"";
}

export class VaultBackends {
  constructor(root, { platform = process.platform, env = process.env, run = defaultRun, which = null } = {}) {
    this.root = root;
    this.directory = join(root, ".astack", "vault");
    this.platform = platform;
    this.env = env;
    this.run = run;
    this.which = which ?? ((name) => findExecutable(name, { env: this.env, platform: this.platform }));
  }

  static isVaultSource(source) {
    return String(source ?? "").startsWith("vault:");
  }

  static backendOf(source) {
    const backend = String(source ?? "").slice("vault:".length);
    if (!VAULT_BACKENDS.includes(backend)) {
      throw new Error("Unknown vault backend: " + backend + ". Use one of: " + VAULT_BACKENDS.map((entry) => "vault:" + entry).join(", "));
    }
    return backend;
  }

  defaultBackend() {
    return PLATFORM_BACKEND[this.platform] ?? null;
  }

  dpapiPath(record) {
    return join(this.directory, record.provider + "." + record.name + ".dpapi");
  }

  /**
   * What each backend can do on this machine. "real" means the platform and
   * CLI are present; "adapter-ready" means the code path exists but the CLI or
   * platform is missing here.
   */
  status() {
    return VAULT_BACKENDS.map((backend) => {
      const info = BACKEND_INFO[backend];
      const platformOk = !info.platform || info.platform === this.platform;
      const cli = platformOk ? this.which(info.cli) : null;
      const usable = platformOk && Boolean(cli);
      let detail = usable ? "ready" : !platformOk ? "not this platform (" + info.platform + ")" : info.cli + " not installed";
      if (usable && backend === "bitwarden" && !this.env.BW_SESSION) {
        detail = "bw installed; unlock it and export BW_SESSION";
      }
      return {
        backend,
        source: "vault:" + backend,
        cli: info.cli,
        installed: Boolean(cli),
        platform: platformOk,
        writable: info.writable,
        mode: usable ? "real" : "adapter-ready",
        default: backend === this.defaultBackend(),
        detail
      };
    });
  }

  assertUsable(backend) {
    const entry = this.status().find((item) => item.backend === backend);
    if (!entry.platform) {
      throw new Error("vault:" + backend + " is not available on this platform");
    }
    if (!entry.installed) {
      throw new Error("vault:" + backend + " needs the " + entry.cli + " command, which is not installed");
    }
    return entry;
  }

  invoke(command, args, options = {}) {
    const result = this.run(command, args, { env: this.env, ...options });
    if (result.error) {
      throw new Error(command + " could not run: " + (result.error.code ?? result.error.message));
    }
    return result;
  }

  available(record) {
    try {
      const backend = VaultBackends.backendOf(record.source);
      if (backend === "windows") {
        return this.platform === "win32" && existsSync(this.dpapiPath(record));
      }
      if (backend === "bitwarden") {
        return Boolean(this.which("bw")) && Boolean(this.env.BW_SESSION);
      }
      if (backend === "1password") {
        return Boolean(this.which("op"));
      }
      this.assertUsable(backend);
      if (backend === "macos") {
        return this.invoke("security", ["find-generic-password", "-s", "astack:" + record.provider, "-a", record.name]).status === 0;
      }
      if (backend === "linux") {
        const result = this.invoke("secret-tool", ["lookup", "service", "astack", "provider", record.provider, "name", record.name]);
        return result.status === 0 && result.stdout.length > 0;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Return the plaintext value, or null when nothing is stored. Only the
   * secret broker calls this, inside `resolve`, which audits the use.
   */
  read(record) {
    const backend = VaultBackends.backendOf(record.source);
    if (backend === "windows") {
      if (this.platform !== "win32") {
        throw new Error("vault:windows (DPAPI) is only available on Windows");
      }
      const path = this.dpapiPath(record);
      if (!existsSync(path)) {
        return null;
      }
      const ciphertext = readFileSync(path, "utf8").trim();
      const result = this.invoke("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand(DPAPI_UNPROTECT)], { input: ciphertext });
      if (result.status !== 0) {
        throw new Error("DPAPI could not decrypt " + record.reference + " (it can only be read by the Windows user who stored it)");
      }
      return Buffer.from(result.stdout.trim(), "base64").toString("utf8") || null;
    }
    this.assertUsable(backend);
    let result = null;
    if (backend === "macos") {
      result = this.invoke("security", ["find-generic-password", "-s", "astack:" + record.provider, "-a", record.name, "-w"]);
    } else if (backend === "linux") {
      result = this.invoke("secret-tool", ["lookup", "service", "astack", "provider", record.provider, "name", record.name]);
    } else if (backend === "bitwarden") {
      if (!this.env.BW_SESSION) {
        throw new Error("Bitwarden is locked: run `bw unlock` and export BW_SESSION");
      }
      result = this.invoke("bw", ["get", "password", record.item ?? "astack/" + record.provider + "/" + record.name]);
    } else if (backend === "1password") {
      result = this.invoke("op", ["read", record.item ?? "op://astack/" + record.provider + "-" + record.name + "/credential"]);
    }
    if (!result || result.status !== 0) {
      return null;
    }
    return result.stdout.replace(/\r?\n$/, "") || null;
  }

  /**
   * Store a value. The value goes to the backend on stdin; on Windows only the
   * DPAPI ciphertext touches the disk, written atomically.
   */
  write(record, value) {
    const backend = VaultBackends.backendOf(record.source);
    const secret = String(value ?? "");
    if (!secret) {
      throw new Error("Refusing to store an empty value");
    }
    if (!BACKEND_INFO[backend].writable) {
      throw new Error("vault:" + backend + " is read only here: store the value with " + BACKEND_INFO[backend].cli + " itself and reference the item");
    }
    this.assertUsable(backend);
    if (backend === "windows") {
      const result = this.invoke("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand(DPAPI_PROTECT)], {
        input: Buffer.from(secret, "utf8").toString("base64")
      });
      const ciphertext = result.stdout.trim();
      if (result.status !== 0 || !/^[0-9a-f]+$/i.test(ciphertext)) {
        throw new Error("DPAPI could not protect the value (exit " + result.status + ")");
      }
      mkdirSync(this.directory, { recursive: true });
      const path = this.dpapiPath(record);
      const temporary = path + ".tmp-" + process.pid;
      writeFileSync(temporary, ciphertext + "\n", { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, path);
      return { backend, location: ".astack/vault/" + record.provider + "." + record.name + ".dpapi" };
    }
    if (backend === "macos") {
      const line = "add-generic-password -U -s " + quoteForSecurity("astack:" + record.provider) + " -a " + quoteForSecurity(record.name) +
        " -l " + quoteForSecurity("AStack " + record.reference) + " -w " + quoteForSecurity(secret) + "\n";
      const result = this.invoke("security", ["-i"], { input: line });
      if (result.status !== 0) {
        throw new Error("security could not store the value (exit " + result.status + ")");
      }
      return { backend, location: "login keychain, service astack:" + record.provider };
    }
    const result = this.invoke(
      "secret-tool",
      ["store", "--label", "AStack " + record.reference, "service", "astack", "provider", record.provider, "name", record.name],
      { input: secret }
    );
    if (result.status !== 0) {
      throw new Error("secret-tool could not store the value (exit " + result.status + ")");
    }
    return { backend, location: "Secret Service, service astack" };
  }

  remove(record) {
    const backend = VaultBackends.backendOf(record.source);
    if (backend === "windows") {
      const path = this.dpapiPath(record);
      const existed = existsSync(path);
      rmSync(path, { force: true });
      return existed;
    }
    if (!BACKEND_INFO[backend].writable) {
      return false;
    }
    this.assertUsable(backend);
    if (backend === "macos") {
      return this.invoke("security", ["delete-generic-password", "-s", "astack:" + record.provider, "-a", record.name]).status === 0;
    }
    return this.invoke("secret-tool", ["clear", "service", "astack", "provider", record.provider, "name", record.name]).status === 0;
  }
}
