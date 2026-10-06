# Changelog

All notable changes to AStack Enterprise. Versions follow the core manifest
(`core/manifest.json`), which is what `astack upgrade` compares.

## 2.4.0 — The update pipeline

"Update AStack" is now one defined pipeline that always takes the new core from
the AStack git repository.

### Added

**`astack update`** (alias `upgrade`; `setup --update` runs it too):
preflight → fetch → plan → apply → setup → verify → record. Fetch resolves the
newest release tag from the repository (`--version` pins one, `--channel main`
follows the branch) into the canonical clone at `~/.astack/core`. Plan shows
versions, file counts, the CHANGELOG titles in between and uncommitted managed
files; `--check` stops there. Apply backs everything up; setup runs with the
new code; verify runs doctor and Claude Code/Codex parity (`--test` adds the
suites) and **rolls back automatically** on failure. Each run is recorded in
`.astack/update-history.jsonl` and in the shared journal, which both runtimes
see at their next session start. `update history` and `update rollback`
complete it; a lock prevents concurrent updates.

**Safety** — the AStack source repository itself refuses the pipeline (it would
overwrite work in progress with a release) and updates with `git pull`.

**Triggers** — the shared contract and the global `astack-setup` skill map
"update AStack", «آپدیت کن» and similar requests to the pipeline, run from the
canonical core so it works for projects on any older version.
`installer/update.sh` and `update.ps1` do the same from a shell.

### Changed

The canonical clone is refreshed with fetch + detached checkout, which works
on a branch or a release; the installers and the skill use the same commands.

## 2.3.1

The global `astack-setup` skill now states that a bare "نصب شو", "راه‌اندازی شو",
"install" or "set up" means AStack setup and must run without a clarifying
question. Verified with real runs: Codex and Claude Code each installed AStack
into a plain project from that single phrase.

## 2.3.0 — One command to install and set up

"Install and set up" is now one idempotent command for any project — empty,
existing, or running an old core — and a request in plain words to either
runtime is enough.

### Added

**`astack setup`** (also `install`/`init`, and run automatically after
`astack upgrade`): installs or upgrades the core, runs data migrations in a
new process with the new code (no separate `init` after an upgrade any more),
wires Claude Code and Codex, trusts the project in Codex, installs Graphify with
its git hooks and builds the code graph, builds the context index and installs
the global skill. A failing optional step is reported without stopping the
rest. `--target <dir>` sets up another project from this core; `--update`
refreshes the canonical core at `~/.astack/core` first.

**Embedding into existing projects** — a fresh install into a non-empty
directory keeps the project's own `README.md`, `package.json`, `Dockerfile`
and CI workflows, records `.astack/install.json` so later upgrades keep doing
so, and fills stock knowledge packs and plugins only where nothing exists.

**Global `astack-setup` skill** for Claude Code (`~/.claude/skills`) and Codex
(`~/.agents/skills`): saying "install", "set up", "نصب شو" or "راه‌اندازی شو"
in any project runs the setup, with or without AStack already there.

### Changed

**The contract is a managed block.** It ships as `system/agent-contract.md` and
lives in `AGENTS.md` between markers, refreshed on every setup and upgrade, so
contract changes reach installs while project rules outside the block are kept.
An unmarked `AGENTS.md` exactly as 2.2.0 shipped it is replaced, not
duplicated. The installers (`installer/install.sh`, `install.ps1`) bootstrap
any project through the canonical core.

## 2.2.0 — Claude Code and Codex in parity, Graphify under budget

Claude Code and Codex become two hands of the same operator: one operating
contract, one memory, one journal, one tool surface. Work started in one runtime
continues in the other without re-explaining anything. Additive; 2.1 installs
are wired by a migration.

### Added

**Shared contract** — `AGENTS.md` is the runtime-neutral operating guide. Codex
loads it natively; `CLAUDE.md` imports it with `@AGENTS.md` and keeps only the
Claude Code specifics, so both runtimes read byte-identical rules.
`astack interop status` proves both resolve to the same contract hash.

**Interop engine** (`interop-engine/`) — `astack interop sync` generates or
merges the wiring for both runtimes (`.mcp.json` and `.claude/settings.json`
for Claude Code, `.codex/config.toml` and `.codex/hooks.json` for Codex). Owner
entries are kept, malformed files are reported and never overwritten, and a
second run changes nothing. `--trust-codex` trusts the project in
`~/.codex/config.toml` with a backup.

