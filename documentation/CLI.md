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
astack schedule policy [allow-command <cmd> | allow-host <host>]
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

## Code graph (Graphify)

```bash
astack graphify status | setup [--no-hooks] [--no-build] | upgrade | build [--force] | benchmark
astack graphify query "<question>" [--budget N] | explain "<node>" | path "<A>" "<B>" | affected "<node>"
```

## Existing surface (unchanged)

```bash
astack doctor [--verbose] | init | install | upgrade [--check] [--from <path>]
astack review "<request>"
astack domain list|detect  astack team ...  astack agent ...  astack lead ...
astack project ...  astack workflow  astack provider  astack plugin  astack knowledge  astack backup
```
