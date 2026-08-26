import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { estimateTokens, jaccard, uniqueTokens } from "../lib/text.mjs";

export const toolStatuses = ["implemented", "experimental", "adapter-ready", "mock-only", "future"];

/**
 * Universal tool registry with progressive disclosure.
 *
 * Agents never receive every tool schema. They get a one line catalog, search
 * it by capability, and only then load the full manifest of the tool they
 * picked. Every tool declares its risk, permissions, credentials and whether
 * it supports a dry run, so the authority engine can rule on it before it runs.
 */
export class ToolRegistry {
  constructor(root, { workspaceRoot = null, services = {}, policy = null, authority = null, audit = null, secrets = null } = {}) {
    this.root = root;
    this.workspaceRoot = workspaceRoot ?? root;
    this.manifestPath = join(root, "tool-registry", "tools.json");
    this.customDirectory = join(this.workspaceRoot, ".astack", "tools");
    this.services = services;
    this.policy = policy;
    this.authority = authority;
    this.audit = audit;
    this.secrets = secrets;
    this.customHandlers = {};
  }

  /**
   * Bind a live implementation to a tool action. This is how an integration
   * adapter — a mail provider, a portal client, a database driver — becomes
   * executable without touching the core registry.
   */
  registerHandler(toolId, action, handler) {
    if (typeof handler !== "function") {
      throw new Error("A tool handler must be a function");
    }
    this.customHandlers[toolId] = { ...(this.customHandlers[toolId] ?? {}), [action]: handler };
    return this.customHandlers[toolId];
  }

  manifest() {
    const builtin = existsSync(this.manifestPath) ? JSON.parse(readFileSync(this.manifestPath, "utf8")).tools : [];
    const custom = existsSync(this.customDirectory)
      ? readdirSync(this.customDirectory)
          .filter((name) => name.endsWith(".json"))
          .map((name) => {
            try {
              return JSON.parse(readFileSync(join(this.customDirectory, name), "utf8"));
            } catch {
              return null;
            }
          })
          .filter(Boolean)
      : [];
    const merged = new Map();
    for (const tool of [...builtin, ...custom]) {
      merged.set(tool.id, { ...(merged.get(tool.id) ?? {}), ...tool });
    }
    return [...merged.values()];
  }

