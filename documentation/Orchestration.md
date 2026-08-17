# Domains, Teams, Agents, and Leadership

AStack manages any kind of engagement, not only software. This document describes the orchestration stack that makes that possible.

## Domain Registry (`domains/`)
`domains/domains.json` defines ten engagement domains: software, legal, finance, accounting, tax, marketing, operations, hr, research, business. Each domain declares:

- `keywords` — Persian and English trigger words used by keyword scoring (`DomainRegistry.detect`).
- `departments` — which departments participate in the domain.
- `workflow` — the default workflow when the request has no more specific match.
- `deliverables` — the artifact types the domain usually produces.
- `blueprint` — the default team: one lead role plus member roles.

Commands:

```bash
astack domain                # list domains
astack domain detect "..."   # classify a request (fa or en)
```

## Team Engine (`team-engine/`)
Teams are assembled from domain blueprints and stored under `.astack/teams/<id>/team.json` with statuses `forming`, `active`, `paused`, `disbanded`.

```bash
astack team create "Legal Case Team" --domain legal --mission "..."
astack team list
astack team show <teamId>
astack team add <teamId> --role vat-specialist --dept tax
astack team remove <teamId> --role vat-specialist
astack team project <teamId> <projectId>
astack team status <teamId> paused
astack team disband <teamId>
```

## Agent Engine (`agent-engine/`)
Agents are persistent workers with a role, an optional team, a mission, and a set of assignments. State lives under `.astack/agents/<id>/agent.json`; statuses are `idle`, `active`, `paused`, `retired`.

Assignments carry a schedule: one-off (`--at <ISO>` or immediate) or recurring (`--every 30m|4h|1d|1w`). Due assignments are dispatched as work orders — Markdown mission packets written to `.astack/agents/<id>/outbox/` — and every dispatch and report is appended to the `agent` memory scope.

```bash
astack agent create "case researcher" --role legal-researcher --team legal-case-team --mission "..."
astack agent assign <agentId> "Summarize new filings" --every 1d --deliverable "Daily filing digest"
astack agent run-due                       # dispatch everything that is due
astack agent report <agentId> A-1 --summary "Digest ready"   # or --failed
astack agent standup
astack agent pause|resume|retire <agentId>
astack agent workload <agentId>
```

The engine is the state machine; execution is performed by the runtime provider (Claude Code) acting on each work order in the role of that agent.

## Leadership (`agent-engine/leadership.mjs`)
The leadership layer turns a goal into a managed operation:

```bash
astack lead plan "پرونده حقوقی قرارداد ملکی"      # proposal: domain, workflow, blueprint
astack lead team "پرونده حقوقی قرارداد ملکی"      # form team + create one agent per role
astack lead delegate <projectId> --team <teamId>   # assign ready work items to agents
astack lead standup                                # teams, agents, due, awaiting review
astack lead review                                 # open work orders awaiting a report
```

Delegation matches work items to agents by department, falls back to the team lead, marks `must` items as high priority, and links the team to the project.

## Operating Loop
1. Detect the domain and plan (`lead plan`).
2. Form the team (`lead team`).
3. Create the project from a domain template (`project init --template legal-case`).
4. Delegate (`lead delegate`).
5. Dispatch and execute (`agent run-due`, act on each work order, `agent report`).
6. Supervise (`lead standup`, `lead review`, `project status`).
