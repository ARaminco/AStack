import { parseArgs } from "../delivery-engine/cli.mjs";

const out = (line) => console.log(line);

/**
 * astack sandbox status | images | require <pattern> | exec [flags] -- <command> [args]
 */
export async function runSandboxCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "status", ...rest] = tokens;
  const sandbox = runtime.sandbox;

  if (action === "status") {
    const status = sandbox.status();
    out(t(status.running ? "cli.sandbox.running" : status.installed ? "cli.sandbox.daemonDown" : "cli.sandbox.notInstalled", { version: status.server ?? status.client ?? "" }));
    out("- image: " + status.image + " | network: " + status.network);
    const required = runtime.automationPolicy.policy.sandbox?.required_for ?? [];
    out("- " + t("cli.sandbox.requiredFor", { patterns: required.length ? required.join(", ") : "-" }));
    if (!status.running) {
      out(status.message);
    }
    return;
  }
  if (action === "images") {
    const images = sandbox.images();
    out(t("cli.sandbox.imagesTitle", { count: images.length }));
    for (const image of images) {
      out("- " + image.image + " | " + image.size + " | " + image.created);
    }
    return;
  }
  if (action === "require") {
    const pattern = rest.join(" ").trim();
    if (!pattern) {
      throw new Error(t("cli.sandbox.patternRequired"));
    }
    runtime.automationPolicy.requireSandboxPermanently(pattern);
    out(t("cli.sandbox.required", { pattern }));
    return;
  }
  if (action === "exec") {
    const separator = rest.indexOf("--");
    const flagTokens = separator === -1 ? [] : rest.slice(0, separator);
    const command = separator === -1 ? rest : rest.slice(separator + 1);
    if (!command.length) {
      throw new Error(t("cli.sandbox.commandRequired"));
    }
    const { flags } = parseArgs(flagTokens);
    const mounts = flags.mount ? String(flags.mount).split(",").map((entry) => entry.trim()).filter(Boolean) : [];
    const result = await sandbox.exec({
      command,
      image: flags.image ? String(flags.image) : null,
      network: flags.network ? String(flags.network) : null,
      workdir: flags.workdir ? String(flags.workdir) : null,
      mounts,
      timeoutMs: flags.timeout ? Number(flags.timeout) : null,
      memory: flags.memory ? String(flags.memory) : null,
      cpus: flags.cpus ? String(flags.cpus) : null,
      source: "cli"
    });
    if (result.denied) {
      out(t("cli.sandbox.denied", { reason: result.reason }));
      process.exitCode = 2;
      return;
    }
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    if (!result.ok) {
      out(t("cli.sandbox.failed", { code: String(result.exitCode), reason: result.reason ?? "" }));
      process.exitCode = typeof result.exitCode === "number" && result.exitCode > 0 ? result.exitCode : 1;
    }
    return;
  }
  throw new Error(t("cli.sandbox.unknownAction", { action }));
}