**astack MCP server** — `astack mcp serve`, a dependency-free stdio MCP server
both runtimes launch. Sixteen tools (standup, memory search/remember/supersede/
entity, context map/search, ask, skill catalog, handoff, journal, interop
status, and four code graph tools) run the CLI with an argument vector, so results are identical in both
runtimes and records keep the calling runtime as provenance.

**Session hooks and journal** — a session-start hook gives either runtime the
same context: contract hash, the latest handoffs and session ends from both
runtimes, owner capsule, open work and a memory brief. Session ends and
structured handoffs (`astack interop handoff`) go to
`.astack/interop/journal.jsonl`; handoffs are also episodic memory.

**Claude Code memory import** — Claude Code auto-memory is imported into the
shared store at every Claude Code session start; a changed file supersedes its
earlier record, so Codex recalls what Claude Code learned.

**Codex runtime adapter** — `codex` is a hosted runtime writing the same work
order format as `claude-code`; the model router prefers the runtime hosting
the current session on a tie.

**Graphify, driven by AStack** — `astack graphify setup|upgrade|build|status|
query|explain|path|affected|benchmark` installs Graphify (`graphifyy`) as an
isolated tool, installs its git hooks and builds a local, AST-only code graph.
The guidance lives once in `AGENTS.md` instead of Graphify's per-runtime,
machine-specific installers. Every answer is capped by `graphify.query_budget`
(hard cap `graphify.max_budget`), metered in
`.astack/context/graphify-usage.jsonl`, and flagged when the graph is stale;
`status` reports tokens served and savings against Graphify's benchmark
(25.5x fewer tokens per query on this repository).

**Migration `2026.7-runtime-interop`** and the `verify-interop` suite (six
suites in `npm test`).

## 2.1.0 — The autonomy layer

AStack becomes a persistent organization: it remembers its owner across
conversations, forms the smallest expert team a request needs, executes through
real tools, stops before anything irreversible, verifies the result, audits it
and learns from it. Everything in 2.0 keeps working; this release is additive.

### Added

**Memory OS** — twelve temporal facets (identity, semantic, episodic, project,
entity, relationship, procedural, decision, preference, working, calibration,
lesson) stored as append only JSONL with provenance, confidence, importance and
a validity window. Facts are replaced with `supersede`, never overwritten, so
history stays answerable with `--asOf`. Ranked recall combines lexical
relevance, per facet recency decay, confidence and usage. Nightly
consolidation merges duplicates, decays stale weights and compacts.

**Knowledge graph** — a temporal graph of people, companies, projects, cases,
documents, accounts, portals and the rest, with exclusive relationships that
supersede rather than erase. `astack graph neighbours <id> --asOf <date>`
answers who held a role last quarter.

**Context engine** — an incremental workspace index (symbols, imports, document
outlines, data keys, per file terms) plus domain lenses that extract the records
which make the map work outside software: case numbers, parties, hearings,
statutes, invoices, IBANs, account codes, fiscal periods, tax ids. Documents
that share a record are linked exactly the way source files are linked by an
import. Ranking is a personalized PageRank over that graph; rendering fits a
token budget at three levels of detail and always declares what it omitted.
Precision is preserved: the map is an index with line anchors and
`astack context expand <path>` returns a file's full structure.

**Context router** — one minimal package per request: owner capsule, memory
brief, resolved entities, project state, workspace map, matching skills and the
tool catalog, each inside its own budget.

**Learning engine** — work is recorded as episodes, repetition is mined into
patterns with a canonical procedure and guardrails drawn from failures, and a
qualifying pattern is forged into a real skill package with its evidence.
Forged skills start as drafts and are promoted, retired or rolled back on
recorded outcomes.

**Skills** — ten operational packs: speech to text, advanced OCR, image design,
document intelligence, web operator, structured data extraction, legal case
brief, financial close, tax filing, contract review. A single catalog covers
built in and learned skills with progressive disclosure.

**Internal browser** — a real Chromium profile driven over the DevTools
protocol with no automation dependency. Persistent profiles mean the owner
signs in once and later runs are already authenticated. Flows declare the
authority of every step, stop before anything that commits, capture the state
as evidence and return a resumable checkpoint. Evidence is hash chained and
verifiable. Page text is treated as untrusted data.

