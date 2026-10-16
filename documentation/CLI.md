# CLI Reference

Every command is localized: owner facing output is Persian, identifiers and
commands stay English.

## Chief of staff

```bash
astack ask "<request>"                 # analyse a request and return the plan
astack ask "<request>" --dry-run       # explain everything, touch nothing
astack ask "<request>" --engage        # form the team and open a durable mission
astack ask "<request>" --context       # print the full context package
astack standup                         # session opener: capsule, missions, approvals, jobs
astack owner capsule|show|set|prefer|context|summarize
```

## Context

```bash
astack context build [--force]
astack context map "<query>" [--budget 4000] [--print] [--lines 60]
astack context search "<query>" [--limit 10]
astack context expand <path>
astack context related "<entity or symbol>"
astack context stats | refresh | verify
astack context pin <path> | unpin <path>
```

## Memory and graph

```bash
astack memory search "<query>" [--facet <facet>] [--asOf <date>] [--limit 10]
astack memory remember "<title>" --facet decision --body "<why>"
astack memory supersede <id> "<new title>" --object "<value>"
astack memory entity "<name>" | context "<query>" | consolidate | stats | backup
astack memory search "<query>" --case <id> | --scope project:<id>,case:<id>
astack memory active [--project <id>] [--case <id>] [--agent <id>] [--budget 1200]
astack memory block list|show|history|set|append|replace|remove|restore <scope>/<label> ...
astack memory reflect [--scope <scope>] [--dry-run]
astack ask "<request>" --team
astack browser dedicated status|start [url]|stop
astack graph add "<name>" --type Company
astack graph relate --from <id> --type works_with --to <id> [--exclusive]
astack graph resolve "<text>" | neighbours <id> [--asOf <date>] | history <id> | stats | compact
```

## Learning and skills

```bash
astack learn status | candidates [--ready] | episodes | brief "<task>"
astack learn record "<task>" --domain legal --tools a,b --steps "one;two"
astack learn forge [<candidate-id>]
astack learn feedback <skill-id> --outcome done|failed --note "<what happened>"
astack skill list [--source learned] [--status active] [--domain tax]
astack skill catalog [--budget 600] | search "<query>" | show <id> | test <id>
astack skill history <id> | promote <id> --status active | rollback <id> <version>
```

## Missions

```bash
astack mission list [--state waiting-approval] | show <id> | status
astack mission create "<title>" [--domain tax] [--steps '<json>']
astack mission step <id> "<title>" --tool browser --action run --params '<json>'
astack mission run <id> [--dry-run]
astack mission resume <id> | pause <id> | cancel <id> | replay <id>
astack mission report <id> --summary "<result>"
```

## Background work

```bash
astack schedule add "<name>" --kind http-check --every 10m --url <url> --expectStatus 200
astack schedule list | show <id> | run <id> | tick | status | history <id> | incidents
astack schedule watch [--interval 60s] | stop
astack schedule enable <id> | disable <id> | remove <id> | defaults | kinds
astack schedule policy [allow-command <cmd> | allow-host <host> | allow-private]
```

## Inbound hooks

```bash
astack signal create "<name>" --source whatsapp --mapping '<json>'
astack signal rule <hook> --contains "a,b" --then '<json>'
astack signal endpoint <hook> [--host https://example.com]
astack signal emit <hook> --payload '<json>'
astack signal serve [--port 8787] | process | inbox | status | list | remove <hook>
```

## Browser

```bash
astack browser status | profile create <id> | profile remove <id>
astack browser login <profile> --url <url> [--waitFor <selector>]
astack browser health <profile>
astack browser run --profile <id> --url <url> --steps '<json>' [--dry-run] [--headed]
astack browser resume <mission> [--reject]
astack browser evidence [<bundle>] | evidence verify <bundle>
```

## Trust

```bash
astack authority show | default <L0-L5> | set <domains|tools|sites> <key> <level> | check "<action>" --level L4
astack approval pending | list | show <id> | approve <id> | reject <id> | request --action <a>
astack audit list [--mission <id>] | show <id> | stats
astack secret register credential://<provider>/<name> | list | describe <ref> | check <ref> | remove <ref>
astack tool list | catalog | search "<capability>" | inspect <id> | stats
astack runtime list | status | test <id> | route "<task>" | performance
```

## Runtime interop (Claude Code and Codex)

```bash
astack interop status | doctor
astack interop sync [--dry-run] [--trust-codex]
astack interop handoff "<summary>" [--done "..."] [--findings "a;b"] [--open "q1;q2"] [--next "..."] [--runtime codex|claude-code]
astack interop journal [--limit 10] [--runtime <id>]
astack interop context [--runtime <id>]
astack interop import-claude-memory
astack interop hook session-start|session-end --runtime <id>   # called by the runtimes
astack mcp serve | tools
```

## Setup and update

```bash
astack setup [--target <dir>] [--no-graphify] [--no-trust-codex] [--no-hooks] [--no-index] [--no-global-skill]
astack update [--target <dir>] [--check] [--version X.Y.Z] [--channel stable|main] [--from <path>] [--test] [--no-verify] [--no-rollback] [--force] [--keep a,b]
astack update history | rollback [--backup <dir>]
```

