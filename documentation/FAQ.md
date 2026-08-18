# FAQ

## Is AStack only for software companies?
No. Version 2 manages any practice: legal cases, tax filings, accounting closes, financial audits, marketing campaigns, operations, hiring, research, and business strategy — each with its own departments, workflows, delivery templates, and team blueprints. Software delivery is one domain among ten.

## Is AStack only for Claude Code?
No. Claude Code is the primary runtime, but the architecture is provider-agnostic: eight provider manifests ship out of the box and any agent runtime that can read Markdown and run Node can operate the system.

## How do agents actually execute work?
The engines are deterministic state machines. `astack agent run-due` writes a work order (a Markdown mission packet) into the agent's outbox; the runtime — normally Claude Code — performs the work in the role of that agent and records the result with `astack agent report`. Recurring missions reschedule themselves after each report.

## Can I schedule recurring work?
Yes: `astack agent assign <id> "objective" --every 30m|1h|4h|1d|1w`, or a one-off with `--at <ISO date>`. `astack agent standup` shows what is due and overdue; `astack lead review` shows dispatched work awaiting a report.

## How do old projects get new AStack features?
Run `astack upgrade` in the project. If the embedded core predates the upgrade engine, copy the single file `scripts/astack-upgrade.mjs` into the project and run it once — it fetches the latest core and applies the newest upgrade logic. Owner data (`.astack/`, `memory/`, plugins, knowledge packs, `astack.config.yaml` values) is never touched. See [Upgrade.md](Upgrade.md).

## Will an upgrade overwrite my customizations?
Managed engine files are replaced (with a full backup under `.astack/backups/`). Owner-editable files are seed-only. Anything else you customize can be protected with `upgrade.keep` in `astack.config.yaml`.

## Which languages are supported?
Owner-facing output: Persian by default, with English, Arabic, and Turkish locales (`ASTACK_LOCALE` or `cli.default_locale`). Missing keys fall back to English. Domain and workflow detection understands Persian and English request text. Code and stored data are always English.

## Where is my data?
Everything is local: project, team, and agent state under `.astack/`, durable memory under `memory/`. Telemetry is disabled by default and there is no network API.
