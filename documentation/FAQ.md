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
Everything is local: project, team, and agent state under `.astack/`, durable memory under `memory/`. Telemetry is disabled by default. The listeners added in 3.0 — the Aramin console, the gateway's webhook listener and the A2A endpoint — run only when you start them and bind `127.0.0.1` unless you set `allow_remote` deliberately.

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

Since 3.0 you can also talk to AStack directly: the [gateway](Gateway.md) turns
your Telegram or WhatsApp messages into runner requests, sends you reports, and
asks you to approve irreversible steps by message.

# How much context does a request cost?

The budgets are configurable and enforced: about 800 tokens for the owner
capsule, 2000 for the workspace map, 2500 for memory, 500 for the tool catalog.
`astack context stats` reports the tokens rendered and avoided from real usage.

## Does AStack work when no Claude Code or Codex session is open? (3.0)

Yes, once you turn it on. `astack run` executes an objective through Claude
Code headless, `codex exec` or a local Ollama model, and `astack daemon start`
keeps the runner queue, scheduled jobs, hooks, the gateway and the console
running in one background process. `astack daemon install-service` starts it at
logon. Runs keep to a daily and a per-run budget, and anything irreversible
still stops for your approval. See [Runner and Daemon](Runner-and-Daemon.md).

## How do I approve something from my phone?

Turn on the [gateway](Gateway.md) for Telegram or WhatsApp and add your
accounts as owners. Each approval request arrives with the exact action, the
values and a four-character code; reply «بفرست», «تایید» or "approve" to that
message (or «نه», «رد», "deny"). In a group, quote the request or include the
code. The decision produces the same receipt as `astack approval approve`.

## How do I open the Aramin console?

With the daemon running, `astack console open` opens the browser already
signed in. Without the daemon, `astack console start --open`. By hand: open
`http://127.0.0.1:7717` and paste the token from `astack console token`. Your
browser can install it as an app. See [Aramin Console](Aramin-Console.md).

## Can the console or the gateway be reached from the internet?

Not by default. The console, the gateway's webhook listener and the A2A
endpoint bind `127.0.0.1`. Reaching them from elsewhere is a deliberate choice:
an HTTPS tunnel or reverse proxy you control, plus `allow_remote` (or
`console.allowed_hosts` for a tunnel to loopback).

## Where should I keep tokens such as the Telegram bot token?

In the OS vault: `astack secret vault set credential://telegram/bot` asks for
the value at a hidden prompt and stores it with Windows DPAPI (adapters exist
for the macOS Keychain, Linux Secret Service, Bitwarden and 1Password). The
configuration only ever holds the `credential://` reference.

## What about the Hermes skills? Are they safe?

They ship as an auxiliary pack under `skill-packs/hermes/` (211 skills, MIT
licence). Every skill was scanned statically; nothing in a pack is executed by
the import. Pack skills rank below AStack's own skills, high-risk ones are
never selected automatically, and two (`godmode`, `obliteratus`) are blocked
outright. `astack skill pack list` shows the risk counts, and
`skills.packs.enabled: false` hides every pack.

## Which local tools does 3.0 use?

All optional: Ollama for free local runs and semantic search (`bge-m3`),
Python with faster-whisper for Persian voice notes, Docker for the sandbox, and
Node.js 22.5+ for the SQLite search index. Each engine says clearly when its
piece is missing; see [Installation](Installation.md).
