# Claude Code Runtime

Claude Code is the primary runtime for AStack. The root `CLAUDE.md` is the operational contract it loads before any task; this page explains how the pieces fit together at run time.

## Startup Order
1. `astack.config.yaml` — the single active configuration.
2. `system/language-policy.md` — Persian for the owner, English for assets.
3. `runtime/astack-runtime.mjs` — the executable architecture map that composes every engine.
4. `orchestrator/orchestrator.mjs` — the only coordination point.
5. `domains/domain-registry.mjs` — engagement classification (software, legal, finance, accounting, tax, marketing, operations, hr, research, business).
6. `departments/departments.json`, `providers/`, `knowledge-packs/`.
7. `memory-engine/`, `workflow-engine/`, `delivery-engine/`, `team-engine/`, `agent-engine/` (with `leadership.mjs`), `upgrade-engine/`.

## How Claude Code Operates AStack
Claude Code is both the leader and the workforce:

1. **Classify** — `astack domain detect` (or `astack review`) maps the owner's request to a domain.
2. **Plan** — `astack lead plan` proposes the workflow and team blueprint.
3. **Form** — `astack lead team` creates the team and one agent per role.
4. **Structure** — `astack project init --template <domain-template>` turns the goal into a stage-gated project.
5. **Delegate** — `astack lead delegate` converts ready work items into scheduled agent missions.
6. **Execute** — `astack agent run-due` dispatches work orders; Claude Code opens each work order in `.astack/agents/<id>/outbox/`, performs it **in the role of that agent** (the role defines the specialization and quality bar), and records the outcome with `astack agent report`.
7. **Supervise** — `astack lead standup`, `astack lead review`, and `astack project status` before anything is returned to the owner.

The engines are deterministic state machines; Claude Code supplies the intelligence. No agent talks to another agent directly — results flow through reports, the review queue, and the Orchestrator.

## Communication Contract
- Owner-facing output: Persian.
- Code, identifiers, commits, branch names, stored data, work orders: English.
- Every substantial engagement becomes a project; every decision is recorded with `astack project decision` so estimate calibration improves over time.

## Verification
After any architectural change run `npm test` (three suites) or `astack doctor`.