## Code graph (Graphify)

```bash
astack graphify status | setup [--no-hooks] [--no-build] | upgrade | build [--force] | benchmark
astack graphify query "<question>" [--budget N] | explain "<node>" | path "<A>" "<B>" | affected "<node>"
```

## Unattended runner (3.0)

```bash
astack run "<objective>" [--engine auto|claude|codex|ollama|mock] [--model <m>] [--budget <usd>] [--ceiling L1] [--dry-run]
astack run --mission <id>                  # run an existing mission through the mission engine
astack run "<objective>" --queue           # enqueue for the daemon instead of running now
astack runner status                       # runs, queue, spend today against the daily budget
astack runner list [--limit 20] [--status <status>] | show <id>
astack runner resume <id> [--note "<text>"]
astack runner drain [--limit <n>]
astack runner engines
astack runner enable-signal-runs
astack schedule add "<name>" --kind agent --every 1d --objective "<text>" [--engine ollama] [--ceiling L1] [--mode run]
```

| Command | Purpose |
| --- | --- |
| `run` | Execute one objective or mission unattended; `--dry-run` shows engine, command and prompt and runs nothing |
| `runner status`, `list`, `show` | Inspect runs: `queued`, `running`, `completed`, `awaiting-approval`, `failed`, `refused`, `dry-run` |
| `runner resume` | Continue a run parked at `awaiting-approval` once the owner decided the approval |
| `runner drain` | Process the queue in this terminal (the daemon does it every `runner.poll_interval`) |
| `runner engines` | Report whether `claude`, `codex`, `ollama` and `mock` are installed, reachable and allowed, and why not |
| `runner enable-signal-runs` | Opt in once to the `run-agent` hook reaction (off by default) |
| `schedule add --kind agent` | A scheduled job that queues an objective for the runner (or runs it inside the tick with `--mode run`) |

## Daemon (3.0)

```bash
astack daemon start [--foreground]
astack daemon status | stop [--timeout 20000] | logs [--lines 50]
astack daemon install-service [--dry-run] [--platform win32|darwin|linux]
astack daemon service-status | uninstall-service [--dry-run]
```

| Command | Purpose |
| --- | --- |
| `daemon start` | One detached process supervising every installed `<engine>/service.mjs` with crash restart; `--foreground` is what the OS service runs |
| `daemon status`, `stop`, `logs` | Services and restarts, graceful stop, last lines of `.astack/daemon/daemon.log` |
| `daemon install-service` | Start the daemon at logon: Windows Task Scheduler, macOS launchd, Linux systemd `--user`; `--dry-run` prints the exact plan |
| `daemon service-status`, `uninstall-service` | Inspect or remove that service |

## Owner gateway (3.0)

```bash
astack gateway status [--json]
astack gateway test <channel>
astack gateway send --to owner --text "<text>" [--channel <c>] [--file <path>] [--yes]
astack gateway poll --once [--channel <c>]
astack gateway serve
astack gateway owners
astack gateway owner add|remove <channel> <id> [--group]
astack gateway voice setup [--yes] | status | test <file> [--language fa]
astack gateway whatsapp setup [--dry-run] | pair | start | stop | status
```

| Command | Purpose |
| --- | --- |
| `gateway status`, `test` | Channel state, owners and voice; one read-only health call to a channel |
| `gateway send` | Notify every owner account; without `--yes` it only previews |
| `gateway poll`, `serve` | Process inbound messages once, or run the gateway service in this terminal when the daemon is not used |
| `gateway owners`, `owner` | Allowlist owner accounts and groups in `.astack/gateway/owners.json`, which keeps real ids out of the config |
| `gateway voice` | Detect (or with `--yes` install) faster-whisper for local Persian voice notes; transcribe a test file |
| `gateway whatsapp` | Install, pair (QR code), start and stop the linked-device bridge |

Channels: `telegram`, `whatsapp-wapi`, `whatsapp-bridge`, `whatsapp-cloud`, `cli`.

## Aramin console (3.0)

```bash
astack console open
astack console start [--port 7717] [--host <addr>] [--open]
astack console token [--rotate]
astack console status
```

| Command | Purpose |
| --- | --- |
| `console open` | While a console runs (in the daemon or `console start`), open the browser already signed in with a one-time ticket (one login, one minute) |
| `console start` | Run the console in this terminal on `http://127.0.0.1:7717`; `--open` also opens the browser signed in |
| `console token` | Print the owner token for the sign-in screen; `--rotate` makes a new one and signs every device out |
| `console status` | Whether a console is running, its address, how many devices are signed in, the internet listener (3.1) and the console users |

### Console users (3.1)

```bash
astack console user set <username>           # create or change the password (hidden prompt, or stdin)
astack console user totp <username>          # turn on two-factor sign-in; prints the key and the otpauth:// URI
astack console user totp <username> --disable
astack console user list
astack console user remove <username>
```

