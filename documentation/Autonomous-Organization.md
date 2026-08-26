# Autonomous Organization

AStack is an AI operating system for any practice. This document describes the
layer that turns it into a persistent organization: it remembers its owner,
forms the smallest expert team a request needs, executes through real tools,
stops for approval before anything irreversible, verifies the result, audits it
and learns from it.

## The lifecycle

Every request follows the same chain. Each step is a real engine, not a prompt.

```
Owner request
  -> Owner identity capsule            chief-of-staff/owner-model.mjs
  -> Intent analysis                   chief-of-staff/intent-engine.mjs
  -> Entity resolution                 knowledge-graph/graph-engine.mjs
  -> Memory retrieval                  memory-engine/facets.mjs
  -> Context package (token budgeted)  context-engine/context-router.mjs
  -> Skill retrieval                   learning-engine/skill-catalog.mjs
  -> Tool discovery                    tool-registry/tool-registry.mjs
  -> Runtime and model routing         runtime-providers/model-router.mjs
  -> Just in time team                 chief-of-staff/team-planner.mjs
  -> Durable mission                   mission-engine/mission-engine.mjs
  -> Authority check                   trust-engine/authority.mjs
  -> External action                   browser-engine, tool-registry
  -> Approval checkpoint               trust-engine/approvals.mjs
  -> Verification and evidence         browser-engine/evidence.mjs
  -> Audit record                      trust-engine/audit.mjs
  -> Memory and project update         memory-engine, delivery-engine
  -> Experience analysis               learning-engine/experience-engine.mjs
  -> Skill candidate or improvement    learning-engine/skill-forge.mjs
```

## Architecture

```
                                   Owner
                                     |
                          +----------v-----------+
                          |   Chief of Staff     |
                          |  intent | routing    |
                          |  risk   | team plan  |
                          +----------+-----------+
                                     |
        +----------------------------+----------------------------+
        |                            |                            |
+-------v-------+          +---------v---------+        +---------v---------+
| Context Router|          |  Leadership layer |        |  Mission Engine   |
| repo map      |          |  teams | agents   |        |  durable steps    |
| memory recall |          |  work orders      |        |  resume | replay  |
| graph expand  |          +---------+---------+        +---------+---------+
+-------+-------+                    |                            |
        |                            |                            |
+-------v-------+          +---------v---------+        +---------v---------+
| Memory OS     |          | Universal Agent   |        | Tool Registry     |
| 12 facets     |          | Runtime           |        | progressive       |
| temporal      |          | claude-code | cli |        | disclosure        |
+-------+-------+          | mock | future     |        +---------+---------+
        |                  +---------+---------+                  |
+-------v-------+                    |                  +---------v---------+
| Knowledge     |                    |                  | Execution         |
| Graph         |                    |                  | browser | http    |
| temporal      |                    |                  | files | shell     |
+---------------+                    |                  +---------+---------+
                                     |                            |
                          +----------v----------------------------v---------+
                          |        Trust layer: authority, approvals,        |
                          |        secret broker, audit, evidence            |
                          +--------------------------+-----------------------+
                                                     |
                          +--------------------------v-----------------------+
                          |  Experience engine -> skill forge -> reinforcement|
                          +--------------------------------------------------+
```

## Event driven autonomy

Work does not have to start in a conversation.

- **Scheduled**: `scheduler-engine` runs jobs on intervals or cron expressions.
- **Inbound**: `signal-engine` exposes a webhook that any external tool can post
  to. The message is verified, normalized, classified by domain and matched
  against owner defined rules.
- **Escalated**: a job that keeps failing opens an incident and can assign an
  agent to diagnose it.

## Feature status

| Capability | Status |
| --- | --- |
| Context engine, repo map, symbol index, retrieval | implemented |
| Memory OS with temporal facets and consolidation | implemented |
| Knowledge graph (file backed, temporal) | implemented |
| Learning engine, skill forge, reinforcement | implemented |
| Skill catalog with progressive disclosure and versions | implemented |
| Scheduler, monitors, incidents, daemon | implemented |
| Signal engine and HTTP receiver | implemented |
| Browser operator (CDP, persistent profiles, evidence) | implemented |
| Missions with approval checkpoints and replay | implemented |
| Authority, approvals, audit, secret broker | implemented |
| Tool registry and policy gated invocation | implemented |
| Claude Code runtime adapter | implemented |
| CLI runtime adapter (codex, local models, others) | experimental, needs a configured command |
| Model router with performance history | implemented |
| Email, messaging, database, SSH, document tools | adapter-ready, no live adapter shipped |
| Computer operator (desktop control) | future, interface only |
| Graph backends other than the file store | adapter-ready |

## Where the state lives

```
.astack/
  memory/       structured facets (JSONL)
  graph/        nodes and edges (JSONL)
  context/      index, map, usage statistics
  learning/     episodes
  missions/     durable missions
  scheduler/    jobs, runs, incidents
  signals/      hooks and inbox
  browser/      profiles, sessions, checkpoints
  evidence/     chained evidence bundles
  audit/        monthly audit trail
  approvals/    approval requests and receipts
  security/     authority, automation policy, credential registry
  owner/        owner profile
  runtimes/     runtime sessions and routing history
skills/learned/ forged skills, preserved across upgrades
memory/         owner facing markdown scopes
```

Nothing in `.astack/` or `memory/` is ever touched by an upgrade.
