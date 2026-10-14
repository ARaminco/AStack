# Changelog

All notable changes to AStack Enterprise. Versions follow the core manifest
(`core/manifest.json`), which is what `astack upgrade` compares.

## 3.0.0 — Always on, in your pocket, and Aramin

AStack 3.0 adds an unattended runner and one background daemon, a two-way owner
gateway (WhatsApp through wapi, a linked-device bridge or the Cloud API, and
Telegram) with approvals by message and local Persian voice notes, full-text and
semantic recall over memory, past sessions and reports, a skill hub with a
security scanner (shipping the Hermes Agent skills as a separate auxiliary pack),
the **Aramin** console, a durable multi-agent board, a Docker sandbox, OS vault
backends and an A2A endpoint.

### Highlights

- **Works while you are away.** `astack run` executes an objective or a mission
  unattended through Claude Code headless, `codex exec` or a local Ollama
  model, within a daily and a per-run budget; anything irreversible still stops
  for your approval.
- **One background process.** `astack daemon start` keeps the runner queue,
  scheduled jobs, webhooks, the gateway, search reindexing, the board and the
  console running; `astack daemon install-service` starts it at logon on
  Windows, macOS and Linux.
- **AStack in your pocket.** Command it from Telegram or WhatsApp, receive its
  reports, and approve with «بفرست» / "approve" (or decline with «نه» /
  "deny"); several owner accounts per channel; Persian voice notes transcribed
  locally.
- **Aramin, the console.** A local, installable app for approvals, missions,
  memory, runs, jobs, audit, skills and the board, Persian by default;
  `astack console open` opens it already signed in.
- **Smarter recall.** `astack search` finds things across memory, past Claude
  Code and Codex sessions, reports, skills and missions, Persian-aware, with
  optional semantic ranking through Ollama, and builds an owner profile.
- **Skill hub.** Import `SKILL.md` skills into scanned auxiliary packs that rank
  below AStack's own; ships the Hermes Agent pack (211 MIT skills), with
  high-risk skills never auto-selected and two blocked outright.
- **Board, sandbox, vault, A2A.** A multi-agent board with retries and a
  reviewer lane, Docker-isolated commands, OS vault backends for credentials,
  and an Agent-to-Agent endpoint that only plans unless you allow more.
- **Hardened for unattended work.** Authority ceilings enforced in the tools,
  approval forgery blocked, strict approval-by-message rules, redaction of
  every new output (Persian credential words included).
- **Purely additive.** Every 2.5.1 command, file and test works unchanged;
  `astack update` brings 3.0 and every new engine stays off until you turn it on.

It is strictly additive: every 2.5.1 command, file format and test keeps working
unchanged (the original suites run unmodified, apart from a CRLF-tolerant regex
in the interop alias test and excluding third-party `skill-packs/` from the
leftover-marker check). Every new engine is off or read-only until configured.
Build contract: `documentation/V3-Plan.md`.

### P1 — Runner and daemon (always-on AStack)

- **Runner** (`runner-engine/`, `runtime.runner`): unattended execution of the
  hosted work order through Claude Code headless, `codex exec`, a local Ollama
  model or a mock engine; `auto` routes cheap background work to the local
  model and real tasks to Claude Code. Missions run through the mission engine
  and stop at the same approval points; free-form runs turn
  `APPROVAL-REQUEST:` lines into owner approvals and resume after the
  decision. Daily budget, per-run budget and concurrency guards; every run is
  recorded in `.astack/runner/runs.jsonl` and the audit log.
- **CLI**: `astack run "<objective>" [--engine] [--model] [--budget] [--dry-run] [--mission] [--queue]`,
  `astack runner list|show|resume|status|drain|engines|enable-signal-runs`.
- **Queue bridges**: scheduler job kind `agent` (`--objective`, `--engine`,
  `--ceiling`, `--mode`), signal reaction `run-agent` (off until
  `astack runner enable-signal-runs`).
