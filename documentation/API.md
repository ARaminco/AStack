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

### Chief of Staff
| Command | Description |
| --- | --- |
| `astack ask "<request>"` | Analyse a request: intent, entities, retrieved context, matching skills, tools, runtime, authority, proposed team and estimated token cost |
| `astack ask "<request>" --dry-run` | Explain the whole plan, its external effects, required credentials and approval checkpoints, without touching anything |
| `astack ask "<request>" --engage [--team\|--solo]` | Form the team if one is needed and open a durable mission |
| `astack ask "<request>" --context` | Print the full context package that would be handed to a runtime |
| `astack standup` | Session opener: owner capsule, missions, pending approvals, background jobs, hooks |
| `astack owner capsule\|show\|set\|prefer\|context\|summarize` | The owner model and conversation summaries |

### Context
| Command | Description |
| --- | --- |
| `astack context build [--force]` | Build or refresh the workspace index incrementally |
| `astack context map "<query>" [--budget <n>] [--print]` | Render a budgeted workspace map |
| `astack context search "<query>" [--limit <n>]` | Targeted retrieval with scores and members |
| `astack context expand <path>` | Full structure of one file with line anchors |
| `astack context related "<entity or symbol>"` | Graph neighbourhood plus related files |
| `astack context stats\|verify\|refresh` | Savings measured from real usage, freshness, rebuild |
| `astack context pin <path>` / `unpin <path>` | Keep a path in every map |

### Memory and graph
| Command | Description |
| --- | --- |
| `astack memory search "<query>" [--facet <f>] [--asOf <date>] [--limit <n>]` | Ranked recall, optionally as of a past moment |
| `astack memory remember "<title>" --facet <f> [--body "..."]` | Write a structured record |
| `astack memory supersede <id> "<title>" [--object <value>]` | Replace a fact and keep its history |
| `astack memory entity "<name>"` | Resolve an entity and show its relationships |
| `astack memory context "<query>"` | The rendered context package for a query |
| `astack memory consolidate\|stats\|backup\|forget <id>` | Maintenance |
| `astack graph add "<name>" --type <Type>` | Create or enrich an entity |
| `astack graph relate --from <id> --type <edge> --to <id> [--exclusive]` | Relate two entities |
| `astack graph resolve "<text>"\|neighbours <id> [--asOf <date>]\|history <id>\|stats\|compact` | Query the graph |

### Learning and skills
| Command | Description |
| --- | --- |
| `astack learn record "<task>" --domain <d> [--tools a,b] [--steps "one;two"] [--failed]` | Record an episode; a qualifying pattern forges a skill automatically |
| `astack learn status\|episodes\|candidates [--ready]\|brief "<task>"` | The learning loop |
| `astack learn forge [<candidate-id>]` | Forge or refine skills from repeated work |
| `astack learn feedback <skill-id> --outcome done\|failed [--note "..."]` | Report a use; promotion and retirement follow the numbers |
| `astack skill list\|catalog\|search\|show <id>\|test <id>\|stats` | The catalog, with progressive disclosure |
| `astack skill history <id>\|promote <id> --status <s>\|rollback <id> <version>` | Lifecycle and versions |

### Missions
| Command | Description |
| --- | --- |
| `astack mission create "<title>" [--domain <d>] [--steps '<json>']` | Open a durable mission |
| `astack mission step <id> "<title>" --tool <t> --action <a> [--params '<json>']` | Append a step |
| `astack mission run <id> [--dry-run]` | Execute; it parks itself at any step above the autonomous ceiling |
| `astack mission resume <id>\|pause <id>\|cancel <id>\|replay <id>` | Lifecycle; resume continues from the same step |
| `astack mission list\|show <id>\|status\|report <id> --summary "..."` | Inspection and reporting |

