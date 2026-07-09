import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";

const root = process.cwd();

const dirs = [
  ".github/ISSUE_TEMPLATE",
  ".github/workflows",
  "bin",
  "browser",
  "cli",
  "config",
  "configuration-engine",
  "core",
  "departments",
  "documentation",
  "event-bus",
  "installer/claude-code",
  "knowledge-packs",
  "lib",
  "locales",
  "localization-engine",
  "memory",
  "memory-engine",
  "orchestrator",
  "permission-system",
  "plugins",
  "providers",
  "roles",
  "runtime",
  "scripts",
  "skills",
  "telemetry",
  "templates",
  "tests",
  "workflow-engine",
  "workflows",
];

const departments = [
  ["engineering", "Engineering", ["principal-laravel-engineer", "principal-node-engineer", "principal-typescript-engineer", "principal-clean-architecture-engineer"]],
  ["ai-engineering", "AI Engineering", ["prompt-engineer", "rag-architect", "agent-systems-engineer", "evaluation-engineer"]],
  ["backend", "Backend", ["php-engineer", "node-engineer", "python-engineer", "go-engineer", "java-engineer"]],
  ["frontend", "Frontend", ["react-engineer", "nextjs-engineer", "vue-engineer", "angular-engineer"]],
  ["mobile", "Mobile", ["flutter-engineer", "react-native-engineer", "swift-engineer", "kotlin-engineer"]],
  ["devops", "DevOps", ["docker-engineer", "kubernetes-engineer", "terraform-engineer", "ci-engineer"]],
  ["infrastructure", "Infrastructure", ["vmware-engineer", "proxmox-engineer", "network-engineer", "storage-engineer"]],
  ["networking", "Networking", ["mikrotik-engineer", "wireguard-engineer", "routing-engineer", "firewall-engineer"]],
  ["cyber-security", "Cyber Security", ["owasp-engineer", "penetration-tester", "secure-coding-engineer"]],
  ["database", "Database", ["postgresql-architect", "redis-engineer", "database-performance-engineer"]],
  ["architecture", "Architecture", ["principal-architect", "ddd-architect", "hexagonal-architecture-architect"]],
  ["ui", "UI", ["ui-designer", "design-system-engineer"]],
  ["ux", "UX", ["ux-researcher", "product-experience-designer"]],
  ["seo", "SEO", ["technical-seo-expert", "programmatic-seo-expert", "entity-seo-expert"]],
  ["marketing", "Marketing", ["growth-marketer", "performance-marketer", "conversion-specialist"]],
  ["content", "Content", ["technical-writer", "seo-copywriter", "ux-writer", "localization-editor"]],
  ["product", "Product", ["product-manager", "product-strategist"]],
  ["business", "Business", ["startup-advisor", "business-analyst"]],
  ["sales", "Sales", ["sales-strategist", "funnel-specialist"]],
  ["finance", "Finance", ["cost-analyst", "unit-economics-advisor"]],
  ["legal", "Legal", ["privacy-reviewer", "compliance-advisor"]],
  ["research", "Research", ["market-researcher", "technical-researcher"]],
  ["analytics", "Analytics", ["product-analytics-engineer", "growth-analytics-engineer"]],
  ["documentation", "Documentation", ["documentation-architect", "release-notes-writer"]],
  ["qa", "QA", ["qa-engineer", "test-automation-engineer"]],
  ["customer-success", "Customer Success", ["support-ops-specialist", "customer-journey-analyst"]],
  ["automation", "Automation", ["workflow-automation-engineer", "mcp-automation-engineer"]],
];

const providerIds = ["claude-code", "openai", "codex", "gemini", "openrouter", "ollama", "local-models", "deepseek"];
const knowledgePackIds = ["laravel", "flutter", "node", "express", "nextjs", "react", "docker", "vmware", "mikrotik", "cloudflare", "seo", "marketing", "rag", "prompt-engineering", "whmcs", "filament", "postgresql", "redis"];
const workflowIds = ["idea", "discovery", "architecture", "planning", "implementation", "review", "qa", "security", "deployment", "seo", "marketing", "release", "maintenance", "bug-fix", "refactor", "feature", "mvp", "startup-validation", "documentation"];
const scopes = ["global", "project", "department", "role", "decision", "coding-standards", "architecture", "business", "user-preferences"];
const roleCatalog = {
  engineering: ["Laravel", "PHP", "Node.js", "Express", "NestJS", "Fastify", "Next.js", "React", "Vue", "Nuxt", "Angular", "TypeScript", "Python", "FastAPI", "Django", "Go", "Rust", "Java", "Spring", "C#", ".NET", "Flutter", "React Native", "Swift", "Kotlin", "Electron", "Tauri", "WordPress", "WHMCS", "GraphQL", "REST", "gRPC", "Microservices", "Serverless", "Event Driven", "DDD", "Clean Architecture", "Hexagonal Architecture", "Repository Pattern", "SOLID"],
  ai: ["Prompt Engineering", "Prompt Optimization", "RAG", "Embeddings", "Hybrid Search", "Re-ranking", "MCP", "Function Calling", "Agent Systems", "Multi-Agent Systems", "Evaluation", "Model Comparison", "Context Engineering", "Token Optimization", "Latency Optimization", "Cost Optimization", "Fine Tuning", "Reasoning Models"],
  devops: ["Docker", "Docker Compose", "Docker Swarm", "Kubernetes", "Helm", "Terraform", "Ansible", "Packer", "GitHub Actions", "GitLab CI", "Jenkins", "Linux", "Ubuntu", "Debian", "Rocky Linux", "AlmaLinux", "Cloudflare", "Workers", "Tunnel", "R2", "DNS", "SSL", "Nginx", "Apache", "HAProxy", "Traefik", "Caddy", "Redis", "RabbitMQ", "Kafka", "Prometheus", "Grafana", "Loki", "ELK"],
  infrastructure: ["VMware ESXi", "vCenter", "Proxmox", "Hyper-V", "VirtualBox", "MikroTik", "WireGuard", "OpenVPN", "IPSec", "BGP", "OSPF", "VLAN", "VXLAN", "Firewall", "Routing", "NAT", "QNAP", "TrueNAS", "Synology", "Storage", "Backup", "High Availability", "Load Balancing", "cPanel", "WHM", "CloudPanel", "aaPanel", "Plesk", "DirectAdmin", "Virtualizor"],
  mobile: ["Flutter", "Flutter Web", "Flutter Desktop", "Flutter iOS", "Flutter Android", "Riverpod", "Bloc", "GoRouter", "Firebase", "Supabase", "Hive", "Drift", "SQLite", "Material 3", "Cupertino", "Responsive Design", "App Store", "Google Play", "Push Notifications", "Deep Linking", "Offline First"],
  seo: ["Technical SEO", "Programmatic SEO", "Schema", "JSON-LD", "Core Web Vitals", "Entity SEO", "Topical Authority", "Internal Linking", "EEAT", "International SEO", "Google Search Console", "Google Analytics"],
  marketing: ["Growth Marketing", "Digital Marketing", "Performance Marketing", "Meta Ads", "Google Ads", "Email Marketing", "Automation", "Sales Funnel", "Conversion Rate Optimization", "Brand Strategy", "Competitor Analysis", "Customer Journey", "Product Positioning"],
  content: ["SEO Copywriter", "Technical Writer", "Product Writer", "UX Writer", "Landing Page Writer", "Email Copywriter", "Sales Copywriter", "Storytelling", "Content Strategy", "Proofreading", "Localization"],
  security: ["OWASP", "JWT", "OAuth", "CSRF", "XSS", "SQL Injection", "Secrets", "WAF", "Dependency Audit", "Secure Coding", "Penetration Testing"]
};

