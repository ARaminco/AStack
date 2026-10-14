# Configuration

The single active configuration file is `astack.config.yaml` at the repository root. The `ConfigurationEngine` validates that required sections exist; `astack doctor` fails when one is missing.

## Sections

| Section | Purpose |
| --- | --- |
| `project` | Name, product line, version (kept in sync with `core/manifest.json`), primary runtime, compatibility flags |
| `language` | Supported locales (`fa`, `en`, `ar`, `tr`), the Persian-for-owner / English-for-assets split per output type |
| `documentation_language` | Default documentation language (`en`) and secondary (`fa`) |
| `architecture` | The ordered layer list; must match the directories verified by `astack doctor` |
| `models` | Default model and per-task routing, plus one block per provider (enable flag, default model, endpoints) |
| `localization` | Localization service path, translations directory, global policy file |
| `memory` | Memory engine path, directory, and the eleven scopes (including `team` and `agent`) |
| `delivery` | Project storage, templates, sprint defaults, WIP limits, health thresholds, forecasting and estimation methods |
| `domains` | Domain registry and engine paths, detection strategy, supported detection languages |
| `teams` | Team engine path, storage (`.astack/teams`), assembly strategy, statuses |
| `agents` | Agent engine and leadership paths, storage (`.astack/agents`), default provider, scheduling intervals, dispatch mode, supervision commands |
| `upgrade` | Upgrade engine and manifest paths, canonical source repository, cache and backup locations, standalone script, `keep` list |
| `plugins` | Plugin directory and manifest name |
| `telemetry` | Disabled by default; local-summary mode only |
| `security` | Least-privilege permission default, secret storage policy (environment variables only, never committed) |
| `cli` | Default locale and the supported command list |

## Owner Customization
Edit values freely — the file is **seed-only** for upgrades: `astack upgrade` never overwrites it. New top-level sections introduced by a newer core are appended automatically during upgrade (existing values untouched, previous file backed up). To protect additional paths from upgrades, list them under:

```yaml
upgrade:
  keep:
    - departments
    - roles/enterprise-roles.json
```

## Precedence
- `ASTACK_LOCALE` overrides `cli.default_locale`.
- `ASTACK_SOURCE` and `--from` override `upgrade.source`.
- CLI flags override configuration defaults for a single invocation.

## Autonomy sections (2.1)

```yaml
context:                 # token budgets and the workspace index
  owner_capsule_budget: 800
  memory_budget: 2500
  project_budget: 3500
  repo_map_budget: 2000
  skill_budget: 3000
  tool_catalog_budget: 500
  retrieval_budget: 12000
  refresh: auto          # auto | always | never

graph:                   # temporal knowledge graph
  backend: file          # file today; the adapter shape allows others
  temporal: true

learning:                # experience to skills
  auto_create_skill_candidates: true
  auto_promote_skills: false
  min_occurrences: 3
  min_distinct_days: 2
  min_success_rate: 0.6

runtime:                 # runtime providers
  default: claude-code
  providers:
    claude-code:
      enabled: true
    mock:
      enabled: true
    # codex:
    #   command: codex
    #   args:
    #     - --prompt-file
    #     - "{promptFile}"

scheduler:               # background jobs
  tick_interval: 60s
  default_timeout_ms: 30000
  default_retries: 1

signals:                 # inbound hooks
  server:
    host: 127.0.0.1
    port: 8787
    require_signature: true
    rate_limit_per_minute: 60

browser:                 # internal browser
  preferred_driver: cdp
  persistent_profiles: true
  headless_default: true
  stop_before_commit: true

authority:               # what may run without the owner
  default_level: L2
  autonomous:
    - L0
    - L1
    - L2
  require_approval:
    - L4

audit:
  enabled: true

secrets:
  source: environment_variables
  reference_scheme: "credential://<provider>/<name>"
```

Owner overrides that live outside the config file, under `.astack/security/`:
`authority.json` (ceilings and deny lists), `automation.json` (command and host
allowlists), `credentials.json` (credential references, never values).

