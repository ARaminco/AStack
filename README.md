# AStack Enterprise

**Languages:** English · [فارسی](README.fa.md) · [العربية](README.ar.md) · [Türkçe](README.tr.md) — **Docs:** [Documentation Index](documentation/README.md)

AStack Enterprise is a modular AI operating system that runs natively in both Claude Code and OpenAI Codex — one shared contract, one memory, one journal — while remaining open to ChatGPT and future agent runtimes. It manages any kind of engagement — software delivery, legal cases, finance, tax, accounting, marketing, operations, HR, research, and business strategy — by forming domain teams, creating agents, and delegating scheduled missions under a leadership layer. Since 3.0 it is also **always on and in your pocket**: an unattended runner and one background daemon keep missions, jobs and hooks moving while nobody is at the keyboard; you command it and approve its irreversible steps from Telegram or WhatsApp; and **Aramin**, a local installable console, shows every approval, mission, run and audit record. Every new capability sits inside the same trust model: authority ceilings, approval receipts and the audit trail.

## Features

**Runtimes and interop**
- Claude Code and Codex in parity on one contract, one memory and one journal ([docs](documentation/Codex-and-Claude-Code.md))
- Graphify code graph under AStack token budgets ([docs](documentation/Graphify.md))
- A2A endpoint: other agents can ask AStack for a plan, loopback and bearer-authenticated, plan-only by default ([docs](documentation/Board-Sandbox-Vault.md#a2a-endpoint-interop-enginea2a-servermjs)) — *new in 3.0*

**Always on** — *new in 3.0*
- **Runner** — `astack run` executes an objective or a mission unattended through Claude Code headless, `codex exec` or a local Ollama model, with daily and per-run budgets, a concurrency limit, and the authority ceiling enforced in the tools themselves ([docs](documentation/Runner-and-Daemon.md))
- **Daemon** — one background process supervises the runner queue, the scheduler, the webhook listener, the gateway, search reindexing, the board and the console, with crash restart; installs as a Windows Task Scheduler task, a macOS LaunchAgent or a Linux systemd user service ([docs](documentation/Runner-and-Daemon.md#daemon-daemon-engine))
- **Board** — durable multi-agent kanban with dependencies, retries, an independent reviewer lane and live steering ([docs](documentation/Board-Sandbox-Vault.md#board-board-engine))

**In your pocket** — *new in 3.0*
- **Gateway** — command AStack from Telegram or WhatsApp (a wapi-compatible HTTP gateway, AStack's own linked-device bridge, or the Meta Cloud API); owner allowlists with several accounts per channel; approve with «بفرست» / "approve" or decline with «نه» / "deny"; local Persian voice notes ([docs](documentation/Gateway.md))
- **Aramin console** — a local, installable web app (PWA) for approvals, missions, memory, runs, jobs, audit, skills, board and system state; loopback only, token login, Persian by default ([docs](documentation/Aramin-Console.md))

**Memory and recall**
- **Memory OS** — twelve temporal facets, supersede instead of overwrite, nightly consolidation ([docs](documentation/Memory-OS.md))
- **Search** — one Persian-aware index over memory, past Claude Code and Codex sessions, reports, skills and missions: SQLite FTS5 plus optional Ollama embeddings, and a deterministic owner profile ([docs](documentation/Search.md)) — *new in 3.0*
- **Context engine** — repo map, symbol index and domain record graph inside a token budget ([docs](documentation/Context-Engine.md))
- **Knowledge graph** — people, companies, cases, accounts and how they relate, over time ([docs](documentation/Knowledge-Graph.md))

**Skills and learning**
- **Learning engine** — repeated work becomes a versioned, evidence backed skill ([docs](documentation/Learning-Engine.md))
- **Skill hub** — import `SKILL.md` skills into auxiliary packs, scanned by a static security scanner and ranked below built-in skills; ships the Hermes Agent pack (211 MIT skills), high-risk skills are never auto-selected and two are blocked outright; a curator recommends keep, refine or retire ([docs](documentation/Skill-Hub.md)) — *new in 3.0*

**Real work, safely**
- **Missions** — durable, resumable, with approval checkpoints, dry run and replay ([docs](documentation/Autonomous-Organization.md))
- **Internal browser** — persistent logins, real form work, chained evidence, stop before submit ([docs](documentation/Browser-Operator.md))
- **Scheduler and hooks** — background monitoring and inbound webhooks that create missions or queue agent runs ([docs](documentation/Scheduler-and-Signals.md))
- **Sandbox** — Docker-isolated command execution: no network, read-only root, secrets hidden ([docs](documentation/Board-Sandbox-Vault.md#sandbox-sandbox-engine)) — *new in 3.0*

**Trust**
- Authority levels L0–L5, approval receipts, audit trail, secret broker ([docs](documentation/Security-and-Authority.md))
- OS vault backends for secrets (Windows DPAPI; macOS Keychain, Linux Secret Service, Bitwarden and 1Password adapters) and a guard that scrubs resolved secrets from every output ([docs](documentation/Board-Sandbox-Vault.md#vault-backends-trust-enginevaultmjs)) — *new in 3.0*

**Organization and delivery**
- Ten engagement domains, 33 departments, 219 roles, teams, agents and a leadership layer ([docs](documentation/Orchestration.md))
- Stage-gated project delivery with PERT, WSJF, WIP limits, Monte Carlo forecasts and EVM ([docs](documentation/Project-Management.md))
- Safe core upgrades with backups, three-way merge of owner customizations and automatic rollback ([docs](documentation/Upgrade.md))

## Runtime
- Runtimes: Claude Code and Codex in parity ([how they share one brain](documentation/Codex-and-Claude-Code.md), [Claude Code loop](documentation/Claude-Code.md)); unattended runs through the [runner](documentation/Runner-and-Daemon.md)
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
To update any project, say "update AStack" (or «آپدیت کن») to Claude Code or Codex, or run the [update pipeline](documentation/Upgrade.md) directly: `node ~/.astack/core/bin/astack.mjs update --target /path/to/project`.

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

### Turn on the always-on assistant (3.0)
Every 3.0 engine is off or read-only until you turn it on. Four steps:

```bash
# 1. Runner: allow Claude Code to be started unattended (once), then preview a run
node bin/astack.mjs schedule policy allow-command claude
node bin/astack.mjs runner engines
node bin/astack.mjs run "summarize today's open missions" --dry-run

# 2. Daemon: one background process for runner, scheduler, hooks, gateway, search, board and console
node bin/astack.mjs daemon start
node bin/astack.mjs daemon status
node bin/astack.mjs daemon install-service --dry-run   # review the plan, then run it without --dry-run to start at logon

# 3. Aramin console: opens the browser already signed in while the daemon runs
node bin/astack.mjs console open                        # without the daemon: astack console start --open

# 4. Telegram gateway: create a bot with @BotFather first
node bin/astack.mjs secret vault set credential://telegram/bot           # paste the bot token at the hidden prompt
node bin/astack.mjs gateway owner add telegram <your numeric Telegram user id>
```

Then switch the gateway on in `astack.config.yaml` and restart the daemon:

```yaml
gateway:
  enabled: true
  channels:
    telegram:
      enabled: true
```

```bash
node bin/astack.mjs gateway test telegram     # read-only health call
node bin/astack.mjs daemon stop && node bin/astack.mjs daemon start
```

Send the bot a message: it becomes a runner request. Approval prompts arrive with the exact values and a four-character code; reply «بفرست» or "approve" to the prompt (or «نه» / "deny"). WhatsApp channels, voice notes and every rule are in the [Gateway guide](documentation/Gateway.md).

## Upgrading to 3.0
3.0 is purely additive: every 2.5.1 command, file format and test keeps working unchanged, and every new engine is off or read-only until configured. Update as always:

```bash
node bin/astack.mjs update            # or tell Claude Code / Codex «آپدیت کن»
```

The update brings the new engines and the `skill-packs/` folder, keeps `astack.config.yaml` untouched (the 3.0 sections ship as commented defaults), and runs migration `2026.8-ignore-v3-state`, which adds the 3.0 state folders under `.astack/` to an existing `.gitignore`. Then follow [Turn on the always-on assistant](#turn-on-the-always-on-assistant-30). Details: [Core Upgrades](documentation/Upgrade.md) and the [CHANGELOG](CHANGELOG.md).

## The Autonomous Organization
AStack remembers its owner across conversations, forms the smallest expert team a request needs, operates websites and software through real tools, stops before anything irreversible, verifies the result, audits it and learns from it.

```bash
node bin/astack.mjs standup                                   # capsule, missions, approvals, jobs
node bin/astack.mjs ask "وضعیت پرونده آکمه چیست؟"                # plan a request
node bin/astack.mjs ask "اظهارنامه را ثبت کن" --dry-run          # explain, touch nothing
node bin/astack.mjs context map "invoice reconciliation"       # budgeted workspace map
node bin/astack.mjs memory search "حسابدار شرکت آکمه"            # temporal recall
node bin/astack.mjs search "قرارداد اجاره تمدید"                  # recall across memory, past sessions and reports
node bin/astack.mjs schedule add "portal" --kind http-check --every 10m --url https://example.com
node bin/astack.mjs signal create "whatsapp inbox" --source whatsapp
node bin/astack.mjs browser login owner --url https://portal.example.gov
node bin/astack.mjs approval pending
```

Read it end to end in [Autonomous Organization](documentation/Autonomous-Organization.md), and see what is implemented versus adapter-ready in its feature status table. The building blocks are listed under [Features](#features).

## Engagement Domains
The domain registry routes every request — in Persian or English — to the right departments, workflow, and team blueprint: software, legal, finance, accounting, tax, marketing, operations, hr, research, business. See [Departments](documentation/Departments.md) and [Roles](documentation/Roles.md) (33 departments, 219 roles).

## Teams, Agents, and Leadership
- `astack team` — assemble and manage cross-functional teams from domain blueprints.
- `astack agent` — create agents, schedule recurring or one-off missions, dispatch work orders, and record reports.
- `astack lead` — the leadership layer: plan an engagement, form the team, delegate project work, run standups, and review deliverables.
- `astack board` — run cards for agents and teams unattended, with retries and a reviewer lane (3.0).

Full guide: [Domains, Teams, Agents, and Leadership](documentation/Orchestration.md).

## Project Delivery
The delivery engine manages projects like a top-tier delivery team: stage-gated lifecycle, PERT estimates, WSJF-ranked backlog, WIP-limited kanban, sprint planning from rolling velocity, a scored risk register, Monte Carlo completion forecasts, earned value management, an explainable health score, and next-best-action recommendations. Domain templates cover software, AI features, startup MVPs, marketing campaigns, legal cases, tax filings, accounting closes, and financial audits. See [Project Management](documentation/Project-Management.md).

## Core Upgrades
Projects that embed AStack update themselves with `astack upgrade` (alias: `astack update`). Older installs that predate the upgrade engine drop the single-file `scripts/astack-upgrade.mjs` into the project and run it once — it fetches the latest core and applies the new upgrade logic while preserving `.astack/`, `memory/`, plugins, knowledge packs, and any path listed under `upgrade.keep`. See [Core Upgrades](documentation/Upgrade.md) and the [Migration Guide](documentation/Migration-Guide.md).

## Documentation
The complete set lives in [`documentation/`](documentation/README.md) — concepts, operations, extension guides, security, and the full Persian owner guide ([fa-guide.html](documentation/fa-guide.html)). New in 3.0: [Runner and Daemon](documentation/Runner-and-Daemon.md), [Gateway](documentation/Gateway.md), [Aramin Console](documentation/Aramin-Console.md), [Search](documentation/Search.md), [Skill Hub](documentation/Skill-Hub.md), [Board, Sandbox, Vault and A2A](documentation/Board-Sandbox-Vault.md).