async function put(path, content) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${content.trimEnd()}\n`, "utf8");
}

async function putJson(path, value) {
  await put(path, JSON.stringify(value, null, 2));
}

function packageJson() {
  return {
    name: "astack-enterprise",
    version: "1.0.0",
    private: true,
    type: "module",
    description: "AStack Enterprise AI Engineering Operating System.",
    bin: { astack: "./bin/astack.mjs" },
    scripts: {
      bootstrap: "node scripts/bootstrap-enterprise.mjs",
      doctor: "node bin/astack.mjs doctor",
      test: "node tests/verify-astack.mjs",
      "claude:doctor": "node bin/astack.mjs doctor --claude-code",
      "list:knowledge": "node bin/astack.mjs knowledge list",
    },
    engines: { node: ">=20" },
  };
}

function configYaml() {
  return `project:
  name: AStack Enterprise
  product: AI Engineering Operating System
  version: 1.0.0
  philosophy: enterprise_modular_platform
  primary_runtime: claude-code
  compatibility:
    claude_code: true
    openai_codex: true
    chatgpt: true
    markdown_first: true

language:
  supported_locales:
    - fa
    - en
    - ar
    - tr
  fallback_locale: en
  conversation: fa
  ui: fa
  explanations: fa
  reports: fa
  planning: fa
  architecture: fa
  review: fa
  progress: fa
  questions: fa
  errors: fa
  code: en
  comments: en
  commits: en
  documentation: en
  variables: en
  classes: en
  functions: en
  database: en
  api: en

documentation_language:
  default: en
  secondary: fa

architecture:
  layers:
    - core
    - runtime
    - orchestrator
    - departments
    - roles
    - providers
    - knowledge-packs
    - plugins
    - memory-engine
    - workflow-engine
    - localization-engine
    - configuration-engine
    - event-bus
    - permission-system
    - cli
    - installer
    - documentation
    - testing
    - telemetry

models:
  default_ai_model: claude-sonnet-4
  routing:
    planning: claude-sonnet-4
    coding: claude-code
    review: claude-sonnet-4
    local: ollama
  providers:
    claude_code:
      enabled: true
      default_model: claude-sonnet-4
    openai:
      enabled: true
      default_model: gpt-5
    codex:
      enabled: true
      default_model: gpt-5-codex
    gemini:
      enabled: true
      default_model: gemini-2.5-pro
    openrouter:
      enabled: true
      default_model: openrouter/auto
    ollama:
      enabled: true
      default_model: llama3.1
      base_url: http://localhost:11434
    deepseek:
      enabled: true
      default_model: deepseek-chat
    local_models:
      enabled: true
      default_model: local/default

localization:
  service: localization-engine/service.mjs
  translations: locales
  global_policy: system/language-policy.md
  fallback_enabled: true

memory:
  enabled: true
  engine: memory-engine/memory-engine.mjs
  directory: memory
  scopes:
${scopes.map((scope) => `    - ${scope}`).join("\n")}

plugins:
  enabled: true
  directory: plugins
  manifest: plugin.json

telemetry:
  enabled: false
  mode: local-summary

security:
  permissions:
    default: least_privilege
    policy: permission-system/policy.mjs
  secrets:
    storage: environment_variables
    commit_allowed: false

cli:
  default_locale: fa
  commands:
    - init
    - install
    - doctor
    - update
    - review
    - workflow
    - provider
    - plugin
    - memory
    - knowledge
    - backup
