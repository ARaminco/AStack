# Security Policy

## Reporting
Report security issues privately to the repository owner; do not open public issues for vulnerabilities.

## Principles
- **Least privilege by default.** The permission system (`permission-system/policy.mjs`) rejects secret-writing and telemetry actions outright; destructive actions require confirmation.
- **Secrets live in environment variables only.** They must never be committed, and `astack.config.yaml` is checked for secrets before release.
- **No network surface.** AStack has no server and no network API; all state is local files. Telemetry is disabled by default (`telemetry.enabled: false`).
- **Auditable changes.** Every project, team, and agent mutation appends an event; agent dispatches and reports are logged to the `agent` memory scope; upgrades back up every replaced file and write `upgrade-report.json`.

## Upgrade Chain Integrity
`astack upgrade` pulls from the canonical repository configured in `upgrade.source` (or an explicitly passed `--from`). Review `--check` output before applying in sensitive environments, and pin `upgrade.source` to a trusted fork if you maintain one. Backups under `.astack/backups/` make every upgrade reversible.