- **Daemon** (`daemon-engine/`): `astack daemon start [--foreground]|stop|status|logs`
  supervises `runner-engine`, `scheduler-engine` and `signal-engine` services
  (and later packages' `service.mjs`) with crash restart and backoff.
- **OS service**: `astack daemon install-service|uninstall-service|service-status [--dry-run]`
  for Windows Task Scheduler, macOS launchd and Linux systemd --user.
- `buildWorkOrder()` extracted from the hosted runtime adapter so the hosted
  and unattended paths share one work order (output unchanged).
- Doctor prints runner and daemon lines. New docs: `documentation/Runner-and-Daemon.md`.

#### Gateway (P2) — the assistant in your pocket

- New `gateway-engine/` exposed as `runtime.gateway` (`notify()`, `status()`, `bind(runtime)`): the owner commands AStack from WhatsApp and Telegram, receives reports, and approves irreversible steps by message.
- Channels: `whatsapp-wapi` (self-hosted wapi REST, polling), `whatsapp-bridge` (own Baileys linked-device bridge installed on demand into `.astack/gateway/bridge/` by `astack gateway whatsapp setup`, paired with `astack gateway whatsapp pair`), `whatsapp-cloud` (Meta Cloud API with signed webhook and verify-token handshake), `telegram` (Bot API long polling) and a `cli` loopback.
- Owner allowlist per channel with several accounts per owner; strangers and non-allowlisted groups are ignored and audited; outbound only to owners and allowlisted groups.
- Inbound text becomes `runtime.runner.execute({ objective, source: "gateway:<channel>" })`, or a plan-only brief without a runner; runner `refused` and `dry-run` results are explained.
- Approvals by message: prompts with exact values and a short code to every owner account; «بفرست» / «ارسال کن» / «تایید» / "approve" and «نه» / «رد» / "deny" by quote or code; ambiguous replies ask; a second account on a decided request gets «قبلاً تصمیم گرفته شد»; decisions go through `runtime.approvals` as `owner@<channel>` and resume the run or mission.
- Commands `/status`, `/pending`, `/runs`, `/stop`, `/help`; Persian replies, Latin digits, no bidi isolates, no tables, split long output, per-channel rate limit with outbox.
- Local Persian voice notes with faster-whisper (`gateway-engine/scripts/transcribe.py`, `large-v3-turbo`, CUDA → CPU), gated by the automation policy; `astack gateway voice setup|test`.
- CLI `astack gateway status|test|send|poll|serve|owners|owner|voice|whatsapp`; daemon service `gateway-engine/service.mjs`; doctor line `Gateway:`.
- Bridge safety ported from Hermes Agent (MIT): owner-message gate, LID ↔ phone aliases, outbound id tracking, reconnect backoff, ownership by identity.
- Tests: `tests/verify-gateway.mjs` (loopback pipeline plus fake wapi, Telegram, Graph API and bridge servers).

### Smarter recall: `astack search` (P3)

- New `search-engine/`: one index over memory records, past Claude Code and Codex
  sessions for this workspace, markdown reports, the skill catalog and missions.
  `runtime.search.query / index / status` implement the v3 contract.
- SQLite FTS5 (BM25) through `node:sqlite` at `.astack/search/index.db`; on Node
  older than 22.5 the same API falls back to an in-memory BM25 index with a clear
  message.
- Persian-aware normalization at index and query time: ی/ي/ى, ک/ك, ه/ة/ۀ, Persian
  and Arabic digits, harakat, tatweel, ZWNJ as a word break plus joined aliases.
- Optional semantic layer: Ollama `bge-m3` embeddings stored as BLOBs, hybrid
  ranking by reciprocal rank fusion; `--semantic auto|on|off`.
- Incremental reindex by fingerprint, content hash and parser version.
- Secrets never indexed: credential-named files skipped, assignments and known
  token shapes redacted.
- Memory search respects supersede: current facts by default,
  `--include-superseded` for history, `--as-of` for a point in time.
- `astack search owner-profile`: deterministic owner profile from identity,
  preference and decision memories plus recent sessions.
- `astack memory search` and `astack context search` show "also found in past
  sessions" when the index exists (unchanged output otherwise).
- Daemon service `search-engine/service.mjs` for periodic incremental reindex.
- New test suite `tests/verify-search.mjs` (appended to `npm test`).

### Skill hub (P4)

- New `skill-hub/` engine (`runtime.skillHub`): imports agentskills.io / Anthropic
  `SKILL.md` skills from a local folder, a git URL or a GitHub `owner/repo/path`
  into auxiliary packs under the new managed directory `skill-packs/`.
- Static security scanner (`skill-hub/scanner.mjs`): prompt injection, hidden
  text, pipe-to-shell, credential access, exfiltration, destructive commands,
  obfuscation and binaries, with `file:line` findings and a `low | medium | high |
  blocked` risk per skill. Scripts are never executed; a skill with scripts
  requires review.
- Skill catalog integration (append-only): pack skills carry
  `source: "pack:<pack>"`, rank below built-in and learned skills
  (`skills.packs.weight`, default 0.6), blocked skills are never selectable, and
  `skills.packs.enabled: false` restores the previous output byte for byte.
- `astack ask` lists catalog skills with auxiliary pack skills below built-ins
  while packs are enabled.
- New commands: `astack skill pack list|search|show|import|scan|remove|updates`,
  `astack skill catalog --packs`, `astack skill curate [--apply]`.
- Skill curator: usage, last use, success rate, cross-source duplicates and
  keep / refine / retire recommendations; changes only with `--apply`, never
  touches built-in skills, never deletes files.
- `skill-hub/service.mjs` for the daemon: optional update check of git-sourced
  packs (check only).
- New auxiliary pack `skill-packs/hermes/`: 211 skills from NousResearch/hermes-agent
  (MIT), with `PACK.md`, `SCAN.md`, `LICENSE` and `compat: hermes-runtime` labels.
- Doctor prints a `Skill packs:` line. New test suite `tests/verify-skillhub.mjs`.

### Aramin — the AStack console (P5)

- New `console/`: **Aramin** (آرامین), a local, installable PWA console in the
  style of a native admin app — bottom tab bar on phones, side rail on desktop, Ctrl/⌘-K
  command palette, bottom sheets, toasts, skeletons, dark/light/system theme,
  RTL Persian by default with an English switch. Zero dependencies, no build.
- `astack console start [--port] [--host] [--open]`, `astack console token [--rotate]`,
  `astack console status`; `console/service.mjs` implements the daemon service
  contract.
- Screens: home, approvals (exact action, target, values, risk, requester;
  approve/deny with a confirmation sheet, typed code for irreversible actions,
  receipt), missions (pause/resume/cancel, steps, timeline), memory (recall,
  entities, stats; `runtime.search` when present), runs (dry run first; refused
  runs with their reason), jobs/hooks/incidents (run-now for safe kinds), audit
  log (filters, paging), skills (incl. packs), board, gateway, system (daemon
  state, services), settings.
- Optional engines (runner, gateway, search, skill hub, board, sandbox, daemon)
  are feature-detected; missing ones show a "not installed" card.
- Security: loopback by default, Host-header check, owner token in
  `.astack/console/token`, HttpOnly SameSite=Strict session cookie, hashed
  session store, CSRF on every write, login rate limit, strict CSP, no external
  origins. Decisions go through `runtime.approvals` / `runtime.missions` /
  `runtime.runner` as `owner@console` and are audited.
- Live updates over Server-Sent Events (event bus + cross-process state poller)
  with Web Notifications.
- Vazirmatn variable font vendored with its OFL licence.
- Shared-file edits (append only): `bin/astack.mjs` (import, `console` command,
  one doctor line), `locales/fa.json` + `locales/en.json` (`cli.help.console`,
  `cli.console.*`, `console.*`), `upgrade-engine/manifest.json` (`console`
  managed), `.gitignore` (`.astack/console/`), `astack.config.yaml` (commented
  `console:` defaults), `package.json` (`tests/verify-console.mjs` appended to
  `npm test`, `test:console`, `console` scripts).
- Docs: `documentation/Aramin-Console.md`.

### P6 — Board, sandbox, vault, A2A

**Added**
- `board-engine/`: durable multi-agent kanban (`runtime.board`, `astack board create|list|show|add|run [--once]|steer|retry|cancel`). Cards with agent/team assignees, dependencies, retries with exponential backoff, structured per-attempt handoffs and transcripts, parallel fan-out (`board.max_parallel`), an independent reviewer lane (`--review`), live steering, approval waits, crash recovery and a per-board lock. Executes through `runtime.runner.execute`; without a runner cards are `blocked: runner not installed`. Emits `board.card.*` events and notifies `runtime.gateway` when a card fails. Daemon service in `board-engine/service.mjs`.
- `sandbox-engine/`: Docker-isolated execution (`runtime.sandbox.exec`, `astack sandbox status|images|require|exec -- <command>`): no network, read-only root, all capabilities dropped, no-new-privileges, pids/memory/CPU limits, read-only mounts with secret stores hidden. The automation policy remains the gate; every run is audited.
- Automation policy: optional `sandbox.required_for` patterns route matching shell-tool commands and `command` jobs into the sandbox (fail closed). Unset, nothing changes.
- Vault backends for the secret broker: `vault:windows` (DPAPI), `vault:macos` (`security`), `vault:linux` (`secret-tool`), `vault:bitwarden` (`bw`, read only), `vault:1password` (`op`, read only). `astack secret vault status|set|test|remove`; values via stdin or a hidden prompt only.
- Exfiltration guard `trust-engine/redaction.mjs` (`redactResolvedSecrets`, `redactResolvedDeep`): resolved secret values are scrubbed from audit records, board transcripts, sandbox output and A2A responses.
- A2A endpoint `interop-engine/a2a-server.mjs` (`runtime.a2a`, `astack a2a serve|card|status`): agent card, `message/send`, `tasks/get`, `tasks/cancel` over JSON-RPC with bearer auth (`credential://a2a/token`), loopback by default, inbound tasks treated as untrusted under a capped authority ceiling; plan-only through the chief of staff when no runner is installed.
- `tests/verify-board.mjs` appended to `npm test`; `documentation/Board-Sandbox-Vault.md`.

#### Security hardening (3.0 security review)

Mandatory before the owner gateway is enabled. Nothing here changes a 2.5.1
command, file format or test; the six 2.5.1 suites run unmodified.

- **Ceiling enforced in the tools.** Runner runs at L0–L2, and every run that
  is not the owner's own request, get Claude `Read`/`Grep`/`Glob` with
  `dontAsk` and codex `read-only`, whatever the configuration says. Wider
  configured tools apply only at L3+ for `cli`, `console` and `gateway:*`;
  `a2a` and `signal:*` are always read-only (`toolScopeFor`).
- **Approval forgery blocked.** Mandatory Claude denies (`Write`/`Edit` on
  `.astack/**`, any `astack approval`, any Bash touching `.astack`) that a
  custom deny list cannot drop; `ASTACK_UNATTENDED=1` in every runner child,
  under which the approval engine, `astack approval approve|reject|deny` and
  `astack browser resume` refuse to decide. The approval file format is
  unchanged.
- **Gateway approvals.** Groups need a quote or the code; in a private chat a
  bare word counts only for a prompt delivered to that chat, before the reply,
  within `gateway.approval_window_minutes` (default 30); forwarded messages are
  never decisions (Telegram, Baileys, wapi, Cloud API); every prompt names the
  run's source.
- **A2A.** Injection-shaped requests are rejected; plan only unless
  `a2a.execute: true`; artifacts redacted; no automatic pack skills and no
  past sessions for A2A and signal runs.
- **No domain escalation for outsiders.** A2A and signal runs are capped at
  the owner's default level; the signal engine passes only
  `hook.defaults.domain` to the runner.
- **Redaction of new outputs.** Runner records, prompts and outputs, gateway
  messages and A2A artifacts pass `redactSecretsStrict` (new export in
  `lib/text.mjs`; `redactSecrets` is unchanged) and the resolved-secret guard.
  Token shapes now live in `lib/redact.mjs`, shared with search. The header of
  `trust-engine/redaction.mjs` states its real coverage and limits.
- **Sandbox.** Every `.astack/`, `.ssh/`, `.claude/`, `.env*` and `.git/config`
  is hidden at any depth; env values travel in a temporary env file; image and
  user come only from configuration; the routed sandbox mounts only workspace
  folders. The filesystem tool also refuses `.astack/gateway|search|a2a|console`.
- **Search redaction.** Persian and short credential keywords (رمز، پسورد،
  گذرواژه، کلمه عبور، کد تایید، کد ورود، توکن, pass, pwd, pin, otp, 2fa, cvv),
  card numbers and IBANs.
- **Inbound fence.** A random fence per run; fence markers in the input are
  removed; injection patterns extended (Persian too), append only.
- **Smaller items.** Codex bypass arguments refused and Claude permission modes
  allowlisted; DPAPI through the absolute PowerShell path; Baileys installed
  with `--ignore-scripts` and `/send-media` limited to the bridge outbox/media
  folders; gateway and signal listeners need `allow_remote` for a non-loopback
  host, keep a bounded rate-limit map and answer 500 without detail;
  `.gitignore` ignores `.astack/` as a whole; Hermes `godmode` and
  `obliteratus` blocked through the new `skill-packs/<pack>/OVERRIDES.json`,
  kept across re-imports; pack skills labelled third-party in work orders.

Follow-up, not done here: signing approval records with a DPAPI-protected key.
It would have to verify unsigned 2.5.1 records too, so it only adds value once
every writer signs; the ASTACK_UNATTENDED gate and the mandatory `.astack/**`
denies close the forgery path for runner children in the meantime. A process
that runs as the owner outside the runner can still append to
`.astack/approvals/requests.jsonl` directly.

#### 3.0.0 fixes after review

- **Gateway and console commands.** `astack gateway …` no longer falls through
  into the console command (a missing `return` from merging the two
  packages).
- **Context index.** The context engine ignores the third-party `skill-packs/`
  folder, so pack text never enters the workspace map or context search.
- **Skill search stays built-in.** `astack skill search` returns built-in and
  learned skills only, exactly as in 2.5.1, unless `--packs` is given; the
  catalog resolves a `<pack>/<id>` only while packs are enabled.
- **Agent job payload.** `--objective`, `--mission`, `--engine`, `--ceiling` and
  `--mode` are stored only for scheduler jobs of kind `agent`; other job kinds
  keep their 2.5.1 payload.
- **Migration `2026.8-ignore-v3-state`.** An existing `.gitignore` that does not
  ignore `.astack/` as a whole learns the 3.0 state folders (gateway, runner,
  daemon, search, board, sandbox, vault, a2a, skill-hub, console), so the
  search index of past sessions or a WhatsApp session can never be committed.
- **Gateway test in installed projects.** The gateway suite reads the
  documented `gateway:` block only in the core repository; an installed
  project's own `astack.config.yaml` no longer fails `astack update --test`.
- **Vault and Windows PowerShell.** `astack secret vault set` strips the UTF-8
  byte-order mark that Windows PowerShell puts in front of piped input; a
  Telegram token stored that way had been one character long (Telegram
  answered 404). Store such a token again after updating.
- **High-risk pack skills are never auto-selected.** Skills with scan status
  `review` (such as curl-pipe installers) stay listed but are found only by an
  explicit raw search or `show`; `skills.packs.auto_select_review: true`
  restores the old ranking.

#### `astack console open`

- New `astack console open`: while the console runs (inside the daemon or
  `astack console start`), it opens the browser already signed in. It issues a
  one-time ticket shared across processes through
  `.astack/console/tickets.json`, which stores only the ticket's SHA-256 hash
  and expiry; the ticket travels in the URL fragment and is good for one login
  within a minute. Without a running console it says so and exits with an
  error. `astack console start --open` keeps its in-process ticket.
- Docs: "How to sign in" now opens `documentation/Aramin-Console.md`.

## 2.5.1

The merge stage skips seed files and preserved data listed in `upgrade.keep`
(`astack.config.yaml`, `CLAUDE.md`, `README.md`, `memory`, `knowledge-packs`,
…): the configuration gains new sections on apply and the rest belongs to the
owner, so a text merge of them could only do harm.

## 2.5.0 — Customised installs update safely, memory comes back whole

Written while updating a law firm's heavily customised 2.0 fork.

### Added

**Three-way merge of protected paths** — a new `merge` stage in the update
pipeline. Paths in `upgrade.keep` used to be frozen, so a release that changed
the engine around them broke the install. They are now merged against the
release the project last received (`.astack/upstream-base/`, refreshed after
each verified update): owner-only changes stay, upstream-only changes arrive,
both go through `git merge-file` (JSON leaf by leaf), and a real conflict keeps
the owner's version and is reported. New upstream code and `manifest.required`
files arrive inside protected paths; new curated content does not. Rollback
undoes the merge.

**Markdown memory import** — `memory/` scopes and any folder in
`memory.import_paths` are imported into the shared store one section per record,
at every session start (both runtimes), in setup and with
`astack memory import-legacy`. Changed sections supersede, removed ones retire,
credential-like files are never read, AStack's own template files are skipped.

**`interop.project_root`** — for a core embedded in a subfolder: the contract,
`CLAUDE.md` import, MCP server, hooks and Claude Code memory import target the
folder the runtimes are actually opened in.

**`cli.aliases`** — owner command names in `astack.config.yaml` (for example
`matter: project`), which survive updates where an edit to `bin/astack.mjs`
did not.

## 2.4.1

A rollback now restores the project completely. The pipeline snapshots the
files the setup stage writes outside the core (`AGENTS.md`, `CLAUDE.md`,
`.mcp.json`, `.claude/settings.json`, `.codex/*`, `.gitignore`, `graphify-out`)
before setup and puts them back — or removes them — when verification fails.
Found updating a heavily customised 2.0 fork whose protected engines are
incompatible with 2.4: the core was restored, but its `CLAUDE.md` kept an
import of an `AGENTS.md` that the rollback had removed.

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