### Background work
| Command | Description |
| --- | --- |
| `astack schedule add "<name>" --kind <kind> --every <30m>\|--cron "<expr>"\|--at <ISO> [payload flags]` | Create a job |
| `astack schedule list\|show <id>\|kinds\|status\|history <id>\|incidents` | Inspection |
| `astack schedule run <id>\|tick\|watch [--interval 60s]\|stop` | Execute now, run everything due, or supervise |
| `astack schedule enable\|disable\|remove <id>\|defaults` | Lifecycle and the maintenance baseline |
| `astack schedule policy [allow-command <cmd>\|allow-host <host>]` | The automation policy |

### Inbound signals
| Command | Description |
| --- | --- |
| `astack signal create "<name>" --source <src> [--mapping '<json>'] [--noSignature]` | Create a hook; the endpoint and signing secret are printed once |
| `astack signal rule <hook> [--contains "a,b"] [--regex <re>] --then '<json>'` | Add a reaction rule |
| `astack signal serve [--port 8787]` | Run the receiver |
| `astack signal emit <hook> --payload '<json>'\|process\|inbox\|status\|endpoint <hook>\|remove <hook>` | Feed and inspect the queue |

### Browser
| Command | Description |
| --- | --- |
| `astack browser status\|profile create <id>\|profile remove <id>\|health <profile>` | Driver and profiles |
| `astack browser login <profile> --url <url> [--waitFor <selector>]` | Attended login into a persistent profile |
| `astack browser run --profile <id> --url <url> --steps '<json>' [--dry-run] [--headed]` | Run a flow; it stops before anything that commits |
| `astack browser resume <mission> [--reject]` | Continue after the owner decides |
| `astack browser evidence [<bundle>]\|evidence verify <bundle>` | The chained evidence ledger |

### Trust
| Command | Description |
| --- | --- |
| `astack authority show\|default <L0-L5>\|set <domains\|tools\|sites> <key> <level>\|check "<action>" --level <L>` | Authority ceilings and decisions |
| `astack approval pending\|list\|show <id>\|approve <id>\|reject <id>\|request --action <a>` | Human in the loop, with single use receipts |
| `astack audit list [--mission <id>]\|show <id>\|stats` | The audit trail |
| `astack secret register credential://<provider>/<name>\|list\|describe\|check\|remove` | Credential references, never values |
| `astack tool list\|catalog\|search "<capability>"\|inspect <id>\|stats` | The tool registry |
| `astack runtime list\|status\|test <id>\|route "<task>"\|performance` | Runtimes and model routing |

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

