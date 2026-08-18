# AStack Enterprise

**Languages:** English · [فارسی](README.fa.md) · [العربية](README.ar.md) · [Türkçe](README.tr.md) — **Docs:** [Documentation Index](documentation/README.md)

AStack Enterprise is a modular AI Operating System designed to run primarily inside Claude Code while remaining compatible with OpenAI Codex, ChatGPT, and future agent runtimes. It manages any kind of engagement — software delivery, legal cases, finance, tax, accounting, marketing, operations, HR, research, and business strategy — by forming domain teams, creating agents, and delegating scheduled missions under a leadership layer.

## Runtime
- Primary runtime: Claude Code ([how it operates AStack](documentation/Claude-Code.md))
- User communication: Persian — software assets and documentation: English
- Architecture: layered, plugin-ready, provider-agnostic, domain-aware ([details](documentation/Architecture.md))

## Quick Start
```bash
npm test
node bin/astack.mjs doctor
node bin/astack.mjs domain detect "اظهارنامه مالیات ارزش افزوده"
node bin/astack.mjs lead plan "پرونده حقوقی قرارداد ملکی"
node bin/astack.mjs lead team "پرونده حقوقی قرارداد ملکی" --name legal-case-team
node bin/astack.mjs project init "Contract Dispute" --template legal-case
node bin/astack.mjs lead delegate contract-dispute --team legal-case-team
node bin/astack.mjs agent run-due
node bin/astack.mjs lead standup
```
More in [Installation](documentation/Installation.md) and the [API Reference](documentation/API.md).

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
