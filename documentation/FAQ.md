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

# Does AStack remember me between conversations?

Yes. A new session starts from the owner identity capsule plus what the request
needs, not from a replayed history. Facts live in the memory facets and the
knowledge graph, and change through supersede so history stays answerable.

# Can it really use a browser?

Yes, through a persistent Chromium profile driven over the DevTools protocol.
You log in once with `astack browser login`, and later automated runs reuse that
session. Any step that commits — submit, pay, delete — stops and waits for your
approval, then resumes from the same point. Run `npm run test:browser` to see it
work end to end.

# Will it do something irreversible on its own?

Not by default. The authority ceiling is L2 (drafts). L4 actions always require
an approval receipt, which authorizes exactly one action, and every external
action lands in the audit trail with its evidence.

# How does it learn?

Every substantial task is recorded as an episode. When the same job appears at
least three times, on at least two different days, with a good success rate, the
learning engine forges a skill package with its evidence and guardrails. Use it,
report the outcome, and it is promoted or retired on the numbers.

# Can I trigger it from WhatsApp or another tool?

Yes. `astack signal create` gives you a webhook URL and a signing secret to
register in any tool. Incoming messages are verified, classified by domain and
matched against your rules, which can open a mission, assign an agent, run a job
or write to memory.

# How much context does a request cost?

The budgets are configurable and enforced: about 800 tokens for the owner
capsule, 2000 for the workspace map, 2500 for memory, 500 for the tool catalog.
`astack context stats` reports the tokens rendered and avoided from real usage.