Block style only. The bundled parser reads nested maps, lists of scalars and
lists of maps; a flow value such as `{ enabled: true }` is refused with a named
error rather than being read as a string. Empty collections (`keep: []`) are
fine.

Values that are also code defaults — the authority ceiling, the learning
thresholds, the budgets — are read from this file where an engine consumes
them and fall back to the same defaults when a section is absent, so a partial
file is always safe. The live authority and automation policies are the files
under `.astack/security/`, edited through `astack authority` and
`astack schedule policy`; this section states the intent a fresh install
starts from.

Existing installs need no edits: every new section has a default, and
`astack upgrade` appends missing sections without touching owner values.

## AStack 3.0 sections (all optional)

Every 3.0 section is optional and none is required by `astack doctor`. The
shipped `astack.config.yaml` carries each one as a **commented block** with its
defaults; uncomment only what you change. When a section is absent the
defaults below apply, so an upgraded 2.5 configuration keeps working as is.

| Section | Engine | Off or read-only until |
| --- | --- | --- |
| `runner` | `runner-engine/` | `astack schedule policy allow-command claude` (or `codex`); Ollama works when it answers on loopback |
| `daemon` | `daemon-engine/` | `astack daemon start` |
| `gateway` | `gateway-engine/` | `gateway.enabled: true` and one channel `enabled: true` |
| `search` | `search-engine/` | `astack search reindex` (enabled by default, nothing indexed before) |
| `skills.packs` | `skill-hub/` | enabled by default; packs rank below built-in skills |
| `console` | `console/` | `astack console start` or the daemon |
| `board` | `board-engine/` | `astack board create` |
| `sandbox` | `sandbox-engine/` | Docker running; routing needs `astack sandbox require` |
| `vault` | `trust-engine/vault.mjs` | a reference registered with a `vault:*` source |
| `a2a` | `interop-engine/a2a-server.mjs` | `astack a2a serve` with `credential://a2a/token` |