  list({ status = null, capability = null } = {}) {
    return this.manifest()
      .filter((tool) => !status || tool.status === status)
      .filter((tool) => !capability || (tool.capabilities ?? []).includes(capability))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * The minimal catalog an agent sees at startup: one line per tool, bounded
   * by a token budget.
   */
  catalog({ budget = 500, status = ["implemented", "experimental", "adapter-ready"] } = {}) {
    const lines = [];
    let used = 0;
    for (const tool of this.list().filter((tool) => status.includes(tool.status))) {
      const line = "- " + tool.id + " (" + tool.riskLevel + ", " + tool.status + "): " + (tool.capabilities ?? []).join(",");
      const cost = estimateTokens(line);
      if (used + cost > budget) {
        break;
      }
      used += cost;
      lines.push(line);
    }
    return { lines, tokens: used, tools: lines.length, total: this.list().length };
  }

  search(capability, { limit = 5 } = {}) {
    const tokens = uniqueTokens(capability);
    return this.manifest()
      .map((tool) => {
        const haystack = uniqueTokens([tool.id, tool.name, tool.description, ...(tool.capabilities ?? [])].join(" "));
        const direct = (tool.capabilities ?? []).some((entry) => tokens.includes(entry)) ? 0.6 : 0;
        return { tool, score: Number((jaccard(tokens, haystack) + direct).toFixed(3)) };
      })
      .filter((entry) => entry.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => ({ id: entry.tool.id, name: entry.tool.name, status: entry.tool.status, riskLevel: entry.tool.riskLevel, score: entry.score }));
  }

  inspect(id) {
    const tool = this.manifest().find((entry) => entry.id === id);
    if (!tool) {
      throw new Error("Unknown tool: " + id + ". Available: " + this.manifest().map((entry) => entry.id).join(", "));
    }
    return tool;
  }

  register(tool) {
    if (!tool?.id) {
      throw new Error("A tool manifest needs an id");
    }
    if (tool.status && !toolStatuses.includes(tool.status)) {
      throw new Error("Unknown tool status: " + tool.status);
    }
    mkdirSync(this.customDirectory, { recursive: true });
    writeFileSync(join(this.customDirectory, tool.id + ".json"), JSON.stringify(tool, null, 2) + "\n", "utf8");
    return tool;
  }

  actionRisk(toolId, action) {
    const tool = this.inspect(toolId);
    const entry = (tool.actions ?? []).find((item) => item.name === action);
    return entry?.risk ?? tool.riskLevel ?? "L3";
  }

  /**
   * Invoke a tool action through the registry so that authority, policy and
   * audit always apply, whoever the caller is.
   */
  async invoke(toolId, action, params = {}, { mission = null, actor = "astack", approvalId = null, dryRun = false, domain = null } = {}) {
    const tool = this.inspect(toolId);
    const risk = this.actionRisk(toolId, action);
    if (["adapter-ready", "future", "mock-only"].includes(tool.status)) {
      return {
        ok: false,
        status: tool.status,
        summary: "tool " + toolId + " is " + tool.status + ": no live adapter is installed for this workspace",
        tool: toolId,
        action
      };
    }
    const decision = this.authority?.evaluate({
      action: toolId + "." + action,
      level: risk,
      tool: toolId,
      domain,
      site: params.url ?? null,
      mission
    }) ?? { allowed: true, requiresApproval: false, blocked: false, reason: "no authority engine" };
    if (decision.blocked) {
      return { ok: false, summary: "blocked: " + decision.reason, tool: toolId, action, decision };
    }
    if (decision.requiresApproval && !approvalId) {
      return { ok: false, requiresApproval: true, summary: "approval required: " + decision.reason, tool: toolId, action, decision };
    }
    if (dryRun) {
      return { ok: true, dryRun: true, summary: "dry run for " + toolId + "." + action, tool: toolId, action, decision, params };
    }
    const handler = this.customHandlers[toolId]?.[action] ?? this.handlers()[toolId]?.[action];
    if (!handler) {
      return { ok: false, summary: "tool " + toolId + " has no runnable action " + action, tool: toolId, action };
    }
    const started = Date.now();
    let result = null;
    try {
      result = await handler(params);
    } catch (error) {
      result = { ok: false, summary: error.message };
    }
    const durationMs = Date.now() - started;
    this.audit?.record({
      actor,
      tool: toolId,
      action,
      target: params.url ?? params.path ?? params.id ?? null,
      riskLevel: risk,
      approval: approvalId ? "granted" : decision.requiresApproval ? "granted" : "not-required",
      result: result?.summary ?? (result?.ok === false ? "failed" : "ok"),
      mission,
      metadata: { durationMs }
    });
    return { ok: result?.ok !== false, durationMs, tool: toolId, action, ...result };
  }

  handlers() {
    const services = this.services;
    const root = this.workspaceRoot;
    return {
      context: {
        map: async (params) => ({ ok: true, summary: "context map", data: services.context?.map(params) }),
        query: async (params) => ({ ok: true, summary: "context query", data: services.context?.query(params.text ?? params.query, params) }),
        expand: async (params) => ({ ok: true, summary: "context expand", data: services.context?.expand(params.path) }),
        build: async (params) => ({ ok: true, summary: "context build", data: services.context?.build(params) })
      },
      memory: {
        recall: async (params) => ({ ok: true, summary: "memory recall", data: services.memory?.recall(params) }),
        remember: async (params) => ({ ok: true, summary: "memory remember", data: services.memory?.remember(params.facet ?? "semantic", params) }),
        consolidate: async () => ({ ok: true, summary: "memory consolidate", data: services.memory?.consolidate() })
      },
      graph: {
        resolve: async (params) => ({ ok: true, summary: "graph resolve", data: services.graph?.resolve(params.text, params) }),
        neighbours: async (params) => ({ ok: true, summary: "graph neighbours", data: services.graph?.neighbours(params.id, params) }),
        upsert: async (params) => ({ ok: true, summary: "graph upsert", data: services.graph?.upsertNode(params) }),
        relate: async (params) => ({ ok: true, summary: "graph relate", data: services.graph?.relate(params) })
      },
      scheduler: {
        add: async (params) => ({ ok: true, summary: "job created", data: services.scheduler?.create(params) }),
        run: async (params) => ({ ok: true, summary: "job executed", data: await services.scheduler?.runJob(params.id, { manual: true }) }),
        tick: async () => ({ ok: true, summary: "scheduler tick", data: await services.scheduler?.tick() }),
        list: async () => ({ ok: true, summary: "jobs", data: services.scheduler?.list() })
      },
      agents: {
        assign: async (params) => ({ ok: true, summary: "assignment created", data: services.agents?.assign(params.agentId, params) }),
        runDue: async () => ({ ok: true, summary: "missions dispatched", data: services.agents?.runDue() })
      },
      project: {
        status: async (params) => ({ ok: true, summary: "project status", data: services.projects?.status(params.projectId) }),
        addWorkItem: async (params) => ({ ok: true, summary: "work item added", data: services.projects?.addWorkItem(params.projectId, params) })
      },
      browser: {
        plan: async (params) => ({ ok: true, summary: "browser plan", data: services.browser?.plan(params) }),
        run: async (params) => {
          const result = await services.browser?.run(params);
          return { ok: Boolean(result?.ok), summary: result?.summary ?? "browser run", data: result };
        },
        login: async (params) => {
          const result = await services.browser?.login(params.profile, params);
          return { ok: true, summary: "login session captured", data: result };
        },
        resume: async (params) => {
          const result = await services.browser?.resume(params.mission, params);
          return { ok: Boolean(result?.ok), summary: result?.summary ?? "browser resume", data: result };
        },
        health: async (params) => ({ ok: true, summary: "session health", data: services.browser?.health(params.profile) })
      },
      http: {
        request: async (params) => {
          const verdict = this.policy?.allowHost(params.url) ?? { allowed: true };
          if (!verdict.allowed) {
            return { ok: false, summary: "blocked by automation policy: " + verdict.reason };
          }
          const headers = { ...(params.headers ?? {}) };
          if (params.credential && this.secrets) {
            headers.authorization = "Bearer " + this.secrets.resolve(params.credential, { requester: "http-tool", purpose: "api call" });
          }
          const response = await fetch(params.url, {
            method: params.method ?? "GET",
            headers,
            body: params.body ? (typeof params.body === "string" ? params.body : JSON.stringify(params.body)) : undefined,
            signal: AbortSignal.timeout(params.timeoutMs ?? 20000)
          });
          const text = await response.text();
          return {
            ok: response.ok,
            summary: "HTTP " + response.status,
            data: { status: response.status, body: text.slice(0, 4000) }
          };
        }
      },
      filesystem: {
        read: async (params) => {
          const path = safePath(root, params.path);
          if (!existsSync(path)) {
            return { ok: false, summary: "file not found: " + params.path };
          }
          const content = readFileSync(path, "utf8").slice(0, params.maxBytes ?? 40000);
          return { ok: true, summary: "read " + params.path, data: { content } };
        },
        list: async (params) => {
          const path = safePath(root, params.path ?? ".");
          if (!existsSync(path)) {
            return { ok: false, summary: "path not found: " + params.path };
          }
          const entries = readdirSync(path, { withFileTypes: true }).map((entry) => ({
            name: entry.name,
            directory: entry.isDirectory(),
            size: entry.isFile() ? statSync(join(path, entry.name)).size : null
          }));
          return { ok: true, summary: entries.length + " entries", data: { entries } };
        },
        write: async (params) => {
          const path = safePath(root, params.path);
          mkdirSync(join(path, ".."), { recursive: true });
          writeFileSync(path, String(params.content ?? ""), "utf8");
          return { ok: true, summary: "wrote " + params.path };
        }
      },
      shell: {
        run: async (params) => {
          const verdict = this.policy?.allowCommand(params.command) ?? { allowed: true };
          if (!verdict.allowed) {
            return { ok: false, summary: "blocked by automation policy: " + verdict.reason };
          }
          const { execFile } = await import("node:child_process");
          return new Promise((resolveResult) => {
            execFile(
              params.command,
              params.args ?? [],
              { cwd: params.cwd ? safePath(root, params.cwd) : root, timeout: params.timeoutMs ?? 60000, windowsHide: true },
              (error, stdout, stderr) => {
                resolveResult(
                  error
                    ? { ok: false, summary: "command failed: " + error.message.slice(0, 200), data: { stderr: String(stderr).slice(-2000) } }
                    : { ok: true, summary: "command finished", data: { stdout: String(stdout).slice(-4000) } }
                );
              }
            );
          });
        }
      }
    };
  }

  stats() {
    const tools = this.manifest();
    const byStatus = {};
    for (const tool of tools) {
      byStatus[tool.status] = (byStatus[tool.status] ?? 0) + 1;
    }
    return { tools: tools.length, byStatus, catalogTokens: this.catalog().tokens };
  }
}

function safePath(root, target) {
  const absolute = resolve(root, String(target ?? "."));
  const rel = relative(root, absolute);
  if (rel.startsWith("..")) {
    throw new Error("Path escapes the workspace: " + target);
  }
  return absolute;
}

export { safePath };
