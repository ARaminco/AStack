# Migration Guide

## From AStack 1.x To 2.x
Version 2 turns AStack from a software-engineering system into a multi-domain operating system. The upgrade is automated:

- **Current installs:** `astack upgrade --check` to preview, then `astack upgrade`.
- **Installs that predate the upgrade engine:** copy `scripts/astack-upgrade.mjs` into the project and run `node astack-upgrade.mjs`.

What arrives:
- Domain registry (10 domains) with bilingual detection, 5 new departments (33 total), 24 new professional roles (219 total).
- Team engine, agent engine with scheduled missions and work orders, and the leadership layer (`astack lead ...`).
- 7 domain workflows (27 total) and 4 domain delivery templates (8 total).
- Upgrade engine plus this migration path itself.
- Two new memory scopes (`team`, `agent`) and new config sections (`domains`, `teams`, `agents`, `upgrade`) — appended to your `astack.config.yaml` automatically without touching existing values.

What is preserved: `.astack/` state, `memory/`, plugins, knowledge packs, your config values, and anything you list under `upgrade.keep`. Every replaced file is backed up under `.astack/backups/upgrade-<stamp>/`.

After upgrading run `node bin/astack.mjs doctor` — expect 33 departments, 10 domains, 8 templates.

## From Prompt Collections To AStack
1. Treat AStack as an operating system, not a prompt library: route every task through the Orchestrator.
2. Give every engagement a domain (`astack domain detect`), a team (`astack lead team`), and a project (`astack project init`).
3. Add new capabilities through domains, departments, providers, plugins, workflows, or Knowledge Packs — not by editing the Orchestrator core.
4. Keep owner-facing communication Persian; keep generated software assets English.
5. Verify every change with `npm test` and `node bin/astack.mjs doctor`.

## Claude Code Migration
Claude Code starts from the root `CLAUDE.md`, then loads `astack.config.yaml`, the language policy, runtime, orchestrator, domains, departments, workflows, providers, memory, and the team/agent/upgrade engines. The full operating loop is described in [Claude-Code.md](Claude-Code.md).