runtime.chief.brief("<request>");                       // -> intent, context, skills, tools, team, authority
runtime.chief.dryRun("<request>");                      // -> the same plus external effects and checkpoints
runtime.chief.engage("<request>", { formTeam: true });  // -> { brief, team, mission }
runtime.context.map({ query, budget });                 // -> budgeted workspace map
runtime.context.query("<terms>");                       // -> ranked hits with members
runtime.memory.recall({ query, facets, asOf });         // -> ranked records
runtime.memory.facets.supersede(id, next);              // -> { previous, replacement }
runtime.graph.relate({ from, type, to, exclusive });    // -> edge, superseding the previous one
runtime.learning.record({ task, domain, steps });       // -> { episode, forged }
runtime.skills.catalog({ budget });                     // -> token bounded skill catalog
runtime.tools.invoke(tool, action, params, options);    // -> gated, audited tool call
await runtime.missions.run(id);                         // -> runs, or parks for approval
await runtime.scheduler.tick();                         // -> every due job
await runtime.signals.processQueue();                   // -> inbound events and their reactions
await runtime.browser.run({ profile, url, steps });     // -> flow result, evidence, checkpoint
runtime.authority.evaluate({ action, level, site });    // -> allowed | requiresApproval | blocked
runtime.approvals.request({ action, parameters });      // -> pending approval
runtime.audit.record({ actor, action, target });        // -> audit entry
runtime.secrets.resolve("credential://p/n", options);   // -> the value, audited, never stored
```

`createRuntime({ clock, workspaceRoot })` returns: `root`, `workspaceRoot`, `configuration`, `budgets`, `eventBus`, `providerRegistry`, `pluginRegistry`, `knowledgePackRegistry`, `memory`, `graph`, `workflows`, `projects`, `domains`, `teams`, `agents`, `leadership`, `context`, `learning`, `skills`, `automationPolicy`, `authority`, `audit`, `approvals`, `secrets`, `browser`, `tools`, `runtimes`, `modelRouter`, `missions`, `scheduler`, `signals`, `chief`, `departments`, `providers`, `orchestrator`.

Both options are for tests and embedding: `clock` makes every engine deterministic, and `workspaceRoot` separates the owner's data directory from the installed core.

## Storage Layout

| Path | Contents |
| --- | --- |
| `.astack/projects/<id>/project.json` | Delivery project state (work items, sprints, risks, events) |
| `.astack/teams/<id>/team.json` | Team roster and lifecycle events |
| `.astack/agents/<id>/agent.json` | Agent state, assignments, runs |
| `.astack/agents/<id>/outbox/*.md` | Dispatched work orders |
| `.astack/backups/` | Memory and upgrade backups (with `upgrade-report.json`) |
| `.astack/cache/upstream/` | Cloned upgrade source |
| `.astack/memory/<facet>.jsonl` | Structured temporal memory |
| `.astack/graph/{nodes,edges}.jsonl` | Knowledge graph |
| `.astack/context/` | Workspace index, last map, usage statistics, pins |
| `.astack/learning/episodes.jsonl` | Recorded experience |
| `.astack/missions/<id>.json` | Durable missions |
| `.astack/scheduler/` | Jobs, run logs, incidents, daemon pid |
| `.astack/signals/` | Hooks and the inbound queue |
| `.astack/browser/` | Profiles, sessions, approval checkpoints |
| `.astack/evidence/<bundle>/` | Chained evidence with `ledger.jsonl` |
| `.astack/audit/audit-<month>.jsonl` | Audit trail |
| `.astack/approvals/requests.jsonl` | Approval requests and receipts |
| `.astack/security/` | Authority policy, automation policy, credential registry |
| `.astack/owner/profile.json` | Owner model |
| `.astack/runtimes/` | Runtime sessions, work orders, routing history |
| `.astack/upgrade-state.json` | Applied data migrations |
| `skills/learned/<id>/` | Forged skills with their versions (preserved across upgrades) |
| `memory/*.md` | Persistent memory scopes |

All `.astack/` state is workspace-local and excluded from version control.

## Events

The in-process event bus emits: `orchestrator.started`, `orchestrator.completed`, `delivery.*` (one per project mutation), `team.created`, `team.status`, `agent.created`, `agent.assigned`, `agent.dispatched`, `agent.reported`.

The autonomy layer adds: `graph.node.upserted`, `graph.edge.created`, `experience.recorded`, `skill.forged`, `skill.status`, `skill.feedback`, `authority.evaluated`, `approval.requested`, `approval.granted`, `approval.rejected`, `approval.consumed`, `audit.recorded`, `secret.registered`, `secret.resolved`, `mission.created`, `mission.waiting`, `mission.resumed`, `mission.completed`, `mission.failed`, `scheduler.job.created`, `scheduler.job.enabled`, `scheduler.job.disabled`, `scheduler.job.removed`, `scheduler.run.started`, `scheduler.run.finished`, `scheduler.incident.opened`, `scheduler.incident.closed`, `signal.hook.created`, `signal.received`, `signal.processed`, `browser.profile.created`, `browser.login`, `browser.approval.required`, `browser.injection.detected`, `runtime.session.started`, `runtime.session.reported`, `runtime.workorder.written`, `runtime.handoff`, `chief.engaged`.

Subscribe with `runtime.eventBus.on(name, handler)`. Full command details live in [CLI.md](CLI.md).
