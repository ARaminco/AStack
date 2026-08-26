import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigurationEngine } from "../configuration-engine/configuration.mjs";
import { EventBus } from "../event-bus/event-bus.mjs";
import { ProviderRegistry } from "../providers/provider-registry.mjs";
import { PluginRegistry } from "../plugins/plugin-registry.mjs";
import { KnowledgePackRegistry } from "../knowledge-packs/knowledge-pack-registry.mjs";
import { MemoryEngine } from "../memory-engine/memory-engine.mjs";
import { WorkflowEngine } from "../workflow-engine/workflow-engine.mjs";
import { ProjectEngine } from "../delivery-engine/project-engine.mjs";
import { DomainRegistry } from "../domains/domain-registry.mjs";
import { TeamEngine } from "../team-engine/team-engine.mjs";
import { AgentEngine } from "../agent-engine/agent-engine.mjs";
import { Leadership } from "../agent-engine/leadership.mjs";
import { Orchestrator } from "../orchestrator/orchestrator.mjs";
import { GraphEngine } from "../knowledge-graph/graph-engine.mjs";
import { ContextEngine } from "../context-engine/context-engine.mjs";
import { LearningEngine } from "../learning-engine/learning-engine.mjs";
import { SkillCatalog } from "../learning-engine/skill-catalog.mjs";
import { AutomationPolicy } from "../permission-system/automation-policy.mjs";
import { AuthorityEngine } from "../trust-engine/authority.mjs";
import { AuditEngine } from "../trust-engine/audit.mjs";
import { ApprovalEngine } from "../trust-engine/approvals.mjs";
import { SecretBroker } from "../trust-engine/secrets.mjs";
import { BrowserEngine } from "../browser-engine/browser-engine.mjs";
import { ToolRegistry } from "../tool-registry/tool-registry.mjs";
import { RuntimeRegistry } from "../runtime-providers/agent-runtime.mjs";
import { ClaudeCodeRuntime } from "../runtime-providers/adapters/claude-code.mjs";
import { CliRuntime } from "../runtime-providers/adapters/cli-runtime.mjs";
import { MockRuntime } from "../runtime-providers/adapters/mock-runtime.mjs";
import { ModelRouter } from "../runtime-providers/model-router.mjs";
import { MissionEngine } from "../mission-engine/mission-engine.mjs";
import { SchedulerEngine } from "../scheduler-engine/scheduler-engine.mjs";
import { SignalEngine } from "../signal-engine/signal-engine.mjs";
import { ChiefOfStaff } from "../chief-of-staff/chief-of-staff.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The executable architecture map.
 *
 * Every engine is constructed once, wired to the engines it depends on, and
 * exposed on one runtime object. Reading this function top to bottom is the
 * fastest way to understand how AStack fits together.
 */
