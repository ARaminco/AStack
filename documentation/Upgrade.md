# Core Upgrades

Any project that embeds an AStack core can update itself to the latest version while keeping its own data and customizations.

## The update pipeline

"Update AStack" means the same thing every time, in every project: the new core comes from the AStack git repository (`upgrade.source`, by default https://github.com/ARaminco/AStack.git) through the canonical clone at `~/.astack/core`, and runs through fixed stages.

| Stage | What it does | Stops the update when |
| --- | --- | --- |
| preflight | AStack install present, Node 20+, update lock taken | not an install, old Node, another update running, or the target is the AStack source repository itself |
| fetch | resolves the ref — newest release tag (`stable`), `--version X.Y.Z`, or `--channel main` — and checks it out in `~/.astack/core` | git or network fails |
| plan | versions, add/update/seed counts, new config sections, CHANGELOG titles in between, uncommitted managed files | a downgrade without `--force`; `--check` ends here |
| apply | backs up every replaced file to `.astack/backups/upgrade-<stamp>/`, then writes | — |
| merge | paths in `upgrade.keep` merged three ways: owner version, upstream release, and the base in `.astack/upstream-base/` (the release the project last received). Only-owner changes stay, only-upstream changes arrive, both → `git merge-file` (JSON leaf by leaf); a real conflict keeps the owner version and is listed. New upstream code (`.mjs`) and `manifest.required` files arrive; new curated content does not. Without a base yet, owner files are kept and required files added. | — (conflicts are reported, not fatal; verify decides) |
| setup | migrations, the contract block, Claude Code/Codex wiring, Graphify, index — with the new code in a new process | — |
| verify | `doctor` and `interop doctor` (parity); `--test` adds the test suites | any check fails → automatic **rollback**: core files, configuration and the wiring setup wrote (`AGENTS.md`, `CLAUDE.md`, `.mcp.json`, `.claude/`, `.codex/`, `.gitignore`, `graphify-out`) are restored |
| record | `.astack/update-history.jsonl` and the shared journal | — |

```bash
# from anywhere — works for every core version, including ones without the pipeline
git -C ~/.astack/core fetch --depth 1 origin main && git -C ~/.astack/core checkout -q --force --detach FETCH_HEAD
node ~/.astack/core/bin/astack.mjs update --target /path/to/project [--check] [--version 2.4.0] [--channel main] [--test]

# inside a project on 2.4.0 or newer
node bin/astack.mjs update            # alias: upgrade; setup --update runs the same pipeline
node bin/astack.mjs update history
node bin/astack.mjs update rollback   # restore the last backup (data migrations are additive and stay)

# scripts that refresh the canonical core first
sh installer/update.sh /path/to/project
powershell -File installer/update.ps1 C:path	oproject
```

Asking either runtime to "update AStack" — or «آپدیت کن» — runs this pipeline: the shared contract and the global `astack-setup` skill both map the request to it. The channel can be pinned per project with `upgrade.channel` in `astack.config.yaml`; `--from <path>` uses a local checkout instead of git, and `--keep a,b` protects extra paths for one run.

The AStack source repository itself is never updated by the pipeline (it would overwrite work in progress with a release); it updates with `git pull`.

## What is touched and what is not
The manifest `upgrade-engine/manifest.json` (always taken from the new version) defines three sets:

- **managed** — engine code, registries, locales, templates, tests, documentation. Replaced when different; every replaced file is first copied to `.astack/backups/upgrade-<stamp>/`, next to an `upgrade-report.json`.
- **seed** — `astack.config.yaml`, `AGENTS.md`, `CLAUDE.md`, `README.md`, `package.json`, `.gitignore`, `.github`, `Dockerfile`. Created only when missing; never overwritten. For `astack.config.yaml`, top-level sections that exist in the new version but not in the owner's file (for example `domains:`, `teams:`, `agents:`, `upgrade:`) are appended automatically — existing values are never modified, and the previous config is backed up first.
- **preserve** — `.astack/`, `memory/`, `plugins/`, `knowledge-packs/`, the runtime wiring (`.claude/`, `.codex/`, `.agents/`, `.mcp.json`), `.env`, `.git`, `node_modules`. Never touched; the `2026.7-runtime-interop` migration merges the astack entries into the wiring files instead.

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
