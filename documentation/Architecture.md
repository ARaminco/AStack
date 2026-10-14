# AStack Enterprise Architecture

AStack Enterprise is a layered, manifest-driven operating system for AI-run work. Version 2 generalizes it beyond software: any engagement — a lawsuit, a VAT filing, an accounting close, a hiring round, a product build — is classified into a domain, staffed by a team of agents, and delivered as a stage-gated project.

## Layers
Core, Runtime, Chief of Staff, Orchestrator, Domains, Departments, Roles, Teams, Agents, Providers, Knowledge Packs, Plugins, Memory Engine, Knowledge Graph, Context Engine, Learning Engine, Mission Engine, Scheduler Engine, Signal Engine, Browser Engine, Tool Registry, Runtime Providers, Trust Engine, Workflow Engine, Delivery Engine, Team Engine, Agent Engine, Upgrade Engine, Localization Engine, Configuration Engine, Event Bus, Permission System, CLI, Installer, Documentation, Testing, and optional Telemetry. Version 3.0 adds Runner Engine, Daemon Engine, Gateway Engine, Search Engine, Skill Hub, Aramin Console, Board Engine, Sandbox Engine, vault backends and the A2A endpoint.

The autonomy layer added in version 2.1 sits above the original orchestration
stack without replacing it: see [Autonomous Organization](Autonomous-Organization.md).

Version 3.0 adds an always-on layer on top of the autonomy layer — Runner
Engine, Daemon Engine, Gateway Engine, Search Engine, Skill Hub, Aramin
Console, Board Engine, Sandbox Engine, vault backends and the A2A endpoint —
again without replacing anything beneath it (see [Always-on layer](#always-on-layer-30)).

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
| Runner Engine (3.0) | `runner-engine/` | Unattended execution of a work order or mission through Claude Code headless, `codex exec`, Ollama or a mock; budgets, concurrency, queue |
| Daemon Engine (3.0) | `daemon-engine/` | One background process supervising every `<engine>/service.mjs`; OS service install |
| Gateway Engine (3.0) | `gateway-engine/` | Owner messaging over Telegram and WhatsApp: allowlist, commands, approvals by message, local voice |
| Search Engine (3.0) | `search-engine/` | SQLite FTS5 and optional Ollama embeddings over memory, past sessions, reports, skills and missions |
| Skill Hub (3.0) | `skill-hub/`, `skill-packs/` | Third-party skill packs, static scanner, curator; packs rank below built-in skills |
| Aramin Console (3.0) | `console/` | Local installable PWA over the same engines; owner decisions only |
| Board Engine (3.0) | `board-engine/` | Durable multi-agent kanban executed through the runner |
| Sandbox Engine (3.0) | `sandbox-engine/` | Docker-isolated command execution behind the automation policy |
| Vault and redaction (3.0) | `trust-engine/vault.mjs`, `trust-engine/redaction.mjs` | OS keychain sources for the secret broker; scrubbing resolved secrets from outputs |
| A2A endpoint (3.0) | `interop-engine/a2a-server.mjs` | Agent-to-Agent JSON-RPC server, plan-only by default |
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

## Always-on layer (3.0)

The 3.0 engines are new *entry points* and *executors* around the same core.
They never decide anything themselves: every irreversible step still stops at
`runtime.approvals`, every level is checked by `runtime.authority`, every
spawned command or network target passes `runtime.automationPolicy`, and every
action lands in `runtime.audit`.

```
 owner surfaces           CLI (astack run)    Gateway (Telegram/WhatsApp)    Aramin console    A2A (other agents)
                                │                    │                            │               │ plan-only by default
                                └──────────┬─────────┴────────────┬───────────────┘               │
 background triggers   Scheduler (kind agent) · Signals (run-agent) · Board cards                  │
                                           │                                                       │
                                           ▼                                                       ▼
                               runtime.runner.execute ◄──────────────────────────── runtime.chief.dryRun
                                           │
               ┌───────────────────────────┼─────────────────────────────┐
               ▼                           ▼                             ▼
     Chief of Staff brief       MissionEngine.run (missionId)   engine child process
     (context, memory, search,  steps through the tool registry  claude -p / codex exec / Ollama
      skills, tools, ceiling)   stop at waiting-approval        tools clamped to the ceiling,
                                                                 APPROVAL-REQUEST: lines
                                           │                             │
                                           └──────────────┬──────────────┘
                                                          ▼
                              ApprovalEngine.request ──► gateway prompt / console card / CLI
                                                          │  owner decides (owner@<surface>)
                                                          ▼
                              receipt ──► runner resume / mission resume ──► AuditEngine.record
```

- **Runner** is the only executor. It builds the same work order as a hosted
  session (`buildWorkOrder`), runs the engine with read-only tools unless the
  ceiling is L3+ and the request is the owner's own (`cli`, `console`,
  `gateway:*`), turns `APPROVAL-REQUEST:` lines into approvals, and records
  every run in `.astack/runner/` and the audit log. Runner children carry
  `ASTACK_UNATTENDED=1`, under which no approval can be decided.
- **Daemon** only supervises. It loads `runner-engine`, `scheduler-engine`,
  `signal-engine`, `gateway-engine`, `search-engine`, `skill-hub`, `console`
  and `board-engine` through their `service.mjs` (each optional) and restarts
  a crashed one with backoff.
- **Gateway, console and CLI** are owner surfaces: they pass requests to the
  runner and decisions to `runtime.approvals` / `runtime.missions` as
  `owner@<channel>` or `owner@console`. Without a runner the gateway answers
  with the chief of staff's plan and says that nothing ran.
- **A2A and signals** are outsiders: capped at the owner's default level,
  always read-only tools, no pack skills, no past sessions; A2A is plan-only
  unless `a2a.execute: true`.
- **Search** and the **skill hub** feed context: search adds "also found in
  past sessions" to `memory search` and `context search` and answers
  `astack search` and the console's memory screen; pack skills rank below
  built-in skills and reach a work order labelled third-party.
- **Board** fans cards out to the runner; **sandbox** isolates shell commands
  the automation policy routes to it; **vault** backends and the redaction
  guard keep secrets out of every new output.

State stays file-backed under `.astack/<engine>/` (ignored by git as a whole),
and every new engine is feature-detected, so a core without one keeps working.

## Design Rules
1. One composition point (`createRuntime`) — engines never construct each other.
2. Capability enters through manifests, never through Orchestrator special cases.
3. Owner data and core code are strictly separated so upgrades stay safe.
4. Persian for the owner, English for assets — enforced by the language policy and locale files.
