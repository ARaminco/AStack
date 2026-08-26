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
    claude-code: { enabled: true }
    mock: { enabled: true }
    # codex: { command: "codex", args: ["--prompt-file", "{promptFile}"] }

scheduler:               # background jobs
  tick_interval: 60s
  default_timeout_ms: 30000
  default_retries: 1

signals:                 # inbound hooks
  server: { host: 127.0.0.1, port: 8787, require_signature: true, rate_limit_per_minute: 60 }

browser:                 # internal browser
  preferred_driver: cdp
  persistent_profiles: true
  headless_default: true
  stop_before_commit: true

authority:               # what may run without the owner
  default_level: L2
  autonomous: [L0, L1, L2]
  require_approval: [L4]

audit: { enabled: true }
secrets: { source: environment_variables, reference_scheme: "credential://<provider>/<name>" }
```

Owner overrides that live outside the config file, under `.astack/security/`:
`authority.json` (ceilings and deny lists), `automation.json` (command and host
allowlists), `credentials.json` (credential references, never values).

Existing installs need no edits: every new section has a default, and
`astack upgrade` appends missing sections without touching owner values.
