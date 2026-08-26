# Development

## Requirements
- Node.js 20 or newer (no runtime dependencies — the core uses only Node built-ins).
- Git (required by the upgrade engine).

## Commands
| Command | Purpose |
| --- | --- |
| `npm test` | Run all five verification suites (see below) |
| `npm run doctor` | Layer, config, and count validation |
| `npm run upgrade` | Upgrade the embedded core |
| `node bin/astack.mjs <command>` | Any CLI command without a global install |

## Test Suites
1. `tests/verify-astack.mjs` — structure, config sections, exact counts (33 departments, 27 workflows, 10 domains, 11 memory scopes, 8 templates, 219+ roles), locale integrity, orchestrator domain detection, doctor and review smoke runs, and a repository-wide scan for banned markers.
2. `tests/verify-delivery.mjs` — delivery mathematics (PERT, critical path, WSJF, RICE, risk scoring, Monte Carlo, EVM, health) and the full project lifecycle against a temporary workspace.
3. `tests/verify-orchestration.mjs` — domain registry, team assembly, agent scheduling and dispatch, leadership delegation, and the upgrade engine against a synthetic legacy install.
4. `tests/verify-intelligence.mjs` — text normalization, the configuration parser, temporal memory and supersede, the knowledge graph as of a past moment, incremental indexing, budgeted maps with declared omissions, retrieval precision on a realistic corpus, record based linking across plain documents, the context package budget, the learning loop from episodes to promotion and rollback, the owner capsule, and just in time team sizing.
5. `tests/verify-autonomy.mjs` — authority ceilings and denials, approval receipts and their single use, audit redaction, credential references, tool catalog bounds and honest refusals, runtime adapters and model routing, a mission that stops for approval and resumes after a restart, replay without side effects, scheduler retries and incident recovery, webhook verification and hostile payloads, browser planning, session scoping and evidence tamper detection, the end to end owner scenarios, and the upgrade migrations.

`npm run test:browser` is a separate opt in suite: it drives a real Chromium profile end to end (fill a form, stop before submit, approve, resume, verify the evidence chain). It skips itself when no browser is installed, so it is safe to run anywhere.

Every engine takes an injectable `clock`, and `createRuntime({ clock, workspaceRoot })` separates the owner's data directory from the installed core — that is what keeps the suites deterministic and out of the working tree.

Stateful engine tests always run in `mkdtemp` sandboxes — never against the repository's own `.astack/`.

## Adding Capabilities
| To add | Touch |
| --- | --- |
| A domain | `domains/domains.json` (keywords fa+en, departments, workflow, blueprint) + count assertions |
| A department | `departments/departments.json`, roles in `roles/enterprise-roles.json` |
| A workflow | `workflow-engine/workflows.json` (id, fa+en keywords, stages) |
| A delivery template | `delivery-engine/templates.json` (milestones, risks, epics) |
| A provider | `providers/<id>/manifest.json` |
| A plugin | `plugins/<id>/plugin.json` |
| A knowledge pack | `knowledge-packs/<id>/` |
| A skill | `skills/<id>/SKILL.md` plus examples, rules, and checklist files |
| A locale string | `locales/en.json` and `locales/fa.json` (ar/tr fall back to en) |

## Conventions
- Persian for owner-facing strings, English for code, identifiers, comments, and stored data.
- Engines follow the same shape: constructor takes `root` plus optional `{ clock, memory, eventBus }`; state persists as JSON under `.astack/`; ids are latin slugs; every mutation appends an event.
- Injectable clocks keep scheduling logic deterministic in tests.
- Update `tests/verify-astack.mjs` count assertions when catalogs change, and run `npm test` before every commit.
- A new capability is not done until it is wired in `runtime/astack-runtime.mjs`, reachable from the CLI, covered by a suite, documented, and declared with an honest status (implemented, experimental, adapter-ready, mock-only or future).
