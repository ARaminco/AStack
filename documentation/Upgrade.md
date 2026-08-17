# Core Upgrades

Any project that embeds an AStack core can update itself to the latest version while keeping its own data and customizations.

## In current installs

```bash
astack upgrade --check        # dry run: show what would change
astack upgrade                # fetch, back up, apply
astack upgrade --from C:\Projects\AStack   # use a local checkout instead of git
astack upgrade --keep departments,roles    # protect extra paths this run
astack doctor                 # verify afterwards
```

`astack update` is kept as an alias. The source defaults to the canonical repository (`upgrade.source` in `astack.config.yaml`, override with `--from` or the `ASTACK_SOURCE` environment variable). Git sources are cloned into `.astack/cache/upstream`.

## What is touched and what is not
The manifest `upgrade-engine/manifest.json` (always taken from the new version) defines three sets:

- **managed** — engine code, registries, locales, templates, tests, documentation. Replaced when different; every replaced file is first copied to `.astack/backups/upgrade-<stamp>/`, next to an `upgrade-report.json`.
- **seed** — `astack.config.yaml`, `CLAUDE.md`, `README.md`, `package.json`, `.gitignore`, `.github`, `Dockerfile`. Created only when missing; never overwritten. For `astack.config.yaml`, top-level sections that exist in the new version but not in the owner's file (for example `domains:`, `teams:`, `agents:`, `upgrade:`) are appended automatically — existing values are never modified, and the previous config is backed up first.
- **preserve** — `.astack/`, `memory/`, `plugins/`, `knowledge-packs/`, `.env`, `.git`, `node_modules`. Never touched.

Owner customizations of managed paths can be protected permanently by listing them in `astack.config.yaml`:

```yaml
upgrade:
  keep:
    - departments
    - roles/enterprise-roles.json
```

## In old installs (before the upgrade engine existed)
Older cores have no working upgrade command. They receive the capability through a single self-contained file:

1. Copy `scripts/astack-upgrade.mjs` from this repository into the old project (anywhere inside it), or fetch it raw from the repository.
2. Run `node astack-upgrade.mjs` (flags: `--from`, `--check`, `--force`, `--keep a,b`).

The script finds the install root, fetches the latest core into `.astack/cache/upstream`, then imports and runs the **fetched** upgrade engine — so the newest upgrade logic always governs the upgrade, and the old project gains every new engine (domains, teams, agents, leadership, upgrade) in one pass. Requirements: Node 20+ and git.

## Versioning
The installed version is read from `core/manifest.json` (fallback: `package.json`). Upgrades refuse to downgrade unless `--force` is passed. When versions are equal and no managed file differs, the install is reported as up to date.
