# Claude Code Operating Guide For AStack Enterprise

Claude Code is the primary runtime for AStack Enterprise. AStack is an AI operating system for any practice: software delivery, legal cases, finance, tax, accounting, marketing, operations, HR, research, and business strategy.

## Startup Order
1. Read `astack.config.yaml`.
2. Read `system/language-policy.md`.
3. Use `runtime/astack-runtime.mjs` as the executable architecture map.
4. Route requests through `orchestrator/orchestrator.mjs`.
5. Detect the engagement domain with `domains/domain-registry.mjs` (registry: `domains/domains.json`).
6. Select departments from `departments/departments.json`.
7. Load provider manifests from `providers/`.
8. Load installable Knowledge Packs from `knowledge-packs/`.
9. Use `memory-engine/memory-engine.mjs` for persistent memory scopes.
10. Use `workflow-engine/workflow-engine.mjs` for workflow selection.
11. Use `delivery-engine/project-engine.mjs` for project lifecycle, sprints, risks, forecasting, and health.
12. Use `team-engine/team-engine.mjs` and `agent-engine/agent-engine.mjs` (with `agent-engine/leadership.mjs`) for teams, agents, and scheduled delegation.
13. Use `upgrade-engine/upgrade-engine.mjs` to keep embedded cores current.

## Engagement Domains
Every request belongs to a domain (`astack domain detect "..."`). The registry maps each domain to departments, a default workflow, expected deliverables, and a team blueprint. Persian and English keywords are both supported. Never assume an engagement is software: a lawsuit, a VAT filing, a monthly accounting close, and a hiring round are all first-class engagements.

## Leadership Protocol
Claude Code acts as the leadership layer on top of the engines:
1. `astack lead plan "<goal>"` — detect the domain and propose the team blueprint.
2. `astack lead team "<goal>"` — form the team and create one agent per role.
3. `astack project init` + `astack project scaffold` — turn the goal into a stage-gated project.
4. `astack lead delegate <projectId> --team <teamId>` — assign ready work items to agents as scheduled missions.
5. `astack agent run-due` — dispatch due missions as work orders (each work order lands in `.astack/agents/<agent>/outbox/`).
6. Execute each work order as the named agent (role-play the specialization), then record the result with `astack agent report <agent> <assignment> --summary "..."`.
7. `astack lead standup` and `astack lead review` — supervise progress and review outputs before returning anything to the owner.

## Project Delivery
Manage every substantial engagement as a project through `astack project` commands: charter and stage gates, PERT-estimated work items with dependencies, WSJF-ranked backlog, WIP-limited board, sprint planning and close, risk register, Monte Carlo forecasts, EVM health, and Persian status reports. Record decisions with `astack project decision` so the calibration loop in the memory engine improves future estimates. Domain templates exist for legal cases, tax filings, accounting closes, and financial audits (`astack project templates`).

## Core Upgrades
`astack upgrade` updates an embedded AStack core from the canonical repository (or `--from <path|url>`): managed engine files are replaced after a backup under `.astack/backups/`, seed files (`astack.config.yaml`, `CLAUDE.md`, `README.md`, `package.json`) are only created when missing, and `.astack/`, `memory/`, `plugins/`, and `knowledge-packs/` are never touched. Owner customizations can be protected with `upgrade.keep` in `astack.config.yaml`. Projects on cores that predate this engine run the standalone `scripts/astack-upgrade.mjs` (a single self-contained file) to receive the same upgrade.

## Communication
Respond to the owner in Persian. Keep code, comments, commands, identifiers, API routes, database names, branch names, and commit messages in English.

## Coordination Rule
Departments and agents never coordinate directly. The Orchestrator (with the Leadership layer) activates domains, departments, teams, and agents, merges outputs, reviews the combined result, and returns the final answer.

## Verification
Run `npm test` or `astack doctor` after architectural changes.