```yaml
runner:
  default_engine: auto          # auto | claude | codex | ollama | mock
  daily_budget_usd: 5           # refuse new runs once today's spend reaches this
  per_run_budget_usd: 1         # passed to claude as --max-budget-usd
  max_concurrent: 1
  timeout: 15m
  poll_interval: 15s            # how often the daemon drains the queue
  brief_budget: 6000            # context tokens in the work order
  local_brief_budget: 2500      # smaller work order for the local model
  routing:                      # auto: model-router tier -> engine
    fast: ollama
    standard: claude
    strong: claude
    coding: claude
  claude:
    command: claude
    permission_mode: dontAsk    # default | dontAsk | acceptEdits | plan
    allowed_tools:              # applied only at L3+ for cli, console and gateway runs
      - Read
      - Grep
      - Glob
    tools: null
    strict_mcp: true
    mcp_config: null
    skills: false
    model: null
  codex:
    command: codex
    sandbox: read-only          # danger-full-access is refused
    args: []                    # sandbox/approval bypass arguments are refused
  ollama:
    url: http://127.0.0.1:11434
    model: null                 # null = first installed chat model

daemon:
  services:                     # default: every <engine>/service.mjs that exists, in this order:
    - runner-engine             # runner-engine, scheduler-engine, signal-engine, gateway-engine,
    - scheduler-engine          # search-engine, skill-hub, console, board-engine
    - signal-engine
  restart_backoff_ms: 1000
  restart_backoff_max_ms: 60000
  health_interval_ms: 5000
  windows_launcher: conhost-headless   # or: direct

gateway:
  enabled: false
  language: fa
  poll_interval_s: 5
  long_poll_s: 25
  max_inbound_age_s: 600
  rate_limit_per_minute: 20
  send_spacing_ms: 800
  send_level: L2
  ack: true
  single_pending_without_code: true    # private chats only; groups always need a quote or the code
  approval_window_minutes: 30
  owners:                              # placeholder ids; default: empty (nobody is heard)
    telegram:
      - "100000001"
  groups:                              # placeholder; default: no group is heard
    whatsapp-bridge:
      - "120000000000000000@g.us"
  listener:                            # webhook listener (whatsapp-cloud)
    host: 127.0.0.1
    port: 8788
    allow_remote: false
  channels:
    telegram:
      enabled: false
      token: credential://telegram/bot
    whatsapp-wapi:
      enabled: false
      base_url: http://127.0.0.1:3000
      token: credential://wapi/channel
    whatsapp-bridge:
      enabled: false
      port: 8790
    whatsapp-cloud:
      enabled: false
      phone_number_id: "000000000000000"
      api_version: v21.0
      access_token: credential://whatsapp-cloud/access-token
      app_secret: credential://whatsapp-cloud/app-secret
      verify_token: credential://whatsapp-cloud/verify-token
  voice:
    enabled: true
    model: large-v3-turbo
    language: fa
    device: auto                       # CUDA float16, else CPU int8
    python: python
    timeout_s: 300
    allow_approvals: false             # voice notes never approve unless true

search:
  enabled: true
  storage: .astack/search
  backend: auto                 # auto (node:sqlite FTS5, JSON fallback) | json
  sources:                      # what reindex covers
    - memory
    - sessions
    - reports
    - skills
    - missions
  default_sources:              # what a query searches without --source
    - memory
    - sessions
    - reports
    - skills
  k: 10
  budget: 1200
  hooks: true                   # memory/context search add "also found in past sessions"
  reindex_every: 15m            # daemon service interval
  semantic:
    mode: auto                  # auto | on | off
    url: http://127.0.0.1:11434
    model: bge-m3
    batch_size: 16
    min_similarity: 0.35

skills:
  packs:
    enabled: true               # false: every output is byte-identical to a core without packs
    weight: 0.6
    runtime_penalty: 0.5        # skills tied to another agent runtime (compat: hermes-runtime)
    review_penalty: 0.8         # high-risk skills
    auto_select_review: false   # high-risk pack skills are never picked automatically
    update_check: false
    update_check_hours: 24

console:
  enabled: true                 # false keeps the daemon from starting it
  host: 127.0.0.1
  port: 7717
  allow_remote: false
  allowed_hosts: []
  poll_interval: 3s
  session_days: 30
  locale: fa                    # fa | en

board:
  max_parallel: 2
  max_retries: 2
  backoff_ms: 2000
  backoff_max_ms: 300000
  max_review_rounds: 2
  tick_ms: 15000
  ceiling: null                 # null: the runner default
  engine: auto

sandbox:
  image: node:22-alpine
  network: none                 # none | bridge
  memory: 512m
  cpus: "1"
  pids_limit: 128
  timeout_ms: 120000
  user: "65534:65534"
  allow_inline_eval_when_isolated: true
  allow_mounts_outside_workspace: false
  docker: docker

a2a:
  host: 127.0.0.1
  port: 41241
  path: /a2a
  ceiling: L1                   # capped by authority.default_level, never above L3
  execute: false                # plan only; true lets the runner execute with read-only tools
  allow_remote: false
  public_url: null
```

`vault` has no keys of its own: register a reference with
`--source vault:windows | vault:macos | vault:linux | vault:bitwarden | vault:1password`
(or let `astack secret vault set` do it) and the secret broker resolves it from
that store. Routing commands into the sandbox is an automation-policy setting,
`sandbox.required_for` in `.astack/security/automation.json`, written by
`astack sandbox require`.

Values that must never sit in a committed file stay out of it: credentials
are `credential://` references, and real gateway owner ids belong in
`.astack/gateway/owners.json` through `astack gateway owner add`. See
[Runner and Daemon](Runner-and-Daemon.md), [Gateway](Gateway.md),
[Search](Search.md), [Skill Hub](Skill-Hub.md),
[Aramin Console](Aramin-Console.md) and
[Board, Sandbox, Vault and A2A](Board-Sandbox-Vault.md) for what each key does.
