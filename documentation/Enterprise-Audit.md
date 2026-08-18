# Enterprise Audit

## Architecture
Explicit layers: Core, Runtime, Orchestrator, Domains, Departments, Roles, Teams, Agents, Providers, Knowledge Packs, Plugins, Memory Engine, Workflow Engine, Delivery Engine, Team Engine, Agent Engine, Upgrade Engine, Localization Engine, Configuration Engine, Event Bus, Permission System, CLI, Installer, Documentation, Testing, Telemetry. `runtime/astack-runtime.mjs` is the single composition point.

## Coverage
Ten engagement domains (software, legal, finance, accounting, tax, marketing, operations, hr, research, business), 33 departments, 219 roles, 27 workflows, 8 delivery templates, 8 providers, 18 knowledge packs, 11 memory scopes.

## Scalability
Everything is manifest-driven: domains, departments, roles, workflows, templates, providers, plugins, and knowledge packs are JSON/Markdown catalogs. New entries require no Orchestrator changes. Teams and agents scale as flat JSON state under `.astack/` with event trails.

## Maintainability
Each engine has one narrow responsibility, an injectable clock, and the same persistence shape. Three verification suites cover structure and counts, delivery mathematics, and orchestration behavior (including a synthetic legacy-install upgrade). Stateful tests run in temp sandboxes.

## Lifecycle Management
The upgrade engine gives every embedded install a maintained path to the latest core: managed/seed/preserve classification, automatic config-section merging, full pre-replacement backups, `upgrade-report.json` audit records, and a standalone bootstrapper for pre-engine installs.

## Security
Telemetry disabled by default; least-privilege permission policy; secrets restricted to environment variables; no network surface; auditable event and memory trails. See [SECURITY.md](SECURITY.md).

## Localization
Persian owner-facing communication with English assets, four locales with English fallback, and bilingual (fa/en) domain and workflow detection.

## Claude Code Readiness
`CLAUDE.md` defines startup order, the leadership operating loop, communication policy, coordination rule, and verification commands. Installers converge on `astack doctor`.
