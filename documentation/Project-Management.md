# Project Management

The delivery engine (`delivery-engine/`) turns AStack from an advisory orchestrator into a delivery system. Every project is a JSON document under `.astack/projects/<id>/project.json` with an append-only event log, and every metric is computed from real data — never hand-entered.

## Lifecycle And Stage Gates

Phases: `initiation -> planning -> execution -> closing -> closed`. `astack project advance` evaluates the current gate and refuses passage while criteria are unmet, printing each failing criterion:

| Gate | Entry criteria for the next phase |
| --- | --- |
| initiation | charter outcome and at least one success criterion |
| planning | at least one milestone, three estimated items, one recorded risk, a target date; the baseline is committed automatically on passage |
| execution | every `must` item done or descoped, no active sprint |
| closing | a recorded retrospective |

## Work Items And Prioritization

Items are `epic`, `story`, `task`, or `bug` with points, PERT three-point estimates, dependencies, a department, and MoSCoW class. The backlog is ranked by MoSCoW first, then WSJF:

- `WSJF = (businessValue + timeCriticality + riskReduction) / jobSize`
- `RICE = (reach * impact * confidence) / effort`
- PERT: `expected = (O + 4M + P) / 6`, `stdDev = (P - O) / 6`

The kanban board enforces WIP limits mechanically: moving an item into a full column is refused and the error names the oldest item in that column to finish first. Starting an item with unfinished dependencies is refused. Definition of ready requires points before an item may enter `ready`.

## Scheduling

`scheduling.mjs` implements the critical path method: topological sort with cycle detection, forward pass (earliest start/finish), backward pass (latest start/finish), slack, and the critical path. `completionProbability` converts the path's PERT variance into an on-time probability via the normal CDF (Abramowitz-Stegun approximation).

## Sprints And Flow

`sprint plan` fills capacity (explicit, or rolling velocity of the last three closed sprints) with the highest-ranked ready items. `sprint close` records completed points, returns unfinished items to the backlog, and stores the retrospective — its notes and actions are appended to the `decision` memory scope. Flow metrics include cycle time, lead time, weekly throughput, burndown, and cumulative flow reconstructed from the event log.

## Forecasting

`forecasting.mjs` runs a seeded Monte Carlo simulation (mulberry32 PRNG, deterministic under a seed): each run resamples historical weekly throughput until the remaining points are consumed, producing P50/P85/P95 completion dates. Zero-throughput weeks stay in the sample set so the forecast is honest about idle weeks. A CUSUM detector over the same samples raises an early drift alarm when throughput degrades.

## Earned Value Management

With a committed baseline (total points and target date), `metrics.mjs` computes: PV (linear accrual to the target date), EV (points of done items), AC (actual effort where recorded, otherwise points), SPI, CPI, SV, CV, three EAC formulas (`BAC/CPI`, `AC + BAC - EV`, `AC + (BAC - EV) / (CPI * SPI)`), ETC, VAC, and TCPI.

## Health Score

`healthScore` is a weighted composite — schedule (SPI) 35%, flow (blocked ratio, WIP violations, stale items) 30%, risk exposure 20%, scope creep 15% — mapped to a RAG band (green >= 75, amber >= 50). Every deduction carries a reason code that the CLI resolves into a Persian sentence with live numbers, so "why amber" is always auditable.

## Risks

The register scores probability x impact on a 5x5 matrix (low <= 3, medium 4-8, high 9-15, critical >= 16) and suggests a response strategy per band (accept, mitigate, avoid). Open risk exposure feeds the health score.

## Next Best Actions

`nextBestActions` ranks what to do right now: unblock blocked items, mitigate critical risks, commit a missing baseline, reduce WIP, start the next critical-path item, close an expired sprint, plan the next one, address overdue milestones, and advance a satisfied gate.

## Calibration Loop

Closing a project writes `[calibration] project=<id> cpi=<x> effortRatio=<y> mape=<z>` into the `decision` memory scope. Future status calls read the mean effort ratio back and show a calibrated critical-path duration, so estimates provably improve from one project to the next.

## Templates And Demo

`delivery-engine/templates.json` ships four starting points: `software-delivery`, `ai-feature`, `startup-mvp`, `marketing-campaign` — each seeds milestones, risks, and an estimated backlog. `astack project demo` seeds a deterministic project with six weeks of history so every dashboard renders immediately.

## Command Surface

```
astack project init "<name>" [--template <id>] [--target YYYY-MM-DD]
astack project demo | list | templates
astack project charter <id> --outcome "..." --criteria "a;b"
astack project add <id> "<title>" --type story --points 5 --dept engineering --est 2,4,8 --value 8 --time 5 --risk 3
astack project move|start|done|block|unblock <id> <itemId> [--effort N] [--reason "..."]
astack project board | backlog | status | report | digest | next <id>
astack project sprint <id> plan|close
astack project risk <id> add|list|close
astack project milestone <id> "<title>" --due DATE
astack project gate | advance | baseline | critical-path | forecast | raci <id>
astack project decision <id> "<title>" --choice "..."
astack project scaffold <id> --goal "..."
```

Owner-facing output is Persian; identifiers, statuses, and stored data remain English per the language policy.
