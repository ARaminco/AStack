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
import { Orchestrator } from "../orchestrator/orchestrator.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function createRuntime() {
  const configuration = new ConfigurationEngine(root);
  const eventBus = new EventBus();
  const providerRegistry = new ProviderRegistry(root);
  const pluginRegistry = new PluginRegistry(root);
  const knowledgePackRegistry = new KnowledgePackRegistry(root);
  const memory = new MemoryEngine(root);
  const workflows = new WorkflowEngine(root);
  const projects = new ProjectEngine(root, { memory, eventBus });
  const departments = JSON.parse(readFileSync(join(root, "departments", "departments.json"), "utf8")).departments;
  const providers = providerRegistry.list();
  const orchestrator = new Orchestrator({ departments, providers, workflows, memory, eventBus, projects });
  return { root, configuration, eventBus, providerRegistry, pluginRegistry, knowledgePackRegistry, memory, workflows, projects, departments, providers, orchestrator };
}