export function createRuntime({ clock, workspaceRoot = root } = {}) {
  const configuration = new ConfigurationEngine(root);
  const eventBus = new EventBus();
  const providerRegistry = new ProviderRegistry(root);
  const pluginRegistry = new PluginRegistry(root);
  const knowledgePackRegistry = new KnowledgePackRegistry(root);

  const contextConfig = configuration.section("context", {});
  const learningConfig = configuration.section("learning", {});
  const budgets = {
    ownerCapsule: contextConfig.owner_capsule_budget ?? 800,
    memory: contextConfig.memory_budget ?? 2500,
    project: contextConfig.project_budget ?? 3500,
    repoMap: contextConfig.repo_map_budget ?? 2000,
    skills: contextConfig.skill_budget ?? 3000,
    tools: contextConfig.tool_catalog_budget ?? 500,
    total: contextConfig.retrieval_budget ?? 12000
  };

  const memory = new MemoryEngine(workspaceRoot, { clock });
  const graph = new GraphEngine(workspaceRoot, { clock, eventBus });
  const workflows = new WorkflowEngine(root);
  const projects = new ProjectEngine(workspaceRoot, { memory, eventBus, clock });
  const domains = new DomainRegistry(root);
  const teams = new TeamEngine(workspaceRoot, { eventBus, domains, clock });
  const agents = new AgentEngine(workspaceRoot, { memory, eventBus, clock });
  const leadership = new Leadership({ domains, teams, agents, projects, clock });

  const context = new ContextEngine(workspaceRoot, { domains, memory, clock });
  const learning = new LearningEngine(workspaceRoot, {
    clock,
    memory,
    eventBus,
    thresholds: {
      minOccurrences: learningConfig.min_occurrences ?? 3,
      minDistinctDays: learningConfig.min_distinct_days ?? 2,
      minSuccessRate: learningConfig.min_success_rate ?? 0.6
    }
  });
  const skills = new SkillCatalog(root, { learning, workspaceRoot });

  const automationPolicy = new AutomationPolicy(workspaceRoot);
  const authority = new AuthorityEngine(workspaceRoot, { clock, eventBus });
  const audit = new AuditEngine(workspaceRoot, { clock, eventBus });
  const approvals = new ApprovalEngine(workspaceRoot, { clock, eventBus, audit });
  const secrets = new SecretBroker(workspaceRoot, { clock, eventBus, audit });

  const browser = new BrowserEngine(workspaceRoot, { clock, eventBus, policy: automationPolicy, audit, authority, memory });

  const runtimes = new RuntimeRegistry(workspaceRoot, { clock, eventBus });
  runtimes.register(new ClaudeCodeRuntime({ root: workspaceRoot, clock, eventBus }));
  runtimes.register(new MockRuntime({ root: workspaceRoot, clock, eventBus }));
  for (const [id, providerConfig] of Object.entries(configuration.section("runtime", {}).providers ?? {})) {
    if (id === "claude-code" || id === "mock") {
      continue;
    }
    runtimes.register(new CliRuntime(id, { root: workspaceRoot, clock, eventBus, config: providerConfig, policy: automationPolicy }));
  }
  const modelRouter = new ModelRouter(workspaceRoot, { registry: runtimes, clock, config: configuration.section("routing", {}) });

  const services = { memory, graph, context, learning, projects, agents, teams, browser, skills };
  const tools = new ToolRegistry(root, { workspaceRoot, clock, services, policy: automationPolicy, authority, audit, secrets, approvals });

  const missions = new MissionEngine(workspaceRoot, {
    clock,
    eventBus,
    tools,
    approvals,
    audit,
    learning,
    memory,
    router: modelRouter,
    runtimes
  });

  const scheduler = new SchedulerEngine(workspaceRoot, { clock, eventBus, services, policy: automationPolicy });
  const signals = new SignalEngine(workspaceRoot, {
    clock,
    eventBus,
    domains,
    policy: automationPolicy,
    audit,
    services: { memory, learning, missions, agents, scheduler, projects, browser }
  });
  scheduler.services = { ...services, missions, signals, scheduler };
  tools.services = { ...services, missions, scheduler, signals };

  const chief = new ChiefOfStaff(workspaceRoot, {
    clock,
    eventBus,
    domains,
    memory,
    graph,
    context,
    projects,
    learning,
    tools,
    teams,
    agents,
    missions,
    authority,
    approvals,
    audit,
    router: modelRouter,
    runtimes,
    workflows,
    budgets
  });

  const departments = JSON.parse(readFileSync(join(root, "departments", "departments.json"), "utf8")).departments;
  const providers = providerRegistry.list();
  const orchestrator = new Orchestrator({
    departments,
    providers,
    workflows,
    memory,
    eventBus,
    projects,
    domains,
    teams,
    agents,
    missions,
    approvals,
    scheduler,
    learning,
    context
  });

  return {
    root,
    workspaceRoot,
    configuration,
    budgets,
    eventBus,
    providerRegistry,
    pluginRegistry,
    knowledgePackRegistry,
    memory,
    graph,
    workflows,
    projects,
    domains,
    teams,
    agents,
    leadership,
    context,
    learning,
    skills,
    automationPolicy,
    authority,
    audit,
    approvals,
    secrets,
    browser,
    tools,
    runtimes,
    modelRouter,
    missions,
    scheduler,
    signals,
    chief,
    departments,
    providers,
    orchestrator
  };
}
