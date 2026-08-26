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

## Autonomy layer

**`astack browser status` reports driver `none`**
No Chromium based browser was found. Install Chrome, Edge, Brave or Chromium, or point
`ASTACK_BROWSER_PATH` at the executable. The operator refuses to run rather than pretending.

**A browser flow stops with "waiting for owner approval"**
That is the design: any step that commits (submit, confirm, pay, delete, approve) parks the run.
Review it with `astack approval pending`, then `astack browser resume <mission>` or
`astack mission resume <id>`. Execution continues from the same step; it never replays.

**A login session stopped working**
`astack browser health <profile>` shows each host as valid, expiring or expired. Sign in again
with `astack browser login <profile> --url <site>`.

**A scheduled job fails with "blocked by automation policy"**
Unattended shell commands are denied unless allowlisted and private network targets are denied by
default. Allow them deliberately: `astack schedule policy allow-command <cmd>` or
`astack schedule policy allow-host <host>`. A denied command stays denied even after an approval.

**A webhook returns 401**
The token or the HMAC signature did not verify, the timestamp was outside the five minute window,
or the exact request was already delivered (replay protection). `astack signal endpoint <hook>`
prints the current URL; the signing secret is shown only when the hook is created.

**A webhook returns 200 but nothing happened**
No rule matched. `astack signal inbox` shows the stored event with its detected domain, and
`astack signal list` shows the rules. Reactions are also policy checked: an action outside the
allowlist is refused and recorded in the event's reactions.

**An approval expired before it was used**
Requests expire after their window and receipts authorize exactly one action. Request a fresh one;
this is intentional so a stale "yes" can never authorize a later action.

**`astack context map` looks incomplete**
It is an index bounded by a token budget, and it always prints what it omitted. Widen it with
`--budget`, or go straight to the source with `astack context search` and
`astack context expand <path>`. If the workspace changed, `astack context refresh`.

**A skill was not created after repeated work**
A pattern needs enough repetitions, on enough different days, at a good enough success rate.
`astack learn candidates` shows each candidate with its counts and what is still missing;
thresholds live under `learning:` in `astack.config.yaml`.

**A learned skill was retired by itself**
Repeated failures deprecate a skill and record what went wrong as a guardrail. Inspect it with
`astack skill history <id>` and return to the version that worked with
`astack skill rollback <id> <version>`.

**A tool call answers "adapter-ready"**
That capability ships as a manifest with no live adapter in this workspace. It refuses instead of
fabricating a result. `astack tool inspect <id>` shows its status and required credentials.
