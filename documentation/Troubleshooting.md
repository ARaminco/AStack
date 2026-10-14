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

## Always-on layer (3.0)

`astack doctor` prints one line each for the runner, daemon, gateway, search, skill packs and
console. Start there, then:

### Runner

**`astack run` answers `refused`**
Nothing ran. The reason is printed: `daily-budget` (today's spend reached
`runner.daily_budget_usd`), `max-concurrent` (all `runner.max_concurrent` slots busy), or no
available engine. `astack runner engines` names the cause per engine.

**`claude` (or `codex`) is `unavailable`: "Command is not allowlisted"**
Spawning an engine is a policy decision: `astack schedule policy allow-command claude` once. "not
found on PATH" means the CLI is not installed or `runner.claude.command` / `runner.codex.command`
points elsewhere.

**`ollama` is `unavailable`**
Ollama is not running on `runner.ollama.url` (default `http://127.0.0.1:11434`) or has no chat
model installed (`ollama pull <model>`). `auto` then falls back to the next engine and says so.

**A run stays `awaiting-approval`**
That is the design. Decide with `astack approval pending` / `astack approval approve <id>` (or from
the gateway or the console), then `astack runner resume <id>`. Inside a runner child
(`ASTACK_UNATTENDED=1`) approvals cannot be decided at all.

**A first Claude run fails on a tiny `--budget`**
Claude Code loads its own system prompt before the work order, and the cap is checked after each
API turn. Keep `runner.per_run_budget_usd` comfortably above that fixed floor.

### Daemon and service

**`astack daemon status` says not running after a reboot**
The service is not installed or did not start: `astack daemon service-status`. On Linux, run
`loginctl enable-linger` to keep a user service alive after logout. The last lines of
`astack daemon logs` show why a service crashed; crashed services restart with backoff.

**A config change has no effect**
The daemon reads `astack.config.yaml` when it starts. `astack daemon stop && astack daemon start`.

### Gateway

**`astack gateway test telegram` fails with `telegram getMe -> 404: Not Found` (or `401`)**
The bot token is wrong or damaged: Telegram answers 404 when the token in the request path is not a
valid bot token. Copy it again from @BotFather and store it with
`astack secret vault set credential://telegram/bot`.

**The Telegram token was piped in from Windows PowerShell and the gateway gets 404**
Windows PowerShell puts a UTF-8 byte-order mark in front of piped input, so a token stored that way
before the fix was one character long. Current versions strip the mark; after updating, store the
token again (or type it at the hidden prompt instead of piping it).

**The bot never answers**
Check, in order: `gateway.enabled: true` and the channel's `enabled: true` in `astack.config.yaml`;
the daemon (or `astack gateway serve`) restarted after that change; your account is an owner
(`astack gateway owners` — Telegram needs the numeric user id, not the @username). Messages from
anyone else are ignored on purpose and recorded as `gateway-ignored` in `astack audit list`.

**«بفرست» did nothing, or the bot asked for the code**
A bare word decides only in a private chat, only when exactly one request is open, and only within
`gateway.approval_window_minutes` (30) of a prompt sent to that chat. In a group, reply to the
prompt or include its four-character code. Forwarded messages and voice notes never decide
(voice only with `gateway.voice.allow_approvals: true`). «قبلاً تصمیم گرفته شد» means another owner
account already decided that request.

**WhatsApp via a local wapi gateway is refused by the network policy**
Private and loopback addresses are denied for unattended work by default. Allow private targets
deliberately with `astack schedule policy allow-private` (it sets `network.allowPrivateNetworks` in
`.astack/security/automation.json`).

**Cloud API messages fail with Graph error 131047**
Meta accepts free-form messages only within 24 hours of your last message to the business number.
Message the bot once a day, or keep Telegram as the notification channel.

**Voice notes are not transcribed**
`astack gateway voice status` explains why: `python` not allowlisted
(`astack schedule policy allow-command python`), or faster-whisper missing
(`astack gateway voice setup --yes` installs it with `pip install --user`). Without the CUDA 12
cuBLAS and cuDNN 9 runtime DLLs the script falls back to the CPU, which works but is slower.

### Console

**`astack console open` says Aramin is not running**
`console open` signs in to a console that is already running. Start the daemon
(`astack daemon start`) or run `astack console start --open` instead. If the daemon runs but the
console does not, check `console.enabled` and, when you set `daemon.services`, that the list
includes `console`.

**The sign-in link says the ticket failed**
A ticket is good for one login within a minute. Run `astack console open` again, or sign in with
`astack console token`.

**The token is refused**
It was rotated (`astack console token --rotate` signs every device out), or more than ten failed
attempts were made from your address within a minute. Wait a minute and paste the current token.

**Port 7717 is in use**
Another program holds it: `astack console start --port <n>` or set `console.port`.

**Through a tunnel the console answers with a Host error**
On loopback only `127.0.0.1`, `localhost` and `[::1]` are accepted. Add the tunnel's host name to
`console.allowed_hosts`. See [Aramin Console](Aramin-Console.md#how-to-sign-in).

### Search, skills, sandbox, A2A

**`astack search` says it uses the JSON fallback**
`node:sqlite` needs Node.js 22.5 or newer; on older Node the same commands run on an in-memory BM25
index.

**Search is lexical only**
Semantic ranking needs Ollama with the `bge-m3` model: `ollama pull bge-m3`, then
`astack search reindex`. `astack search status` shows the semantic state.

**A pack skill is never suggested**
Pack skills rank below built-in and learned skills, `astack skill search` lists them only with
`--packs`, and high-risk skills are never selected automatically (`--raw` in
`astack skill pack search` still finds them). Blocked skills are not listed at all.

**`astack sandbox` reports Docker unavailable**
Install Docker and start its daemon; `astack sandbox status` checks both. Commands routed into the
sandbox with `astack sandbox require` fail closed while Docker is down.

**`astack a2a serve` refuses to start**
It needs a bearer token: `astack secret vault set credential://a2a/token` (or
`astack secret register credential://a2a/token`).

**`astack update --test` failed in the gateway suite after updating to 3.0.0**
The first 3.0.0 gateway test read the core's documented `gateway:` block from the project's own
configuration. Update again: the suite now reads that block only inside the core repository.
