import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/**
 * The astack MCP server: one tool surface for every runtime.
 *
 * Claude Code (.mcp.json) and Codex (.codex/config.toml) both launch this
 * server over stdio. Every tool runs the astack CLI with an argument vector,
 * never a shell string, so the server can never do anything the CLI would not
 * do — the same trust rules, the same storage, the same output in both
 * runtimes. The protocol is newline-delimited JSON-RPC 2.0, implemented here
 * without dependencies.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "bin", "astack.mjs");
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const text = (description) => ({ type: "string", description });
const number = (description) => ({ type: "number", description });
const list = (description) => ({ type: "array", items: { type: "string" }, description });

function optional(flag, value) {
  return value === undefined || value === null || value === "" ? [] : ["--" + flag, String(value)];
}

/**
 * Tool definitions. `args` maps validated input to a CLI argument vector;
 * `source` is the calling runtime so stored records keep their provenance.
 */
export const mcpTools = [
  {
    name: "astack_standup",
    description: "Owner capsule, open missions, pending approvals, learning and background jobs — the shared starting state for Claude Code and Codex.",
    inputSchema: { type: "object", properties: {} },
    args: () => ["standup"]
  },
  {
    name: "astack_memory_search",
    description: "Recall from the shared AStack memory (the one store both Claude Code and Codex read). Use before acting.",
    inputSchema: {
      type: "object",
      properties: {
        query: text("What to recall"),
        facet: text("Optional facet: identity, semantic, episodic, project, entity, relationship, procedural, decision, preference, working, calibration, lesson"),
        project: text("Optional project id"),
        asOf: text("Optional ISO date to answer as of that time"),
        limit: number("Maximum results, default 10")
      },
      required: ["query"]
    },
    args: (input) => [
      "memory", "search", String(input.query),
      ...optional("facet", input.facet), ...optional("project", input.project),
      ...optional("asOf", input.asOf), ...optional("limit", input.limit)
    ]
  },
  {
    name: "astack_memory_remember",
    description: "Write a durable fact to the shared AStack memory so the other runtime knows it too. Never store secrets, codes, card numbers or credentials.",
    inputSchema: {
      type: "object",
      properties: {
        title: text("The fact, one line"),
        body: text("Optional detail"),
        facet: text("Facet, default semantic"),
        project: text("Optional project id"),
        domain: text("Optional domain"),
        importance: number("0..1, default 0.5")
      },
      required: ["title"]
    },
    args: (input, source) => [
      "memory", "remember", String(input.title),
      ...optional("body", input.body), ...optional("facet", input.facet), ...optional("project", input.project),
      ...optional("domain", input.domain), ...optional("importance", input.importance), "--source", source
    ]
  },
  {
    name: "astack_memory_supersede",
    description: "Correct a remembered fact without losing history: the old record stays answerable with asOf.",
    inputSchema: {
      type: "object",
      properties: { id: text("Record id to supersede"), title: text("Corrected fact"), body: text("Optional detail") },
      required: ["id", "title"]
    },
    args: (input) => ["memory", "supersede", String(input.id), "--title", String(input.title), ...optional("body", input.body)]
  },
  {
    name: "astack_memory_entity",
    description: "Resolve a person, company, project or case in the knowledge graph and show its neighbours.",
    inputSchema: { type: "object", properties: { name: text("Entity name") }, required: ["name"] },
    args: (input) => ["memory", "entity", String(input.name)]
  },
  {
    name: "astack_context_map",
    description: "Token-budgeted map of the files and symbols relevant to a question. Use instead of reading the workspace.",
    inputSchema: { type: "object", properties: { question: text("The question") }, required: ["question"] },
    args: (input) => ["context", "map", String(input.question)]
  },
  {
    name: "astack_context_search",
    description: "Ranked search over the context index; open only the returned paths and line ranges.",
    inputSchema: { type: "object", properties: { terms: text("Search terms") }, required: ["terms"] },
    args: (input) => ["context", "search", String(input.terms)]
  },
  {
    name: "astack_ask",
    description: "Chief of Staff analysis of a request: intent, entities, context, skills, tools, runtime, authority and proposed team. Read-only.",
    inputSchema: { type: "object", properties: { request: text("The owner's request") }, required: ["request"] },
    args: (input) => ["ask", String(input.request)]
  },
  {
    name: "astack_skill_catalog",
    description: "Compact catalog of available and learned skills; load a full skill only after selecting it.",
    inputSchema: { type: "object", properties: {} },
    args: () => ["skill", "catalog"]
  },
  {
    name: "astack_handoff_write",
    description: "Record a structured handoff (done, findings, open questions, next step) so the next session in either runtime continues from it.",
    inputSchema: {
      type: "object",
      properties: {
        summary: text("One-line summary"),
        done: text("What was done"),
        findings: list("Findings"),
        openQuestions: list("Open questions"),
        next: text("Recommended next step"),
        project: text("Optional project id")
      },
      required: ["summary"]
    },
    args: (input, source) => [
      "interop", "handoff", String(input.summary), "--runtime", source,
      ...optional("done", input.done),
      ...optional("findings", Array.isArray(input.findings) ? input.findings.join(";") : input.findings),
      ...optional("open", Array.isArray(input.openQuestions) ? input.openQuestions.join(";") : input.openQuestions),
      ...optional("next", input.next), ...optional("project", input.project)
    ]
  },
  {
    name: "astack_journal",
    description: "Latest sessions and handoffs from both Claude Code and Codex.",
    inputSchema: { type: "object", properties: { limit: number("Entries, default 10") } },
    args: (input) => ["interop", "journal", ...optional("limit", input.limit)]
  },
  {
    name: "astack_interop_status",
    description: "Prove that Claude Code and Codex share the same contract, memory and wiring.",
    inputSchema: { type: "object", properties: {} },
    args: () => ["interop", "status"]
  }
];

