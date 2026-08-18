# Troubleshooting

`node bin/astack.mjs doctor` is the first diagnostic for any problem: it validates layers, config sections, and prints catalog counts.

## Common Issues

**`doctor` fails with `config=domains,teams,agents,upgrade`**
The install predates version 2 or the config was hand-pruned. Run `astack upgrade` — new sections are appended to `astack.config.yaml` automatically without touching your values.

**`Unknown domain` / `Unknown workflow` / `Unknown template`**
The error lists the available ids. Domains live in `domains/domains.json`, workflows in `workflow-engine/workflows.json`, templates in `delivery-engine/templates.json`.

**`... name must contain latin letters or digits`**
Project, team, and agent ids are latin slugs (storage paths and git-friendly identifiers). Give the entity a latin name; Persian belongs in missions, objectives, and conversation.

**`WIP limit reached for in-progress`**
The board enforces work-in-progress limits. Finish the named item first, or move consciously past the limit with `--force`. Limits are configured per project (`board.wipLimits`) and defaulted from `delivery.defaults`.

**`Dependencies not done for T-x`**
The item has `dependsOn` entries that are not finished. Complete them or use `--force` for a deliberate exception.

**`astack upgrade` fails with a git error**
Git must be installed and the machine must reach the source. Use `--from <local-path>` to upgrade from a local checkout, or set `ASTACK_SOURCE`.

**Upgrade changed a file you had customized**
Restore it from `.astack/backups/upgrade-<stamp>/`, then add the path to `upgrade.keep` in `astack.config.yaml` so future upgrades preserve it.

**No assignments dispatched by `agent run-due`**
Check `astack agent standup`: the agent must be `active` (not paused/retired) and the assignment `scheduled` with `next` in the past. One-off missions that already ran are `done`.

**CLI prints English instead of Persian**
Set `ASTACK_LOCALE=fa` or check `cli.default_locale`. Missing keys intentionally fall back to English.
