# AStack Documentation

AStack is a personal AI operating system for any practice — software, legal, finance, tax, accounting, marketing, operations, HR, research, and business. It classifies every engagement into a domain, forms a team of agents under a leadership layer, and delivers the work as a stage-gated project — all operable by Claude Code, Codex and compatible agent runtimes. Since 3.0 it also runs unattended in the background, answers on Telegram and WhatsApp, and has its own console, Aramin.

**Readme languages:** [English](../README.md) · [فارسی](../README.fa.md) · [العربية](../README.ar.md) · [Türkçe](../README.tr.md) · Persian owner guide: [fa-guide.html](fa-guide.html)

## Getting Started
- [Installation](Installation.md) — fresh install, embedding, agent use, turning on the daemon, console and gateway
- [Installer](Installer.md) — platform install scripts and `astack doctor`
- [FAQ](FAQ.md) — the questions everyone asks first
- [Troubleshooting](Troubleshooting.md) — diagnostics and common errors

## New in 3.0 — always on, in your pocket
- [Runner and Daemon](Runner-and-Daemon.md) — unattended runs (Claude Code, Codex, Ollama), budgets, one background process, OS service install
- [Gateway](Gateway.md) — command and approve from Telegram and WhatsApp, owner allowlists, local Persian voice
- [Aramin Console](Aramin-Console.md) — the local installable console: sign in, screens, trust model, API
- [Search](Search.md) — Persian-aware recall over memory, past sessions, reports, skills and missions
- [Skill Hub](Skill-Hub.md) — third-party skill packs, the security scanner, the curator and the Hermes pack
- [Board, Sandbox, Vault and A2A](Board-Sandbox-Vault.md) — multi-agent board, Docker sandbox, OS vault backends, Agent-to-Agent endpoint
- [3.0 Build Contract](V3-Plan.md) — the rules and shared interfaces the 3.0 packages were built against (historical)
- [Changelog](../CHANGELOG.md) — highlights and the detailed notes of every release

## The Autonomous Organization
- [Autonomous Organization](Autonomous-Organization.md) — the full lifecycle, architecture and feature status
- [Memory OS](Memory-OS.md) — twelve temporal memory facets, recall and consolidation
- [Search](Search.md) — one index over memory, past sessions and reports (3.0)
- [Context Engine](Context-Engine.md) — repo map, symbol index, budgeted retrieval
- [Knowledge Graph](Knowledge-Graph.md) — temporal entities and relationships
- [Learning Engine](Learning-Engine.md) — experience to skills, with reinforcement
- [Skill System](Skill-System.md) — built in and learned skills, progressive disclosure
- [Practice Skills](Practice-Skills.md) — plan-review, code-review, investigate, qa and ship, with lazy sections (3.5)
- [Skill Hub](Skill-Hub.md) — auxiliary skill packs below the built-in skills (3.0)
- [Agent Runtimes](Agent-Runtimes.md) — the runtime abstraction and model router
- [Tool System](Tool-System.md) — the tool registry and gated invocation
- [Browser Operator](Browser-Operator.md) — the internal browser, sessions and evidence
- [Scheduler and Signals](Scheduler-and-Signals.md) — background jobs and inbound hooks
- [Runner and Daemon](Runner-and-Daemon.md) — unattended execution and the background process (3.0)
- [Security and Authority](Security-and-Authority.md) — authority levels, policy, secrets, 3.0 hardening
- [Audit and Approvals](Audit-and-Approvals.md) — human in the loop and the audit trail
- [Token Optimization](Token-Optimization.md) — budgets, progressive disclosure, measurement
- [Graphify](Graphify.md) — code knowledge graph for both runtimes, capped and metered

## Concepts
- [Architecture](Architecture.md) — layers, module map, data flow, design rules
- [Domains, Teams, Agents, and Leadership](Orchestration.md) — the orchestration stack
- [Project Management](Project-Management.md) — the delivery engine end to end
- [Departments](Departments.md) — the 33-department catalog and selection
- [Roles](Roles.md) — the 219-role catalog and how agents use it
- [Memory](Memory.md) — durable scopes and the calibration loop

## Operations
- [CLI Reference](CLI.md) — every command, grouped by capability
- [API Reference](API.md) — every CLI command and the programmatic runtime
- [Configuration](Configuration.md) — every section of `astack.config.yaml`
- [Core Upgrades](Upgrade.md) — upgrading current and legacy installs
- [Migration Guide](Migration-Guide.md) — 1.x → 2.x and adoption paths
- [Deployment](Deployment.md) — distribution model and release checklist
- [Database](Database.md) — state storage and database guidance

## Extending
- [Development](Development.md) — test suites, adding capabilities, conventions
- [Providers](Providers.md) — AI runtime manifests and model routing
- [Plugins](Plugins.md) — isolated extensions
- [Knowledge Packs](Knowledge-Packs.md) — installable knowledge modules
- [Localization](Localization.md) — locales, fallback, bilingual detection
- [Contributing](CONTRIBUTING.md) — contribution rules

## Assurance
- [Enterprise Audit](Enterprise-Audit.md) — architecture, scalability, security review
- [Security Policy](SECURITY.md) — reporting and principles
- [Codex and Claude Code](Codex-and-Claude-Code.md) — one contract, one memory, one journal for both runtimes
- [Claude Code Runtime](Claude-Code.md) — how Claude Code operates AStack
