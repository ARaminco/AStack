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
