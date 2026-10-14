import { parseArgs } from "../delivery-engine/cli.mjs";
import { SecretBroker } from "../trust-engine/secrets.mjs";
import { VAULT_BACKENDS, VaultBackends } from "../trust-engine/vault.mjs";

const out = (line) => console.log(line);

/**
 * Read a secret without echoing it: from a pipe when stdin is not a terminal,
 * otherwise from a hidden prompt. The value never appears in argv.
 */
export async function readSecretValue({ prompt = "Value: ", stdin = process.stdin, stderr = process.stderr } = {}) {
  if (!stdin.isTTY) {
    const chunks = [];
    for await (const chunk of stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    // Windows PowerShell pipes a UTF-8 byte-order mark ahead of the value; it is
    // never part of a secret.
    return Buffer.concat(chunks).toString("utf8").replace(/^﻿/, "").replace(/\r?\n$/, "");
  }
  stderr.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const finish = (error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stderr.write("\n");
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n" || character === "\u0004") {
          finish(null);
          return;
        }
        if (character === "\u0003") {
          finish(new Error("cancelled"));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };
    stdin.on("data", onData);
  });
}

function recordFor(secrets, reference) {
  try {
    const { provider, name } = SecretBroker.parse(reference);
    return secrets.get("credential://" + provider + "/" + name);
  } catch {
    return null;
  }
}

/**
 * Point an existing or new reference at a vault backend, keeping its
 * description, scope, site and expiry.
 */
function ensureVaultRecord(secrets, reference, backend, flags) {
  const source = "vault:" + backend;
  const existing = recordFor(secrets, reference);
  if (existing && existing.source === source && !flags.item) {
    return existing;
  }
  secrets.register({
    reference,
    description: flags.describe ? String(flags.describe) : existing?.description ?? "",
    source,
    scope: existing?.scope ?? [],
    site: existing?.site ?? null,
    expiresAt: existing?.expiresAt ?? null
  });
  if (flags.item) {
    // The password-manager item a read-only backend looks up.
    const state = secrets.read();
    const index = state.credentials.findIndex((entry) => entry.reference === recordFor(secrets, reference)?.reference);
    state.credentials[index] = { ...state.credentials[index], item: String(flags.item) };
    secrets.write(state);
  }
  return recordFor(secrets, reference);
}

/**
 * astack secret vault status | set <ref> | test <ref> | remove <ref>
 */
export async function runVaultCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [, action = "status", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const secrets = runtime.secrets;
  const vault = secrets.vault;

  if (action === "status") {
    out(t("cli.vault.statusTitle", { backend: vault.defaultBackend() ?? "-" }));
    for (const entry of vault.status()) {
      out("- " + entry.source + " | " + entry.mode + " | " + (entry.writable ? "read/write" : "read only") + " | " + entry.detail + (entry.default ? " | default" : ""));
    }
    const stored = secrets.list().filter((entry) => VaultBackends.isVaultSource(entry.source));
    out(t("cli.vault.references", { count: stored.length }));
    for (const entry of stored) {
      out("- " + entry.reference + " | " + entry.source + " | " + (entry.available ? "available" : "missing"));
    }
    return;
  }
  if (action === "set") {
    const reference = positionals[0];
    SecretBroker.parse(reference);
    const backend = String(flags.backend ?? vault.defaultBackend() ?? "");
    if (!VAULT_BACKENDS.includes(backend)) {
      throw new Error(t("cli.vault.unknownBackend", { backend, backends: VAULT_BACKENDS.join(", ") }));
    }
    const record = ensureVaultRecord(secrets, reference, backend, flags);
    const status = vault.status().find((entry) => entry.backend === backend);
    if (!status.writable) {
      out(t("cli.vault.linked", { reference: record.reference, source: record.source }));
      return;
    }
    const value = await readSecretValue({ prompt: t("cli.vault.prompt", { reference: record.reference }) });
    const stored = vault.write(record, value);
    out(t("cli.vault.stored", { reference: record.reference, location: stored.location }));
    return;
  }
  if (action === "test") {
    const record = recordFor(secrets, positionals[0]);
    if (!record) {
      throw new Error(t("cli.vault.unknownReference", { reference: positionals[0] }));
    }
    try {
      const value = secrets.resolve(record.reference, { requester: "astack-cli", purpose: "vault test" });
      out(t("cli.vault.testOk", { reference: record.reference, source: record.source, length: value.length }));
    } catch (error) {
      out(t("cli.vault.testFailed", { reference: record.reference, reason: error.message }));
      process.exitCode = 1;
    }
    return;
  }
  if (action === "remove") {
    const record = recordFor(secrets, positionals[0]);
    if (!record) {
      throw new Error(t("cli.vault.unknownReference", { reference: positionals[0] }));
    }
    if (VaultBackends.isVaultSource(record.source)) {
      vault.remove(record);
    }
    if (!flags.keepReference) {
      secrets.remove(record.reference);
    }
    out(t("cli.vault.removed", { reference: record.reference }));
    return;
  }
  throw new Error(t("cli.vault.unknownAction", { action }));
}