**Scheduler** — durable background jobs on intervals or cron: web service
checks with status, latency and body assertions, agent dispatch, context
refresh, skill mining, memory consolidation, project digests, hook processing,
browser tasks. Failures retry with backoff, repeated failures open an incident
that can escalate to an agent, and recovery closes it. A supervisor loop keeps
it running.

**Inbound signals** — one webhook URL to register in any external tool,
verified by token or HMAC signature with a timestamp window, replay protection,
size cap and rate limit. Payloads are normalized, classified into a domain,
sanitized as untrusted content and matched against owner defined rules whose
reactions are policy checked.

**Missions** — durable, resumable units of work with approval checkpoints, dry
run and replay. A mission survives a restart and continues from the step it
stopped at.

**Trust layer** — authority levels L0 to L5 with per domain, tool and site
ceilings and denials; approval requests that state exactly what will happen,
producing single use receipts; an append only audit trail with secret
redaction; and a secret broker where callers only ever see
`credential://provider/name`.

**Tool registry** — sixteen tools with manifests declaring capabilities, risk,
permissions, credentials and dry run support, a token bounded catalog, capability
search, and one invocation path where authority, policy and audit always apply.

**Runtime abstraction and model router** — a provider independent runtime
interface with Claude Code, generic CLI and mock adapters, structured handoffs
instead of transcripts, and routing by task class, risk, context size and
recorded performance. No commercial model name is hard coded.

**Chief of Staff** — intent analysis, entity resolution, risk assessment and
just in time team formation that starts at one agent and makes every extra seat
earn itself, with the estimated token cost shown before the team is formed.

**CLI** — `ask`, `standup`, `owner`, `context`, `memory`, `graph`, `learn`,
`skill`, `mission`, `schedule`, `signal`, `browser`, `authority`, `approval`,
`audit`, `secret`, `tool`, `runtime`, all localized.

**Documentation** — thirteen new pages including an honest feature status table
separating what is implemented from what is adapter-ready or future.

**Tests** — two new deterministic suites (intelligence, autonomy) covering
memory, temporal supersede, graph history, indexing, budgets, retrieval
precision, the learning lifecycle, authority, approvals, audit redaction,
credential handling, tool gating, runtimes, missions with approval and restart,
scheduler retries and incidents, webhook verification and hostile payloads,
browser planning and evidence, the owner scenarios and the upgrade migrations.
A separate opt in suite drives a real browser end to end.

### Changed

- `ConfigurationEngine` parses the configuration file instead of string matching
  it; `requireSections` is unchanged.
- `MemoryEngine` keeps its markdown scopes and API, and now mirrors structured
  writes into the owner facing scope when one is given.
- The orchestrator reports what the autonomy layer is holding: matching skills,
  pending approvals, active missions, due jobs, open incidents.
- The domain registry learned more Persian vocabulary for accounting, legal,
  finance, tax, HR and operations.
- `astack doctor` reports memory facets, skills, tools, runtimes, jobs, hooks,
  missions, the browser driver and the authority default.

### Upgrade notes

`astack upgrade` replaces managed engine files after a backup and appends the new
configuration sections without touching owner values. Five idempotent data
migrations create the structured memory store, seed the owner capsule, install
the default authority policy, create `skills/learned` and import existing
decisions into the decision facet.

Coming from 2.0, run `astack init` once after the upgrade to apply them: an
install upgrades itself with its own command, so a 2.0 install runs 2.0 code,
which predates migrations. `astack doctor` reports whatever is still pending.
From 2.1 onward `astack upgrade` runs them itself.

`.astack/`, `memory/`, `plugins/`, `knowledge-packs/`, `skills/learned/` and any
path under `upgrade.keep` are never touched.

After upgrading:

```bash
astack init                # applies any pending data migrations
astack context build
astack schedule defaults
astack owner set --name "<you>"
astack authority show
```

### Not included

Email, messaging, database, SSH and document tools ship as manifests with no
live adapter; they refuse honestly rather than fabricating a result. The
computer operator (desktop control) exists as an interface only. The CLI runtime
adapter needs a configured command before it can run. Browser sessions need Node 22
or newer for the global WebSocket; the rest of AStack runs on Node 20. Storage is JSON and JSONL;
the storage surfaces are narrow so another backend can replace them later.

## 2.0.0

Generalized AStack into a multi-domain operating system: ten engagement
domains, thirty-three departments, a role catalog, team assembly from domain
blueprints, agents with scheduled missions and work orders, a leadership layer,
the delivery engine, and the upgrade engine with managed, seed and preserved
paths.
