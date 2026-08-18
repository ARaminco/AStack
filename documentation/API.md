# API Reference

AStack exposes two surfaces: a local CLI (`astack` / `node bin/astack.mjs`) and a programmatic runtime (`createRuntime()`). There is no network API; every operation is local and file-backed.

## CLI Contract

```bash
node bin/astack.mjs <command> [subcommand] [args] [--flags]
```

Output is localized (Persian by default, `ASTACK_LOCALE` overrides). Identifiers, paths, and stored data are always English. Exit code is `1` on any error.

### System
| Command | Description |
| --- | --- |
| `astack doctor` | Validate layers, config sections, and print counts (departments, roles, domains, providers, packs, templates, projects, teams, agents) |
| `astack init` / `astack install` | Run the doctor and confirm readiness |
| `astack upgrade [--check] [--from <path\|url>] [--force] [--keep a,b]` | Upgrade the embedded core (alias: `update`) — see [Upgrade.md](Upgrade.md) |
| `astack review "<request>"` | Orchestrator analysis: domain, workflow, departments, leadership and project briefings |
| `astack workflow` \| `provider` \| `plugin` \| `memory` \| `knowledge` | List workflows, providers, plugins, memory scopes, knowledge packs |
| `astack backup` | Write a memory backup under `.astack/backups/` |

### Domains
| Command | Description |
| --- | --- |
| `astack domain` | List the ten engagement domains with their departments |
| `astack domain detect "<text>"` | Classify a request (Persian or English) into a domain |

### Teams
| Command | Description |
| --- | --- |
| `astack team create "<name>" --domain <id> [--mission "..."]` | Assemble a team from the domain blueprint |
| `astack team list` / `astack team show <id>` | List teams / show a roster |
| `astack team add <id> --role <role> [--dept <id>] [--lead]` | Add a member |
| `astack team remove <id> --role <role>` | Remove a member |
| `astack team project <id> <projectId>` | Link the team to a delivery project |
| `astack team status <id> <forming\|active\|paused\|disbanded>` | Change status |
| `astack team disband <id>` | Disband the team |

### Agents
| Command | Description |
| --- | --- |
| `astack agent create "<name>" --role <role> [--dept <id>] [--team <id>] [--mission "..."]` | Create an agent |
| `astack agent list` / `astack agent show <id>` | List agents / show assignments |
| `astack agent brief <id> <mission...>` | Update the standing mission |
| `astack agent assign <id> "<objective>" [--every 30m\|4h\|1d\|1w] [--at <ISO>] [--deliverable "..."] [--priority high]` | Schedule a one-off or recurring mission |
| `astack agent run-due` | Dispatch all due missions as work orders into `.astack/agents/<id>/outbox/` |
| `astack agent report <id> <assignmentId> [--summary "..."] [--failed]` | Close the open run; recurring missions reschedule automatically |
| `astack agent pause\|resume\|retire <id>` | Change agent status |
| `astack agent standup` | Status of every agent: open, overdue, next due, last report |
| `astack agent workload <id>` | Assignment counts by status |

### Leadership
| Command | Description |
| --- | --- |
| `astack lead plan "<goal>"` | Detect the domain and propose workflow plus team blueprint |
| `astack lead team "<goal>" [--name <name>]` | Form the team and create one agent per blueprint role |
| `astack lead delegate <projectId> --team <teamId> [--every <interval>]` | Assign ready work items to agents (round-robin per department, lead as fallback) |
| `astack lead standup` | Teams, agents, due missions, and items awaiting review |
| `astack lead review` | Open work orders awaiting a report |

### Projects
The full delivery lifecycle lives under `astack project ...` (init, templates, charter, milestone, add, move, sprint, risk, gate, advance, baseline, forecast, critical-path, status, report, board, backlog, next, digest, decision, scaffold, raci, demo). See [Project-Management.md](Project-Management.md) for the complete reference.

## Programmatic Runtime

```js
import { createRuntime } from "./runtime/astack-runtime.mjs";

const runtime = createRuntime();
runtime.domains.detect("tax filing for VAT");          // -> domain object or null
runtime.leadership.formTeam("goal", { name: "t1" });    // -> { team, agents }
runtime.agents.assign("agent-id", { objective: "...", every: "1d" });
runtime.agents.runDue();                                // -> dispatched work orders
runtime.projects.status("project-id");                  // -> health, EVM, forecast, actions
runtime.orchestrator.run("request");                    // -> intent, domain, departments, answer
```

`createRuntime()` returns: `root`, `configuration`, `eventBus`, `providerRegistry`, `pluginRegistry`, `knowledgePackRegistry`, `memory`, `workflows`, `projects`, `domains`, `teams`, `agents`, `leadership`, `departments`, `providers`, `orchestrator`.

## Storage Layout

| Path | Contents |
| --- | --- |
| `.astack/projects/<id>/project.json` | Delivery project state (work items, sprints, risks, events) |
| `.astack/teams/<id>/team.json` | Team roster and lifecycle events |
| `.astack/agents/<id>/agent.json` | Agent state, assignments, runs |
| `.astack/agents/<id>/outbox/*.md` | Dispatched work orders |
| `.astack/backups/` | Memory and upgrade backups (with `upgrade-report.json`) |
| `.astack/cache/upstream/` | Cloned upgrade source |
| `memory/*.md` | Persistent memory scopes |

All `.astack/` state is workspace-local and excluded from version control.

## Events

The in-process event bus emits: `orchestrator.started`, `orchestrator.completed`, `delivery.*` (one per project mutation), `team.created`, `team.status`, `agent.created`, `agent.assigned`, `agent.dispatched`, `agent.reported`. Subscribe with `runtime.eventBus.on(name, handler)`.
