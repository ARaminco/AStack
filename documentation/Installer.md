# Installer

Entry points under `installer/`:

| Script | Platform | Behavior |
| --- | --- | --- |
| `install.ps1` | Windows PowerShell | Verify Node and git, run `astack doctor` |
| `install.sh` | Linux / macOS | Same flow for POSIX shells |
| `update.sh` | Any POSIX shell | Re-bootstrap and re-verify an existing install |
| `claude-code/` | Claude Code | Runtime-specific setup notes |

All installers converge on `node bin/astack.mjs doctor` as the single source of truth for install health: required layers present, config sections valid, and catalog counts reported.

For upgrading the embedded core itself use `astack upgrade` (or the standalone `scripts/astack-upgrade.mjs` for pre-engine installs) rather than the installer scripts — the upgrade path preserves owner data and backs up every replaced file. See [Upgrade.md](Upgrade.md).
