# Runner and Daemon

AStack 2.5 plans work and writes work orders, but a work order only moves when
a Claude Code or Codex session is open to read it. The runner and the daemon
make AStack always-on: scheduled jobs, inbound signals and missions keep
running while nobody is at the keyboard, inside the same trust model.

## Runner (`runner-engine/`, `runtime.runner`)

```bash
astack run "summarize yesterday's signals"            # auto engine
astack run "fix the failing export test" --engine claude --model haiku --budget 0.25
astack run "..." --dry-run                            # show engine, command and prompt; run nothing
astack run --mission M-1234abcd                       # run an existing mission
astack run "..." --queue                              # enqueue for the daemon
astack runner list | show <id> | resume <id> | status | drain | engines
```

### Engines

| engine | how it runs | cost |
|--------|-------------|------|
| `claude` | `claude -p --output-format json` with the prompt on stdin; parses `result`, `total_cost_usd`, `session_id` | metered, capped per run with `--max-budget-usd` |
| `codex` | `codex exec --sandbox read-only --output-last-message <file> -` with the prompt on stdin | not reported (recorded as unmetered) |
| `ollama` | `POST http://127.0.0.1:11434/api/chat` (configurable URL and model; default = first installed chat model) | free |
| `mock` | deterministic, for tests | free |
| `auto` | the model router classifies the objective; tier `fast` or cheap background work (summaries, triage, classification) goes to `ollama`, everything else to `claude`; an unavailable engine falls back to the next one and the run says so | |

`astack runner engines` reports what is installed, reachable and allowed.

### What the model receives

The same work order a hosted session receives (`buildWorkOrder` in
`runtime-providers/adapters/hosted-runtime.mjs`): objective, retrieved
context, memory, skills, tool catalog and authority ceiling, built through the
Chief of Staff brief. The runner appends its unattended rules: never perform an
irreversible action, and print
`APPROVAL-REQUEST: <action> | <L3|L4|L5> | <what would happen>` instead. Each
such line becomes a real approval (`astack approval pending`), and the run
parks as `awaiting-approval`.

Inbound content (a signal's message) is sanitized and fenced as data; the
objective always comes from the owner's rule, never from the message.

### Trust

- Spawned engines (`claude`, `codex`) must pass the automation policy:
  `astack schedule policy allow-command claude` once. Until then the engine
  reports `unavailable` and runs are refused.
- The Ollama endpoint is owner configuration. A loopback URL is a local model;
  any other host must pass the network policy.
- Claude runs with `--permission-mode dontAsk`, read-only tools (`Read`,
  `Grep`, `Glob`), only those built-in tools loaded (`--tools`), no MCP
  servers (`--strict-mcp-config`) and no skills (`--disable-slash-commands`)
  unless configured. `bypassPermissions` and codex `danger-full-access` are
  refused.
- The ceiling defaults to the configured autonomous ceiling
  (`astack authority`); a caller may lower it, never raise it.
- Missions run through `runtime.missions` unchanged: a step above the ceiling
  stops at `waiting-approval` exactly as before, and the tool registry still
  verifies and consumes the receipt.
- Every start, finish, refusal and resume is written to the audit log and to
  `.astack/runner/runs.jsonl`; prompts and outputs are kept under
  `.astack/runner/prompts/` and `outputs/`.

### Approvals and resume

```bash
astack approval pending
astack approval approve AP-...       # the owner decides
astack runner resume R-...           # mission: resumes from its step
                                     # free-form: same Claude session (--resume) with the decision
```

A rejected approval ends a free-form run as `failed` ("nothing irreversible
was done").

### Budget and concurrency

`runner.daily_budget_usd` (default 5) and `runner.max_concurrent` (default 1).
A run that would start after today's spend reached the budget, or while all
slots are busy, is `refused` with `refusal: daily-budget | max-concurrent`.
Concurrency is enforced across processes with lock files in
`.astack/runner/active/`.

Claude Code loads its own system prompt before the work order, so even a
one-line task has a fixed cost per session; a first call can exceed a very
small `--max-budget-usd` because the cap is checked after each API turn.
Keep `per_run_budget_usd` comfortably above that floor.

### Statuses

`queued`, `running`, `completed`, `awaiting-approval`, `failed`, plus two
additions to the contract: `refused` (nothing ran: budget, concurrency or no
available engine) and `dry-run` (a preview, never a success).

### Events

`runner.started`, `runner.completed`, `runner.failed`,
`runner.awaiting-approval` (payload: the run summary and the approval ids),
and `runner.queued`.

### Queue and bridges

`runtime.runner.enqueue(...)` + `runtime.runner.drain()`. Queue files are
claimed by an atomic rename, so two drainers never run the same item.

- Scheduler: a new job kind `agent`.
  `astack schedule add "nightly digest" --kind agent --every 1d --objective "..." [--engine ollama] [--ceiling L1] [--mode run]`
  queues the objective (or runs it inside the tick with `--mode run`).
- Signals: a new reaction `run-agent`
  (`--then '[{"action":"run-agent","params":{"objective":"triage this message"}}]'`).
  It is off until the owner opts in once: `astack runner enable-signal-runs`.

## Daemon (`daemon-engine/`)

```bash
astack daemon start               # detached background process
astack daemon start --foreground  # this terminal (what the OS service runs)
astack daemon status | stop | logs [--lines 100]
```

The daemon loads, in order, whichever of these exist (or the list in
`daemon.services`): `runner-engine`, `scheduler-engine`, `signal-engine`,
`gateway-engine`, `search-engine`, `skill-hub`, `console`, `board-engine`
— each `<dir>/service.mjs` exporting
`createService({ runtime, config, log, fail })`.

- `runner-engine`: drains the queue every `runner.poll_interval` (15s).
- `scheduler-engine`: the scheduler tick loop (`scheduler.tick_interval`),
  wrapping `SchedulerDaemon`; it owns the scheduler pid file while running, so
  `astack schedule watch` refuses to start a second loop.
- `signal-engine`: the webhook listener on `signals.server` (127.0.0.1:8787).

A service whose `start()` throws, that calls `fail(error)`, or whose
`status().state` is `crashed` is restarted with exponential backoff
(`restart_backoff_ms`, up to `restart_backoff_max_ms`) and recorded in
`.astack/daemon/events.jsonl` and the audit log. `stop` asks the daemon to shut
down gracefully (stop request file), then terminates it after a timeout. State:
`.astack/daemon/daemon.json` (pid), `state.json` (heartbeat), `daemon.log`.

### Operating-system service

```bash
astack daemon install-service --dry-run     # print exactly what would be created
astack daemon install-service
astack daemon service-status
astack daemon uninstall-service
```

| system | what is created |
|--------|-----------------|
| Windows | Task Scheduler task `AStack Daemon <workspace-id>` from an XML definition: logon trigger, hidden, no time limit, restart every minute on failure, working directory = the workspace; launched through `conhost.exe --headless` so no console window appears (`daemon.windows_launcher: direct` to run node directly) |
| macOS | `~/Library/LaunchAgents/com.astack.daemon.<id>.plist` with `RunAtLoad` and `KeepAlive`, loaded with `launchctl bootstrap gui/<uid>` |
| Linux | `~/.config/systemd/user/astack-daemon-<id>.service` with `Restart=on-failure`, enabled with `systemctl --user enable --now`; run `loginctl enable-linger` yourself to keep it alive after logout |

`--platform win32|darwin|linux` previews another system's plan (always a dry
run).
