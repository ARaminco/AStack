# AStack Enterprise

**Languages:** English · [فارسی](README.fa.md) · [العربية](README.ar.md) · [Türkçe](README.tr.md) — **Docs:** [Documentation Index](documentation/README.md)

AStack Enterprise is a modular AI Operating System that runs natively in both Claude Code and OpenAI Codex — one shared contract, one memory, one journal — while remaining open to ChatGPT and future agent runtimes. It manages any kind of engagement — software delivery, legal cases, finance, tax, accounting, marketing, operations, HR, research, and business strategy — by forming domain teams, creating agents, and delegating scheduled missions under a leadership layer.

## Runtime
- Runtimes: Claude Code and Codex in parity ([how they share one brain](documentation/Codex-and-Claude-Code.md), [Claude Code loop](documentation/Claude-Code.md))
- Code graph: [Graphify](documentation/Graphify.md) under AStack token budgets for both runtimes (`node bin/astack.mjs graphify setup`)
- Shared contract: `AGENTS.md` (Codex reads it natively, `CLAUDE.md` imports it); wire both runtimes with `node bin/astack.mjs interop sync`
- User communication: Persian — software assets and documentation: English
- Architecture: layered, plugin-ready, provider-agnostic, domain-aware ([details](documentation/Architecture.md))

## Install in any project
New or old, with or without an existing AStack core — one command sets up the core, Claude Code + Codex, Graphify, the index and the global `astack-setup` skill (after that, telling either runtime "install / set up" is enough):
```bash
git clone --depth 1 https://github.com/ARaminco/AStack.git ~/.astack/core   # or: git -C ~/.astack/core pull
node ~/.astack/core/bin/astack.mjs setup --target /path/to/project
```
Inside a project that already has AStack: `node bin/astack.mjs setup --update`.

## Quick Start
```bash
npm test
node bin/astack.mjs doctor
node bin/astack.mjs interop sync && node bin/astack.mjs interop status
node bin/astack.mjs domain detect "اظهارنامه مالیات ارزش افزوده"
node bin/astack.mjs lead plan "پرونده حقوقی قرارداد ملکی"
node bin/astack.mjs lead team "پرونده حقوقی قرارداد ملکی" --name legal-case-team
node bin/astack.mjs project init "Contract Dispute" --template legal-case
node bin/astack.mjs lead delegate contract-dispute --team legal-case-team
node bin/astack.mjs agent run-due
node bin/astack.mjs lead standup
```
More in [Installation](documentation/Installation.md) and the [API Reference](documentation/API.md).

## The Autonomous Organization
AStack remembers its owner across conversations, forms the smallest expert team a request needs, operates websites and software through real tools, stops before anything irreversible, verifies the result, audits it and learns from it.

```bash
node bin/astack.mjs standup                                   # capsule, missions, approvals, jobs
node bin/astack.mjs ask "وضعیت پرونده آکمه چیست؟"                # plan a request
node bin/astack.mjs ask "اظهارنامه را ثبت کن" --dry-run          # explain, touch nothing
node bin/astack.mjs context map "invoice reconciliation"       # budgeted workspace map
node bin/astack.mjs memory search "حسابدار شرکت آکمه"            # temporal recall
node bin/astack.mjs schedule add "portal" --kind http-check --every 10m --url https://example.com
node bin/astack.mjs signal create "whatsapp inbox" --source whatsapp
node bin/astack.mjs browser login owner --url https://portal.example.gov
node bin/astack.mjs approval pending
```

Read it end to end in [Autonomous Organization](documentation/Autonomous-Organization.md), and see what is implemented versus adapter-ready in its feature status table.

### What it adds
- **Memory OS** — twelve temporal facets, supersede instead of overwrite, nightly consolidation ([docs](documentation/Memory-OS.md))
- **Context engine** — repo map, symbol index and domain record graph inside a token budget ([docs](documentation/Context-Engine.md))
- **Knowledge graph** — people, companies, cases, accounts and how they relate, over time ([docs](documentation/Knowledge-Graph.md))
- **Learning engine** — repeated work becomes a versioned, evidence backed skill ([docs](documentation/Learning-Engine.md))
- **Internal browser** — persistent logins, real form work, chained evidence, stop before submit ([docs](documentation/Browser-Operator.md))
- **Scheduler and hooks** — background monitoring and inbound webhooks that create missions ([docs](documentation/Scheduler-and-Signals.md))
- **Trust layer** — authority levels, approval receipts, audit trail, secret broker ([docs](documentation/Security-and-Authority.md))

## Engagement Domains
The domain registry routes every request — in Persian or English — to the right departments, workflow, and team blueprint: software, legal, finance, accounting, tax, marketing, operations, hr, research, business. See [Departments](documentation/Departments.md) and [Roles](documentation/Roles.md) (33 departments, 219 roles).

## Teams, Agents, and Leadership
- `astack team` — assemble and manage cross-functional teams from domain blueprints.
- `astack agent` — create agents, schedule recurring or one-off missions, dispatch work orders, and record reports.
- `astack lead` — the leadership layer: plan an engagement, form the team, delegate project work, run standups, and review deliverables.

Full guide: [Domains, Teams, Agents, and Leadership](documentation/Orchestration.md).

## Project Delivery
The delivery engine manages projects like a top-tier delivery team: stage-gated lifecycle, PERT estimates, WSJF-ranked backlog, WIP-limited kanban, sprint planning from rolling velocity, a scored risk register, Monte Carlo completion forecasts, earned value management, an explainable health score, and next-best-action recommendations. Domain templates cover software, AI features, startup MVPs, marketing campaigns, legal cases, tax filings, accounting closes, and financial audits. See [Project Management](documentation/Project-Management.md).

## Core Upgrades
Projects that embed AStack update themselves with `astack upgrade` (alias: `astack update`). Older installs that predate the upgrade engine drop the single-file `scripts/astack-upgrade.mjs` into the project and run it once — it fetches the latest core and applies the new upgrade logic while preserving `.astack/`, `memory/`, plugins, knowledge packs, and any path listed under `upgrade.keep`. See [Core Upgrades](documentation/Upgrade.md) and the [Migration Guide](documentation/Migration-Guide.md).

## Documentation
The complete set lives in [`documentation/`](documentation/README.md) — concepts, operations, extension guides, security, and the full Persian owner guide ([fa-guide.html](documentation/fa-guide.html)).
