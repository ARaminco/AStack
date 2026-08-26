# AStack Enterprise Architecture

AStack Enterprise is a layered, manifest-driven operating system for AI-run work. Version 2 generalizes it beyond software: any engagement — a lawsuit, a VAT filing, an accounting close, a hiring round, a product build — is classified into a domain, staffed by a team of agents, and delivered as a stage-gated project.

## Layers
Core, Runtime, Chief of Staff, Orchestrator, Domains, Departments, Roles, Teams, Agents, Providers, Knowledge Packs, Plugins, Memory Engine, Knowledge Graph, Context Engine, Learning Engine, Mission Engine, Scheduler Engine, Signal Engine, Browser Engine, Tool Registry, Runtime Providers, Trust Engine, Workflow Engine, Delivery Engine, Team Engine, Agent Engine, Upgrade Engine, Localization Engine, Configuration Engine, Event Bus, Permission System, CLI, Installer, Documentation, Testing, and optional Telemetry.

The autonomy layer added in version 2.1 sits above the original orchestration
stack without replacing it: see [Autonomous Organization](Autonomous-Organization.md).

## Module Map

| Module | Path | Responsibility |
| --- | --- | --- |
| Runtime | `runtime/astack-runtime.mjs` | Single composition point: builds every engine and wires dependencies |
| Orchestrator | `orchestrator/orchestrator.mjs` | Intent analysis, domain-aware department activation, briefings, final answer |
| Domain Registry | `domains/` | Ten engagement domains with bilingual keywords, departments, workflow, deliverables, team blueprint |
| Departments | `departments/departments.json` | 33 departments referencing the role catalog |
| Roles | `roles/enterprise-roles.json` | 219 professional roles (specialization + communication policy) |
| Workflow Engine | `workflow-engine/` | 27 workflows with staged lifecycles and scored bilingual keyword selection |
| Delivery Engine | `delivery-engine/` | Projects: charters, stage gates, PERT, WSJF backlog, WIP board, sprints, risks, Monte Carlo forecasts, EVM, health, next actions |
| Team Engine | `team-engine/` | Team assembly from domain blueprints; lifecycle `forming → active → paused → disbanded` |
| Agent Engine | `agent-engine/agent-engine.mjs` | Agents, scheduled missions (`30m…1w`), work-order dispatch, reports, standups |
| Leadership | `agent-engine/leadership.mjs` | Plan → form team → delegate (round-robin per department) → standup → review |
| Upgrade Engine | `upgrade-engine/` | Managed/seed/preserve upgrades with backups, config-section merge, standalone bootstrapper |
| Memory Engine | `memory-engine/` | Eleven durable Markdown scopes incl. `team`, `agent`, calibration feed |
| Localization | `localization-engine/`, `locales/` | fa/en/ar/tr with English fallback |
| Configuration | `configuration-engine/`, `astack.config.yaml` | Section validation, owner-editable settings |
| Event Bus | `event-bus/` | In-process events for every mutation |
| Permission System | `permission-system/` | Least-privilege defaults; secrets and telemetry rejected |
| Chief of Staff | `chief-of-staff/` | Owner model, intent engine, just in time team planner, engagement briefs |
| Context Engine | `context-engine/` | Incremental workspace index, domain lenses, personalized PageRank, budgeted map, context router |
| Knowledge Graph | `knowledge-graph/` | Temporal entities and relationships with supersede semantics |
| Learning Engine | `learning-engine/` | Episodes, pattern mining, skill forge, reinforcement, skill catalog |
| Mission Engine | `mission-engine/` | Durable resumable missions with approval checkpoints, dry run and replay |
| Scheduler Engine | `scheduler-engine/` | Cron and interval jobs, monitors, retries, incidents, supervisor daemon |
| Signal Engine | `signal-engine/` | Verified inbound webhooks, normalization, rules and reactions |
| Browser Engine | `browser-engine/` | CDP driven internal browser, persistent profiles, chained evidence |
| Tool Registry | `tool-registry/` | Tool manifests, capability search, policy gated invocation |
| Runtime Providers | `runtime-providers/` | Runtime abstraction, adapters, model router |
| Trust Engine | `trust-engine/` | Authority levels, approvals and receipts, audit trail, secret broker |
| CLI | `bin/astack.mjs`, `cli/`, `delivery-engine/cli.mjs` | Localized command surface |

## Coordination Model
Departments and agents never communicate directly. The Orchestrator (with the Leadership layer) activates domains, departments, teams, and agents, merges outputs, reviews the combined result, and returns one final answer. Agent results flow only through reports and the review queue.

## Data Flow
```
owner request (fa/en)
  -> DomainRegistry.detect          # which practice?
  -> Orchestrator.analyzeIntent     # departments + workflow
  -> Leadership.propose/formTeam    # team + one agent per role
  -> ProjectEngine (template)       # stage-gated plan
  -> Leadership.delegate            # work items -> scheduled missions
  -> AgentEngine.runDue             # work orders to outboxes
  -> runtime executes work orders   # Claude Code, in-role
  -> AgentEngine.report             # results + memory trail
  -> Leadership.standup/review      # supervision
  -> Orchestrator                   # merged Persian answer to the owner
```

State is file-backed (`.astack/` JSON + `memory/` Markdown), every mutation emits an event and appends to an event trail, and all engines accept injectable clocks for deterministic tests.

## Autonomy Data Flow
```
owner request
  -> ChiefOfStaff.brief            # intent, entities, memory, map, skills, tools, runtime, team
  -> AuthorityEngine.evaluate      # autonomous, needs approval, or denied
  -> MissionEngine.create/run      # durable steps through the tool registry
  -> ApprovalEngine.request        # stop before anything irreversible
  -> BrowserEngine / tools         # the actual external action, with evidence
  -> AuditEngine.record            # who did what, under which authority
  -> LearningEngine.record         # the episode, and a skill when it repeats
```

## Design Rules
1. One composition point (`createRuntime`) — engines never construct each other.
2. Capability enters through manifests, never through Orchestrator special cases.
3. Owner data and core code are strictly separated so upgrades stay safe.
4. Persian for the owner, English for assets — enforced by the language policy and locale files.
