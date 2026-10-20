#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EconomyEngine } from "../economy-engine/economy-engine.mjs";
import { mergeConfig, readEconomyConfig } from "../economy-engine/storage.mjs";

try {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  const input = JSON.parse(raw);
  const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
  const core = join(dirname(fileURLToPath(import.meta.url)), "..");
  const config = mergeConfig(readEconomyConfig(core), readEconomyConfig(root));
  const engine = new EconomyEngine({ root, config });
  const step = process.argv[2];
  const methods = { route: "route", tool: "guardTool", "subagent-start": "onSubagentStart", "subagent-stop": "onSubagentStop", prompt: "onPrompt" };
  if (step === "statusline") {
    const index = process.argv.indexOf("--chain");
    const chain = index >= 0 ? JSON.parse(Buffer.from(process.argv[index + 1], "base64url").toString("utf8")) : undefined;
    process.stdout.write(engine.statusline(input, { chain, raw }));
  } else if (methods[step]) {
    const result = engine[methods[step]](input);
    if (result) {
      process.stdout.write(JSON.stringify(result));
    }
  }
} catch (error) {
  try {
    const directory = join(homedir(), ".astack", "economy");
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, "hook-errors.log"), new Date().toISOString() + " " + process.argv[2] + " " + error.name + " " + (error.code ?? "") + " " + (error.stack?.split("\n")[1]?.trim() ?? "") + "\n");
  } catch {
    // Hooks must never crash the session, even when the log is unavailable.
  }
}
