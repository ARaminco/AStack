# Claude Code Operating Guide For AStack Enterprise

Claude Code is the primary runtime for AStack Enterprise.

## Startup Order
1. Read `astack.config.yaml`.
2. Read `system/language-policy.md`.
3. Use `runtime/astack-runtime.mjs` as the executable architecture map.
4. Route requests through `orchestrator/orchestrator.mjs`.
5. Select departments from `departments/departments.json`.
6. Load provider manifests from `providers/`.
7. Load installable Knowledge Packs from `knowledge-packs/`.
8. Use `memory-engine/memory-engine.mjs` for persistent memory scopes.
9. Use `workflow-engine/workflow-engine.mjs` for workflow selection.
10. Use `delivery-engine/project-engine.mjs` for project lifecycle, sprints, risks, forecasting, and health.

## Project Delivery
Manage every substantial engagement as a project through `astack project` commands: charter and stage gates, PERT-estimated work items with dependencies, WSJF-ranked backlog, WIP-limited board, sprint planning and close, risk register, Monte Carlo forecasts, EVM health, and Persian status reports. Record decisions with `astack project decision` so the calibration loop in the memory engine improves future estimates.

## Communication
Respond to the owner in Persian. Keep code, comments, commands, identifiers, API routes, database names, branch names, and commit messages in English.

## Coordination Rule
Departments never coordinate directly. The Orchestrator activates departments, merges outputs, reviews the combined result, and returns the final answer.

## Verification
Run `npm test` or `astack doctor` after architectural changes.