/** Map an MCP client name onto an AStack runtime id. */
export function runtimeFromClient(clientInfo = {}) {
  const name = String(clientInfo.name ?? "").toLowerCase();
  if (name.includes("claude")) {
    return "claude-code";
  }
  if (name.includes("codex") || name.includes("openai")) {
    return "codex";
  }
  return name ? name.replace(/[^a-z0-9-]/g, "-") : "mcp";
}

function runCli(args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { cwd: root, timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, ASTACK_MCP: "1" } },
      (error, stdout, stderr) => {
        const output = (String(stdout ?? "") + (stderr ? "\n" + String(stderr) : "")).trim();
        resolve({ ok: !error, output: output || (error ? error.message : "(no output)") });
      }
    );
  });
}

export function createMcpHandler({ version = "0.0.0", run = runCli } = {}) {
  let source = "mcp";
  return async function handle(message) {
    const { id, method, params = {} } = message;
    const reply = (result) => (id === undefined ? null : { jsonrpc: "2.0", id, result });
    const fail = (code, error) => (id === undefined ? null : { jsonrpc: "2.0", id, error: { code, message: error } });
    switch (method) {
      case "initialize": {
        source = runtimeFromClient(params.clientInfo);
        const requested = params.protocolVersion;
        return reply({
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "astack", version },
          instructions:
            "AStack shared brain. Claude Code and Codex read and write the same memory and journal through these tools. " +
            "Recall with astack_memory_search before acting, store durable facts with astack_memory_remember, " +
            "and finish substantial work with astack_handoff_write."
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: mcpTools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case "tools/call": {
        const tool = mcpTools.find((entry) => entry.name === params.name);
        if (!tool) {
          return fail(-32602, "Unknown tool: " + params.name);
        }
        const input = params.arguments ?? {};
        const missing = (tool.inputSchema.required ?? []).filter((key) => input[key] === undefined || input[key] === "");
        if (missing.length) {
          return reply({ content: [{ type: "text", text: "Missing required input: " + missing.join(", ") }], isError: true });
        }
        const result = await run(tool.args(input, source));
        return reply({ content: [{ type: "text", text: result.output }], isError: !result.ok });
      }
      default:
        if (method?.startsWith("notifications/")) {
          return null;
        }
        return fail(-32601, "Method not found: " + method);
    }
  };
}

export async function serveMcp({ input = process.stdin, output = process.stdout } = {}) {
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const handle = createMcpHandler({ version });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set();
  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
      continue;
    }
    const task = handle(message)
      .then((response) => {
        if (response) {
          output.write(JSON.stringify(response) + "\n");
        }
      })
      .catch((error) => {
        if (message.id !== undefined) {
          output.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error.message } }) + "\n");
        }
      })
      .finally(() => pending.delete(task));
    pending.add(task);
  }
  await Promise.all(pending);
}