The password is read from a hidden prompt (asked twice on a terminal) or from
stdin (`"..." | astack console user set ali`; a PowerShell byte-order mark is
stripped). Only an scrypt hash is stored, in `.astack/console/users.json`.
`totp` prints a base32 key and an `otpauth://totp/...` URI for an
authenticator app; from then on every password sign-in needs the 6-digit code.
The internet listener (`console.remote`) starts only when a user has TOTP on.

## Search (3.0)

```bash
astack search "<query>" [--source memory,sessions,reports,skills,missions] [--k 10] [--semantic auto|on|off]
                        [--as-of <date>] [--include-superseded] [--budget <tokens>] [--json]
astack search reindex [--source a,b] [--force] [--semantic off] [--sessions-root <path,...>] [--embed-limit <n>]
astack search status [--json]
astack search owner-profile [--budget 900] [--summarise] [--json]
```

| Command | Purpose |
| --- | --- |
| `search "<query>"` | Recall across sources within a token budget: BM25, plus embeddings when Ollama answers |
| `search reindex` | Incremental index build; the first run builds everything |
| `search status` | Backend (SQLite FTS5 or the JSON fallback), counts and semantic state |
| `search owner-profile` | Deterministic owner profile from identity, preference and decision memories and recent sessions |

## Skill hub (3.0)

```bash
astack skill pack list
astack skill pack search "<query>" [--pack <name>] [--limit 8] [--raw]
astack skill pack show <pack>/<skill-id>
astack skill pack import <source> --pack <name> [--path a,b] [--dry-run]
astack skill pack scan <pack> | remove <pack> | updates
astack skill catalog --packs
astack skill search "<query>" --packs
astack skill curate [--apply] [--source builtin|learned|pack] [--all] [--limit 60]
astack skill online search "<query>" [--source all|skillssh|skillsmp|clawhub|github] [--limit 10] [--refresh] [--json]
astack skill online show <source>:<id> [--json]
astack skill online get <source>:<id> [--pack online] [--dry-run] [--json]
astack skill online status
```

| Command | Purpose |
| --- | --- |
| `skill pack list`, `search`, `show` | Browse auxiliary packs and a skill's scan findings; `--raw` also lists high-risk skills |
| `skill pack import` | Import `SKILL.md` skills from a folder, a git URL or `owner/repo[/path][#ref]`; scanned, never executed |
| `skill pack scan`, `remove`, `updates` | Re-scan, move a pack to the trash, compare git-sourced packs with upstream |
| `skill catalog --packs`, `skill search --packs` | Include pack skills below built-in and learned ones; without `--packs` the output is unchanged |
| `skill curate` | Keep / refine / retire report; changes only with `--apply`, never deletes a file |
| `skill online search` (3.2) | Search skills.sh, SkillsMP, ClawHub and GitHub when no local skill fits; de-duplicated, ranked, cached; a failing registry is reported, not fatal |
| `skill online show` (3.2) | Fetch one result to a temporary folder, print its `SKILL.md` and scan, delete it |
| `skill online get` (3.2) | Import one result into `skill-packs/<pack>/` (default `online`) through the importer and scanner; blocked → refused, high risk → flagged; exit code 2 when refused |

## Board, sandbox, vault and A2A (3.0)

```bash
astack board create "<title>" [--describe "<text>"] [--max-parallel 2] [--max-retries 2] [--ceiling L1]
astack board list | show <board>
astack board add <board> "<objective>" --assignee agent:<id>|team:<id> [--depends C-1,C-2] [--review --reviewer agent:<id>]
                 [--max-retries <n>] [--project <id> --item <id>] [--mission <id>]
astack board run [<board> ...] [--once]
astack board steer <card> "<note>" | retry <card> | cancel <card|board> [--reason "<text>"]

astack sandbox status | images
astack sandbox require "<pattern>"
astack sandbox exec [--image <i>] [--mount src:dst[:rw],...] [--network none] [--workdir <dir>] [--timeout <ms>] [--memory 512m] [--cpus 1] -- <command> [args]

astack secret vault status
astack secret vault set credential://<provider>/<name> [--backend windows|macos|linux|bitwarden|1password] [--item <id>]
astack secret vault test <ref> | remove <ref> [--keep-reference]

astack a2a status | card
astack a2a serve [--host 127.0.0.1] [--port 41241]
```

| Command | Purpose |
| --- | --- |
| `board ...` | Durable multi-agent kanban executed through the runner: dependencies, retries, reviewer lane, steering; `run` without a board runs every active board |
| `sandbox status`, `images`, `exec` | Docker availability and isolated execution (no network, read-only root, secrets hidden) |
| `sandbox require` | Route matching shell commands into the sandbox (automation policy `sandbox.required_for`) |
| `secret vault ...` | Keep a credential in the OS vault; the value comes from a pipe or a hidden prompt, never from argv |
| `a2a status`, `card`, `serve` | Agent-to-Agent endpoint: state, the public agent card, and the loopback JSON-RPC server |

## Existing surface (unchanged)

```bash
astack doctor [--verbose] | init | install | upgrade [--check] [--from <path>]
astack review "<request>"
astack domain list|detect  astack team ...  astack agent ...  astack lead ...
astack project ...  astack workflow  astack provider  astack plugin  astack knowledge  astack backup
```