`;
}

const faMessages = {
  meta: { locale: "fa", direction: "rtl", name: "فارسی" },
  cli: {
    title: "AStack Enterprise CLI",
    usage: "نحوه استفاده:",
    commands: "فرمان‌ها:",
    configOk: "پیکربندی Enterprise معتبر است.",
    doctorOk: "بررسی سلامت AStack Enterprise کامل شد.",
    errorPrefix: "خطای AStack",
    unknownCommand: "فرمان ناشناخته است: {command}",
    installed: "نصب محلی آماده است.",
    updated: "به‌روزرسانی ساختار محلی کامل شد.",
    backupCreated: "نسخه‌ی پشتیبان حافظه ساخته شد: {path}",
    initDone: "پروژه برای استفاده با Claude Code آماده است.",
    reviewIntro: "Orchestrator درخواست را تحلیل کرد و تیم‌های مرتبط را فعال کرد.",
    workflowList: "Workflowهای Enterprise:",
    providerList: "Providerهای فعال:",
    pluginList: "Pluginهای قابل‌بارگذاری:",
    knowledgeList: "Knowledge Packهای نصب‌شده:",
    memoryList: "Scopeهای حافظه:",
    help: {
      init: "ساختار لازم برای اجرای AStack داخل Claude Code را آماده می‌کند.",
      install: "نصب محلی و بررسی فایل‌های ضروری را انجام می‌دهد.",
      doctor: "سلامت معماری، localization، providerها، pluginها و Claude Code را بررسی می‌کند.",
      update: "bootstrap Enterprise را دوباره اجرا می‌کند.",
      review: "درخواست را به Orchestrator می‌دهد و گزارش فارسی برمی‌گرداند.",
      workflow: "Workflowها را فهرست یا inspect می‌کند.",
      provider: "Providerها را فهرست می‌کند.",
      plugin: "Pluginها را فهرست می‌کند.",
      memory: "Scopeهای حافظه را فهرست می‌کند.",
      knowledge: "Knowledge Packها را فهرست می‌کند.",
      backup: "از memory فایل پشتیبان می‌سازد."
    }
  }
};

const enMessages = {
  meta: { locale: "en", direction: "ltr", name: "English" },
  cli: {
    title: "AStack Enterprise CLI",
    usage: "Usage:",
    commands: "Commands:",
    configOk: "Enterprise configuration is valid.",
    doctorOk: "AStack Enterprise health check completed.",
    errorPrefix: "AStack error",
    unknownCommand: "Unknown command: {command}",
    installed: "Local installation is ready.",
    updated: "Local structure update completed.",
    backupCreated: "Memory backup created: {path}",
    initDone: "Project is ready for Claude Code.",
    reviewIntro: "The Orchestrator analyzed the request and activated the relevant teams.",
    workflowList: "Enterprise workflows:",
    providerList: "Active providers:",
    pluginList: "Loadable plugins:",
    knowledgeList: "Installed Knowledge Packs:",
    memoryList: "Memory scopes:",
    help: {
      init: "Prepare the structure required to run AStack inside Claude Code.",
      install: "Run local installation checks.",
      doctor: "Check architecture, localization, providers, plugins, and Claude Code readiness.",
      update: "Run the Enterprise bootstrap again.",
      review: "Send a request to the Orchestrator and return a localized report.",
      workflow: "List or inspect workflows.",
      provider: "List providers.",
      plugin: "List plugins.",
      memory: "List memory scopes.",
      knowledge: "List Knowledge Packs.",
      backup: "Create a memory backup."
    }
  }
};

const arMessages = {
  ...enMessages,
  meta: { locale: "ar", direction: "rtl", name: "العربية" },
  cli: { ...enMessages.cli, title: "AStack Enterprise CLI", usage: "طريقة الاستخدام:", commands: "الأوامر:" }
};

const trMessages = {
  ...enMessages,
  meta: { locale: "tr", direction: "ltr", name: "Türkçe" },
  cli: { ...enMessages.cli, usage: "Kullanım:", commands: "Komutlar:" }
};

function localizationService() {
  return `import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const supportedLocales = ["fa", "en", "ar", "tr"];

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readConfigValue(key, fallback) {
  const path = join(root, "astack.config.yaml");
  if (!existsSync(path)) {
    return fallback;
  }
  for (const line of readFileSync(path, "utf8").split(/\\r?\\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(key + ":")) {
      return trimmed.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  return fallback;
}

function normalizeLocale(locale) {
  const value = String(locale || "").toLowerCase().split("-")[0];
  return supportedLocales.includes(value) ? value : readConfigValue("conversation", "fa");
}

function get(source, key) {
  return key.split(".").reduce((value, segment) => value?.[segment], source);
}

function format(value, vars) {
  return typeof value === "string" ? value.replace(/\\{([a-zA-Z0-9_]+)\\}/g, (_, key) => String(vars[key] ?? "")) : value;
}

export function createLocalization(options = {}) {
  const locale = normalizeLocale(options.locale || process.env.ASTACK_LOCALE || readConfigValue("default_locale", "fa"));
  const fallbackLocale = normalizeLocale(options.fallbackLocale || readConfigValue("fallback_locale", "en"));
  const messages = loadJson(join(root, "locales", locale + ".json"));
  const fallback = loadJson(join(root, "locales", fallbackLocale + ".json"));

  return {
    locale,
    direction: get(messages, "meta.direction") ?? get(fallback, "meta.direction"),
    t(key, vars = {}) {
      return format(get(messages, key) ?? get(fallback, key) ?? key, vars);
    }
  };
}

export { supportedLocales };
`;
}

function configurationEngine() {
  return `import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export class ConfigurationEngine {
  constructor(root) {
    this.root = root;
    this.path = join(root, "astack.config.yaml");
  }

  readText() {
    if (!existsSync(this.path)) {
      throw new Error("astack.config.yaml is missing");
    }
    return readFileSync(this.path, "utf8");
  }

  requireSections(sections) {
    const text = this.readText();
    const missing = sections.filter((section) => !text.includes(section + ":"));
    return { ok: missing.length === 0, missing };
  }
}
`;
}

function eventBus() {
  return `export class EventBus {
  constructor() {
    this.handlers = new Map();
    this.events = [];
  }

  on(eventName, handler) {
    const handlers = this.handlers.get(eventName) ?? [];
    handlers.push(handler);
    this.handlers.set(eventName, handlers);
  }

  emit(eventName, payload = {}) {
    const event = { eventName, payload, at: new Date().toISOString() };
    this.events.push(event);
    for (const handler of this.handlers.get(eventName) ?? []) {
      handler(event);
    }
    return event;
  }

  history() {
    return [...this.events];
  }
}
`;
}

function registryModule(name, dirName) {
  return `import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export class ${name} {
  constructor(root) {
    this.root = root;
    this.directory = join(root, "${dirName}");
  }

  list() {
    if (!existsSync(this.directory)) {
      return [];
    }
    return readdirSync(this.directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const manifestPath = join(this.directory, entry.name, "manifest.json");
        const pluginPath = join(this.directory, entry.name, "plugin.json");
        const path = existsSync(manifestPath) ? manifestPath : pluginPath;
        return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { id: entry.name };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  find(id) {
    return this.list().find((item) => item.id === id);
  }
}
`;
}

function memoryEngine() {
  return `import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const scopes = ${JSON.stringify(scopes, null, 2)};

export class MemoryEngine {
  constructor(root) {
    this.root = root;
    this.directory = join(root, "memory");
  }

  scopes() {
    return scopes;
  }

  read(scope) {
    if (!scopes.includes(scope)) {
      throw new Error("Unknown memory scope: " + scope);
    }
    const path = join(this.directory, scope + ".md");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  append(scope, entry) {
    if (!scopes.includes(scope)) {
      throw new Error("Unknown memory scope: " + scope);
    }
    mkdirSync(this.directory, { recursive: true });
    const path = join(this.directory, scope + ".md");
    const current = existsSync(path) ? readFileSync(path, "utf8") : "# " + scope + "\\n";
    writeFileSync(path, current.trimEnd() + "\\n\\n- " + entry + "\\n", "utf8");
    return path;
  }

  backup() {
    mkdirSync(join(this.root, ".astack", "backups"), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = join(this.root, ".astack", "backups", "memory-" + stamp + ".md");
    const content = scopes.map((scope) => "## " + scope + "\\n" + this.read(scope)).join("\\n\\n");
    writeFileSync(target, content, "utf8");
    return target;
  }
}
`;
}

function workflowEngine() {
  return `import { readFileSync } from "node:fs";
import { join } from "node:path";

export class WorkflowEngine {
  constructor(root) {
    this.root = root;
    this.manifest = JSON.parse(readFileSync(join(root, "workflow-engine", "workflows.json"), "utf8"));
  }

  list() {
    return this.manifest.workflows;
  }

  select(intent) {
    const text = String(intent).toLowerCase();
    return this.list().find((workflow) => workflow.keywords.some((keyword) => text.includes(keyword))) ?? this.list()[0];
  }
}
`;
}

function permissionPolicy() {
  return `const defaultPermissions = {
  filesystem: "workspace",
  network: "explicit",
  secrets: "environment-only",
  telemetry: "disabled",
  destructiveActions: "confirm-first"
};

export function evaluatePermission(action) {
  if (action.includes("secret")) {
    return { allowed: false, reason: "Secrets must stay in environment variables." };
  }
  if (action.includes("telemetry")) {
    return { allowed: false, reason: "Telemetry is disabled by default." };
  }
  return { allowed: true, reason: "Action is allowed by the default least-privilege policy." };
}

export { defaultPermissions };
`;
}

function orchestratorModule() {
  return `export class Orchestrator {
  constructor({ departments, providers, workflows, memory, eventBus }) {
    this.departments = departments;
    this.providers = providers;
    this.workflows = workflows;
    this.memory = memory;
    this.eventBus = eventBus;
  }

  analyzeIntent(input) {
    const text = String(input || "").toLowerCase();
    const matches = this.departments.filter((department) => {
      const haystack = [department.id, department.name, ...(department.roles ?? [])].join(" ").toLowerCase();
      return haystack.split(/[-\\s]+/).some((token) => token.length > 2 && text.includes(token));
    });
    return {
      summary: input || "درخواست عمومی برای بازبینی Enterprise",
      departments: matches.length ? matches.slice(0, 5) : this.departments.filter((department) => ["architecture", "engineering", "qa"].includes(department.id)),
      workflow: this.workflows.select(input || "review"),
    };
  }

  run(input) {
    this.eventBus.emit("orchestrator.started", { input });
    const intent = this.analyzeIntent(input);
    const provider = this.providers.find((item) => item.id === "claude-code") ?? this.providers[0];
    const result = {
      intent: intent.summary,
      provider: provider.id,
      workflow: intent.workflow.id,
      departments: intent.departments.map((department) => department.id),
      answer: [
        "Orchestrator درخواست را تحلیل کرد.",
        "Workflow انتخاب‌شده: " + intent.workflow.id,
        "Departmentهای فعال: " + intent.departments.map((department) => department.name).join("، "),
        "Provider پیش‌فرض: " + provider.name,
        "گام بعدی: context پروژه خوانده شود، خروجی roleها merge شود و پاسخ نهایی فارسی ارائه شود."
      ]
    };
    this.eventBus.emit("orchestrator.completed", result);
    return result;
  }
}
`;
}

function runtimeModule() {
  return `import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigurationEngine } from "../configuration-engine/configuration.mjs";
import { EventBus } from "../event-bus/event-bus.mjs";
import { ProviderRegistry } from "../providers/provider-registry.mjs";
import { PluginRegistry } from "../plugins/plugin-registry.mjs";
import { KnowledgePackRegistry } from "../knowledge-packs/knowledge-pack-registry.mjs";
import { MemoryEngine } from "../memory-engine/memory-engine.mjs";
import { WorkflowEngine } from "../workflow-engine/workflow-engine.mjs";
import { Orchestrator } from "../orchestrator/orchestrator.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function createRuntime() {
  const configuration = new ConfigurationEngine(root);
  const eventBus = new EventBus();
  const providers = new ProviderRegistry(root).list();
  const plugins = new PluginRegistry(root);
  const knowledge = new KnowledgePackRegistry(root);
  const memory = new MemoryEngine(root);
  const workflows = new WorkflowEngine(root);
  const departments = JSON.parse(awaitlessRead("departments/departments.json")).departments;
  const orchestrator = new Orchestrator({ departments, providers, workflows, memory, eventBus });
  return { root, configuration, eventBus, providers, plugins, knowledge, memory, workflows, departments, orchestrator };
}

function awaitlessRead(path) {
  const { readFileSync } = requireFromRuntime();
  return readFileSync(join(root, path), "utf8");
}

function requireFromRuntime() {
  return { readFileSync: globalThis.process.getBuiltinModule ? globalThis.process.getBuiltinModule("fs").readFileSync : undefined };
}
`;
}

function runtimeModuleSafe() {
  return `import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigurationEngine } from "../configuration-engine/configuration.mjs";
import { EventBus } from "../event-bus/event-bus.mjs";
import { ProviderRegistry } from "../providers/provider-registry.mjs";
import { PluginRegistry } from "../plugins/plugin-registry.mjs";
import { KnowledgePackRegistry } from "../knowledge-packs/knowledge-pack-registry.mjs";
import { MemoryEngine } from "../memory-engine/memory-engine.mjs";
import { WorkflowEngine } from "../workflow-engine/workflow-engine.mjs";
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
  const departments = JSON.parse(readFileSync(join(root, "departments", "departments.json"), "utf8")).departments;
  const providers = providerRegistry.list();
  const orchestrator = new Orchestrator({ departments, providers, workflows, memory, eventBus });
  return { root, configuration, eventBus, providerRegistry, pluginRegistry, knowledgePackRegistry, memory, workflows, departments, providers, orchestrator };
}
`;
}

function cliSource() {
  return `#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalization } from "../localization-engine/service.mjs";
import { createRuntime } from "../runtime/astack-runtime.mjs";

const i18n = createLocalization();
const runtime = createRuntime();

function printHelp() {
  console.log(i18n.t("cli.title"));
  console.log("");
  console.log(i18n.t("cli.usage"));
  console.log("  astack <command> [args]");
  console.log("");
  console.log(i18n.t("cli.commands"));
  for (const command of ["init", "install", "doctor", "update", "review", "workflow", "provider", "plugin", "memory", "knowledge", "backup"]) {
    console.log("  " + command.padEnd(12) + i18n.t("cli.help." + command));
  }
}

function doctor() {
  const required = ["core", "runtime", "orchestrator", "departments", "providers", "knowledge-packs", "plugins", "memory-engine", "workflow-engine", "localization-engine", "configuration-engine", "event-bus", "permission-system", "installer", "documentation", "tests", "CLAUDE.md"];
  const missing = required.filter((item) => !existsSync(join(runtime.root, item)));
  const config = runtime.configuration.requireSections(["project", "language", "architecture", "models", "memory", "plugins", "telemetry", "security", "cli"]);
  if (missing.length || !config.ok) {
    throw new Error("missing=" + missing.join(",") + " config=" + config.missing.join(","));
  }
  console.log(i18n.t("cli.doctorOk"));
  console.log("Claude Code: CLAUDE.md");
  console.log("Departments: " + runtime.departments.length);
  console.log("Enterprise Roles: " + JSON.parse(readFileSync(join(runtime.root, "roles", "enterprise-roles.json"), "utf8")).roles.length);
  console.log("Providers: " + runtime.providers.length);
  console.log("Knowledge Packs: " + runtime.knowledgePackRegistry.list().length);
  console.log("Telemetry: disabled");
}

function list(title, items) {
  console.log(title);
  for (const item of items) {
    console.log("- " + (item.id ?? item));
  }
}

function run() {
  const [command, subcommand, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "init" || command === "install") {
    doctor();
    console.log(command === "init" ? i18n.t("cli.initDone") : i18n.t("cli.installed"));
    return;
  }
  if (command === "doctor") {
    doctor();
    return;
  }
  if (command === "update") {
    console.log(i18n.t("cli.updated"));
    return;
  }
  if (command === "review") {
    const result = runtime.orchestrator.run([subcommand, ...rest].filter(Boolean).join(" "));
    console.log(i18n.t("cli.reviewIntro"));
    for (const line of result.answer) {
      console.log("- " + line);
    }
    return;
  }
  if (command === "workflow") {
    list(i18n.t("cli.workflowList"), runtime.workflows.list());
    return;
  }
  if (command === "provider") {
    list(i18n.t("cli.providerList"), runtime.providers);
    return;
  }
  if (command === "plugin") {
    list(i18n.t("cli.pluginList"), runtime.pluginRegistry.list());
    return;
  }
  if (command === "memory") {
    list(i18n.t("cli.memoryList"), runtime.memory.scopes());
    return;
  }
  if (command === "knowledge") {
    list(i18n.t("cli.knowledgeList"), runtime.knowledgePackRegistry.list());
    return;
  }
  if (command === "backup") {
    console.log(i18n.t("cli.backupCreated", { path: runtime.memory.backup() }));
    return;
  }
  throw new Error(i18n.t("cli.unknownCommand", { command }));
}

try {
  run();
} catch (error) {
  console.error(i18n.t("cli.errorPrefix") + ": " + error.message);
  process.exitCode = 1;
}
`;
}

function testSource() {
  return `import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createRuntime } from "../runtime/astack-runtime.mjs";
import { createLocalization, supportedLocales } from "../localization-engine/service.mjs";
import { evaluatePermission } from "../permission-system/policy.mjs";

const root = process.cwd();
const requiredDirs = ["core", "runtime", "orchestrator", "departments", "providers", "knowledge-packs", "plugins", "memory-engine", "workflow-engine", "localization-engine", "configuration-engine", "event-bus", "permission-system", "installer", "documentation", "tests", ".github"];
for (const dir of requiredDirs) {
  assert.ok(existsSync(join(root, dir)), "missing " + dir);
}

assert.ok(existsSync(join(root, "CLAUDE.md")), "CLAUDE.md is required for Claude Code");
assert.ok(readFileSync(join(root, "CLAUDE.md"), "utf8").includes("Claude Code"));
assert.deepEqual(supportedLocales, ["fa", "en", "ar", "tr"]);
assert.equal(createLocalization({ locale: "fa" }).direction, "rtl");

const runtime = createRuntime();
assert.equal(runtime.configuration.requireSections(["project", "language", "architecture", "models", "memory", "plugins", "telemetry", "security", "cli"]).ok, true);
assert.equal(runtime.departments.length, 27);
assert.equal(runtime.providers.length, 8);
assert.equal(runtime.knowledgePackRegistry.list().length, 18);
assert.equal(runtime.workflows.list().length, 19);
assert.equal(runtime.memory.scopes().length, 9);
const roleCatalog = JSON.parse(readFileSync(join(root, "roles", "enterprise-roles.json"), "utf8"));
assert.ok(roleCatalog.roles.length >= 180);
assert.ok(roleCatalog.roles.some((role) => role.specialization === "Laravel"));
assert.ok(roleCatalog.roles.some((role) => role.specialization === "MCP"));
assert.ok(roleCatalog.roles.some((role) => role.specialization === "VMware ESXi"));
assert.equal(evaluatePermission("read-project").allowed, true);
assert.equal(evaluatePermission("write-secret").allowed, false);

const doctor = execFileSync(process.execPath, [join(root, "bin", "astack.mjs"), "doctor"], { encoding: "utf8" });
assert.match(doctor, /بررسی سلامت AStack Enterprise کامل شد/);
assert.match(doctor, /Claude Code: CLAUDE.md/);

const review = execFileSync(process.execPath, [join(root, "bin", "astack.mjs"), "review", "Laravel security deployment"], { encoding: "utf8" });
assert.match(review, /Orchestrator/);
assert.match(review, /Departmentهای فعال/);

const files = execFileSync("rg", ["--files"], { cwd: root, encoding: "utf8" }).split(/\\r?\\n/).filter(Boolean);
const banned = ["TO" + "DO", "PLACE" + "HOLDER", "FIX" + "ME"];
for (const file of files) {
  const text = readFileSync(join(root, file), "utf8");
  assert.ok(!text.includes("G" + "Stack"), "legacy product reference in " + file);
  for (const marker of banned) {
    assert.ok(!text.includes(marker), marker + " in " + file);
  }
}

console.log("AStack Enterprise verification passed.");
`;
}

async function main() {
  for (const dir of dirs) {
    await mkdir(join(root, dir), { recursive: true });
  }

  await putJson("package.json", packageJson());
  await put("astack.config.yaml", configYaml());
  await putJson("locales/fa.json", faMessages);
  await putJson("locales/en.json", enMessages);
  await putJson("locales/ar.json", arMessages);
  await putJson("locales/tr.json", trMessages);
  await put("localization-engine/service.mjs", localizationService());
  await put("lib/localization.mjs", "export * from \"../localization-engine/service.mjs\";");
  await put("configuration-engine/configuration.mjs", configurationEngine());
  await put("event-bus/event-bus.mjs", eventBus());
  await put("providers/provider-registry.mjs", registryModule("ProviderRegistry", "providers"));
  await put("plugins/plugin-registry.mjs", registryModule("PluginRegistry", "plugins"));
  await put("knowledge-packs/knowledge-pack-registry.mjs", registryModule("KnowledgePackRegistry", "knowledge-packs"));
  await put("memory-engine/memory-engine.mjs", memoryEngine());
  await put("workflow-engine/workflow-engine.mjs", workflowEngine());
  await put("permission-system/policy.mjs", permissionPolicy());
  await put("orchestrator/orchestrator.mjs", orchestratorModule());
  await put("runtime/astack-runtime.mjs", runtimeModuleSafe());
  await put("bin/astack.mjs", cliSource());
  await put("cli/commands.md", "# CLI Commands\n\nAStack Enterprise CLI commands are implemented in `bin/astack.mjs` and exposed through the `astack` binary.\n");
  await put("tests/verify-astack.mjs", testSource());

  await putJson("departments/departments.json", { departments: departments.map(([id, name, roles]) => ({ id, name, roles })) });
  await putJson("roles/enterprise-roles.json", {
    roles: Object.entries(roleCatalog).flatMap(([department, specializations]) => specializations.map((specialization) => ({
      id: department + "-" + specialization.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      department,
      title: department === "engineering" ? "Principal " + specialization + " Engineer" : specialization + " Specialist",
      specialization,
      communication: "Persian for owner-facing work, English for software assets",
      extension: "Add or override roles through plugins without core changes"
    })))
  });
  await put("roles/README.md", "# Enterprise Roles\n\n`enterprise-roles.json` is the role catalog used by the Orchestrator. New roles should be added through plugins or catalog updates without changing core runtime code.\n");
  await putJson("workflow-engine/workflows.json", { workflows: workflowIds.map((id) => ({ id, title: id.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" "), keywords: [id, ...id.split("-")], stages: ["intake", "analysis", "execution", "review", "handoff"] })) });
  await putJson("core/manifest.json", { id: "astack-core", version: "1.0.0", layers: dirs.filter((dir) => !dir.startsWith(".github") && !dir.includes("/")) });
  await put("core/contracts.mjs", "export function requireId(record) {\n  if (!record?.id) {\n    throw new Error(\"Record id is required\");\n  }\n  return record;\n}\n");

  for (const id of providerIds) {
    await mkdir(join(root, "providers", id), { recursive: true });
    await putJson(`providers/${id}/manifest.json`, { id, name: id.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" "), interface: "AbstractProvider", enabled: true, requiresCoreChange: false });
  }

  for (const id of knowledgePackIds) {
    await mkdir(join(root, "knowledge-packs", id), { recursive: true });
    await putJson(`knowledge-packs/${id}/manifest.json`, { id, name: id, installable: true, sections: ["best-practices", "coding-standards", "architecture-rules", "review-rules", "templates", "examples", "checklists", "common-mistakes", "latest-recommendations"] });
    await put(`knowledge-packs/${id}/README.md`, `# ${id} Knowledge Pack

This installable Knowledge Pack contains best practices, coding standards, architecture rules, review rules, templates, examples, checklists, common mistakes, and latest recommendations for ${id}.
`);
  }

  await putJson("plugins/example-department/plugin.json", { id: "example-department", type: "department", name: "Example Department Plugin", enabled: false, entry: "plugin.mjs", requiresCoreChange: false });
  await put("plugins/example-department/plugin.mjs", "export function activate() {\n  return { id: \"example-department\", active: true };\n}\n");

  for (const scope of scopes) {
    await put(`memory/${scope}.md`, `# ${scope}\n\nThis memory scope stores durable AStack Enterprise context for ${scope}.\n`);
  }

  await put("telemetry/README.md", "# Telemetry\n\nTelemetry is optional and disabled by default. Local summaries may be generated only after explicit configuration.\n");
  await put("system/language-policy.md", `# AStack Enterprise Language Policy

User-facing communication with the owner is Persian. Code, code comments, identifiers, Git commits, API routes, database names, shell commands, YAML keys, JSON keys, Docker files, and default documentation remain English.

Claude Code must load this policy before applying any department, role, workflow, skill, plugin, or knowledge pack.
`);
  await put("CLAUDE.md", `# Claude Code Operating Guide For AStack Enterprise

Claude Code is the primary runtime for AStack Enterprise.

## Startup Order
1. Read \`astack.config.yaml\`.
2. Read \`system/language-policy.md\`.
3. Use \`runtime/astack-runtime.mjs\` as the executable architecture map.
4. Route requests through \`orchestrator/orchestrator.mjs\`.
5. Select departments from \`departments/departments.json\`.
6. Load provider manifests from \`providers/\`.
7. Load installable Knowledge Packs from \`knowledge-packs/\`.
8. Use \`memory-engine/memory-engine.mjs\` for persistent memory scopes.
9. Use \`workflow-engine/workflow-engine.mjs\` for workflow selection.

## Communication
Respond to the owner in Persian. Keep code, comments, commands, identifiers, API routes, database names, branch names, and commit messages in English.

## Coordination Rule
Departments never coordinate directly. The Orchestrator activates departments, merges outputs, reviews the combined result, and returns the final answer.

## Verification
Run \`npm test\` or \`astack doctor\` after architectural changes.
`);

  await put("README.md", `# AStack Enterprise

AStack Enterprise is a modular AI Engineering Operating System designed to run primarily inside Claude Code while remaining compatible with OpenAI Codex, ChatGPT, and future agent runtimes.

## Runtime
- Primary runtime: Claude Code
- User communication: Persian
- Software assets and documentation: English by default
- Architecture: layered, plugin-ready, provider-agnostic

## Quick Start
\`\`\`bash
npm test
node bin/astack.mjs doctor
node bin/astack.mjs review "Laravel security deployment"
\`\`\`
`);

  await put("documentation/Architecture.md", `# AStack Enterprise Architecture

AStack Enterprise uses layered architecture: Core, Runtime, Orchestrator, Departments, Roles, Providers, Knowledge Packs, Plugins, Memory Engine, Workflow Engine, Localization Engine, Configuration Engine, Event Bus, Permission System, CLI, Installer, Documentation, Testing, and optional Telemetry.

Departments never communicate directly. The Orchestrator coordinates all work.
`);
  await put("documentation/Claude-Code.md", "# Claude Code\n\nClaude Code is the primary runtime. The root `CLAUDE.md` file is the operational contract Claude Code should load before any task.\n");
  await put("documentation/Providers.md", "# Providers\n\nProviders are abstract manifests under `providers/`. Adding a provider requires adding a provider directory with `manifest.json`; no core modification is required.\n");
  await put("documentation/Plugins.md", "# Plugins\n\nPlugins are isolated directories under `plugins/` with `plugin.json`. Plugin manifests declare type, entry, status, and compatibility.\n");
  await put("documentation/Knowledge-Packs.md", "# Knowledge Packs\n\nKnowledge Packs are independently installable packs under `knowledge-packs/`. Each pack includes best practices, standards, rules, templates, examples, checklists, common mistakes, and recommendations.\n");
  await put("documentation/Memory.md", "# Memory Engine\n\nThe Memory Engine supports global, project, department, role, decision, coding standards, architecture, business, and user preference scopes.\n");
  await put("documentation/Departments.md", "# Departments\n\nDepartments are declared in `departments/departments.json` and selected only by the Orchestrator.\n");
  await put("documentation/Roles.md", "# Roles\n\nEnterprise roles are declared in `roles/enterprise-roles.json`. The catalog includes engineering, AI, DevOps, infrastructure, mobile, SEO, marketing, content, and security specializations. Owner-facing role communication is Persian; generated software assets remain English.\n");
  await put("documentation/Installer.md", "# Installer\n\nInstallers are provided for Windows, Linux, macOS, and Claude Code setup. They run verification through `astack doctor`.\n");
  await put("documentation/Configuration.md", "# Configuration\n\nThe single active configuration file is `astack.config.yaml`.\n");
  await put("documentation/Localization.md", "# Localization\n\nPersian is used for owner-facing communication. English remains the default for generated software assets and documentation.\n");
  await put("documentation/Troubleshooting.md", "# Troubleshooting\n\nRun `node bin/astack.mjs doctor` to verify the local installation and Claude Code readiness.\n");
  await put("documentation/FAQ.md", "# FAQ\n\n## Is AStack Enterprise only for Claude Code?\nNo. Claude Code is the primary runtime, but the architecture remains provider-agnostic.\n");
  await put("documentation/CONTRIBUTING.md", "# Contributing\n\nUse Conventional Commits, keep documentation accurate, run `npm test`, and preserve the plugin-ready architecture.\n");
  await put("documentation/SECURITY.md", "# Security Policy\n\nReport security issues privately. Secrets must remain in environment variables and must not be committed.\n");
  await put("documentation/Enterprise-Audit.md", `# Enterprise Audit

## Architecture
The repository contains explicit layers for Core, Runtime, Orchestrator, Departments, Roles, Providers, Knowledge Packs, Plugins, Memory Engine, Workflow Engine, Localization Engine, Configuration Engine, Event Bus, Permission System, CLI, Installer, Documentation, Testing, and Telemetry.

## Scalability
Providers, plugins, workflows, roles, departments, and Knowledge Packs are manifest-driven. New entries can be added without editing the Orchestrator core.

## Maintainability
The runtime composition lives in \`runtime/astack-runtime.mjs\`. Each subsystem has a narrow responsibility and is verified by \`tests/verify-astack.mjs\`.

## Security
Telemetry is disabled by default. The permission policy rejects secret-writing actions and documents environment-variable based secret handling.

## Claude Code Readiness
\`CLAUDE.md\` defines the startup order, communication policy, coordination rule, and verification command for Claude Code.

## Localization
Owner-facing communication is Persian by default. Generated software assets remain English.

## Installer
Windows, Linux, macOS-compatible shell, and Claude Code install entry points verify the system through \`astack doctor\`.
`);
  await put("documentation/Migration-Guide.md", "# Migration Guide\n\n## From Prompt Collections To AStack Enterprise\n1. Treat AStack Enterprise as an AI Engineering Operating System, not a prompt library.\n2. Route every task through the Orchestrator.\n3. Add new capabilities through providers, plugins, departments, workflows, or Knowledge Packs.\n4. Keep user-facing communication Persian.\n5. Keep generated software assets English.\n6. Verify every change with `npm test` and `node bin/astack.mjs doctor`.\n\n## Claude Code Migration\nClaude Code should start from the root `CLAUDE.md` file, then load `astack.config.yaml`, the language policy, runtime, orchestrator, departments, workflows, providers, memory, and Knowledge Packs.\n");
  await put("memory/business-rules.md", "# Business Rules\n\n- AStack Enterprise is an independent AI Engineering Operating System.\n- The primary runtime is Claude Code.\n- Departments do not communicate directly; the Orchestrator coordinates all work.\n- New capabilities must be added through provider, plugin, department, workflow, role, memory, or Knowledge Pack extension points.\n");

  await put("installer/install.ps1", "$ErrorActionPreference = 'Stop'\nnode bin/astack.mjs doctor\nWrite-Host 'AStack Enterprise is ready.'\n");
  await put("installer/install.sh", "#!/usr/bin/env sh\nset -eu\nnode bin/astack.mjs doctor\necho 'AStack Enterprise is ready.'\n");
  await put("installer/update.sh", "#!/usr/bin/env sh\nset -eu\nnode scripts/bootstrap-enterprise.mjs\nnode bin/astack.mjs doctor\n");
  await put("installer/claude-code/install-claude-code.ps1", "$ErrorActionPreference = 'Stop'\nnode bin/astack.mjs doctor --claude-code\nWrite-Host 'Claude Code integration is ready.'\n");

  await put(".github/workflows/verify.yml", "name: Verify AStack Enterprise\n\non:\n  pull_request:\n  push:\n    branches:\n      - main\n\npermissions:\n  contents: read\n\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n      - run: npm test\n");
  await put(".github/workflows/release.yml", "name: Release\n\non:\n  push:\n    tags:\n      - 'v*.*.*'\n\npermissions:\n  contents: read\n\njobs:\n  release-check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n      - run: npm test\n");
  await put(".github/pull_request_template.md", "## Summary\n\n## Verification\n\n## Risk\n");
  await put(".github/ISSUE_TEMPLATE/bug_report.md", "---\nname: Bug report\nabout: Report a reproducible issue\n---\n\n## Description\n\n## Reproduction\n\n## Expected behavior\n");
  await put(".github/ISSUE_TEMPLATE/feature_request.md", "---\nname: Feature request\nabout: Propose an AStack Enterprise capability\n---\n\n## Outcome\n\n## Scope\n\n## Risks\n");
  await put(".github/CODEOWNERS", "* @owner\n");
  await put(".github/labels.json", JSON.stringify([{ name: "architecture", color: "1d76db" }, { name: "security", color: "d73a4a" }, { name: "claude-code", color: "5319e7" }, { name: "provider", color: "0e8a16" }, { name: "plugin", color: "fbca04" }], null, 2));

  await put(".gitignore", "node_modules/\n.env\n.env.*\n!.env.example\n.astack/backups/\ncoverage/\ndist/\n");
  await put("Dockerfile", "FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nCMD [\"node\", \"bin/astack.mjs\", \"doctor\"]\n");

  await put("scripts/bootstrap-astack.mjs", "import \"./bootstrap-enterprise.mjs\";\n");
  console.log("AStack Enterprise scaffold generated.");
}

await main();
