# Board, Sandbox, Vault and A2A (AStack 3.0, P6)

Four additions that make unattended, multi-agent work safer. All are optional:
without their config sections the defaults apply, and nothing existing changes
behaviour.

| Piece | Runtime field | CLI | State |
|-------|---------------|-----|-------|
| Multi-agent board | `runtime.board` | `astack board …` | `.astack/board/` |
| Docker sandbox | `runtime.sandbox` | `astack sandbox …` | `.astack/sandbox/` |
| Vault backends | `runtime.secrets` (new `vault:*` sources) | `astack secret vault …` | `.astack/vault/` (Windows) |
| A2A endpoint | `runtime.a2a` | `astack a2a …` | `.astack/a2a/` |

## Board (`board-engine/`)

A board holds **cards**. A card is one objective for one assignee — an agent
(`agent:<id>`) or a team (`team:<id>`) from the existing agent and team
engines — with dependencies, a retry budget and a durable record of every
attempt.

```
todo → doing → review → done
                  ↘ failed | blocked | cancelled
```

- **Execution** goes through the runner contract: `runtime.runner.execute({ objective, source: "board", missionId, ceiling, engine })`.
  Without a runner a ready card becomes `blocked: runner not installed`; it is
  never faked. Once a runner exists the next run unblocks it.
- **Fan-out**: independent ready cards run in parallel up to `board.max_parallel`
  (default 2). This is executor concurrency, not a WIP policy — the delivery
  engine's project board and WIP limits stay the human plan, and a card can link
  to a work item with `--project <id> --item <id>`.
- **Retries**: a failed attempt is retried up to `max_retries` (default 2) with
  exponential backoff (`backoff_ms` × 2ⁿ, capped by `backoff_max_ms`). After the
  last retry the card is `failed`, `board.card.failed` is emitted, the failure is
  audited and `runtime.gateway.notify({ level: "error" })` is called when a
  gateway is installed. Dependents become `blocked` (dependency failed) and
  unblock when the card is retried.
- **Handoffs**: each attempt stores a structured handoff — `done`, `findings`,
  `artifacts`, `openQuestions`, `nextStep` — parsed from the runner's
  `handoff` field or a JSON block in its output. A dependent card receives its
  dependencies' handoffs as quoted data; instruction-shaped text is
  quarantined. Every attempt also has a transcript at
  `.astack/board/transcripts/<card>/attempt-<n>.json`, scrubbed of resolved
  secrets.
- **Reviewer lane**: `--review` creates an independent reviewer card
  (`--reviewer` must differ from the assignee). The original moves to `review`
  when its work completes and to `done` only when the reviewer explicitly
  answers APPROVED. Anything else — including an ambiguous answer — sends the
  original back with the reviewer's findings as steering; after
  `max_review_rounds` rejections the original fails.
- **Live steering**: `astack board steer <card> "<note>"` appends guidance; the
  next attempt receives each note once.
- **Approvals**: a run that returns `awaiting-approval` blocks the card
  (`blocked: awaiting owner approval: AP-…`); the board polls
  `runtime.runner.get(runId)` and finishes the card when the owner's decision
  completes the run. The board never approves anything.
- **Crash safety**: board files are written atomically; a per-board lock stops
  the daemon and a CLI run from executing the same board twice; an attempt left
  `doing` by a dead process counts as `interrupted` and goes through the retry
  budget.

```bash
astack board create "Quarter close"
astack board add quarter-close "Collect the bank statements" --assignee agent:bookkeeper
astack board add quarter-close "Reconcile the accounts" --depends C-1a2b3c4d --review --reviewer agent:auditor
astack board run quarter-close            # until nothing can move (waits out backoff)
astack board run quarter-close --once     # only what is ready now (what the daemon does)
astack board steer C-5e6f7a8b "Use the corrected opening balance"
astack board retry C-5e6f7a8b
astack board cancel C-5e6f7a8b
astack board show quarter-close
```

The daemon service is `board-engine/service.mjs` (`createService({ runtime, config, log })`);
each tick runs ready cards once on every active board (`board.tick_ms`, default 15 s).

## Sandbox (`sandbox-engine/`)

`runtime.sandbox.exec({ command, args, image, workdir, mounts, network, timeoutMs, memory, cpus, env })`
runs a command in a throwaway container through the Docker CLI:

```
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges
           --pids-limit 128 --memory 512m --cpus 1 --user 65534:65534 --tmpfs /tmp … <image> <argv>
```

- No shell anywhere: the command is an argv, in exec form.
- Mounts are read-only unless `readOnly: false` (or `src:dst:rw`), must be inside
  the workspace unless the owner sets `sandbox.allow_mounts_outside_workspace`
  (a caller cannot widen this), and secrets inside a mounted folder are hidden
  at any depth: every `.astack/`, `.ssh/`, `.claude/`, `.gnupg/` and `.aws/`
  folder becomes an empty tmpfs, every `.env*` file and every `.git/config`
  an empty read-only file. `node_modules` is not scanned; a folder with more
  than 50 000 entries fails closed (mount a narrower folder).
- `env` values reach the container through a temporary `--env-file` (mode
  0600, removed after the run), never the command line; a value with a line
  break is refused.
- The image and the user come only from `sandbox.image` / `sandbox.user`; a
  call naming anything else is denied.
- The routed path (`sandbox.required_for`) mounts only folders inside the
  workspace.
- **The automation policy stays the gate.** A command it denies (deny list, not
  allowlisted, shell control characters) is denied in the sandbox too. One rule
  is relaxed, and only for a fully isolated run (network `none`, nothing
  writable): an interpreter's inline-script flag such as `node -e`, because the
  code cannot reach anything outside the container. Disable with
  `sandbox.allow_inline_eval_when_isolated: false`.
- Every run, allowed or denied, is audited (`sandbox-exec`); output is scrubbed
  of resolved secrets; a run past its timeout is killed with `docker kill`.
- `astack sandbox status` reports whether Docker is installed and whether its
  daemon is running.

**Routing shell commands into the sandbox.** The automation policy accepts an
optional `sandbox.required_for` list (in `.astack/security/automation.json`).
A pattern without a space matches the binary (`npm`, `py*`), one with a space
matches the whole command line (`npm install*`), `*` matches everything. When
it matches, the shell tool and `command` scheduler jobs run the command in the
sandbox with the working directory mounted read-only at `/work` — or fail
closed if the sandbox is unavailable. Unset, nothing changes.

```bash
astack sandbox status
astack sandbox images
astack sandbox exec -- node -e "console.log(1+1)"
astack sandbox exec --mount .:/work -- node scripts/check.mjs
astack sandbox require "npm install*"
```

## Vault backends (`trust-engine/vault.mjs`)

New `source` values for the secret broker. Existing sources (`env`, `file`) and
the existing `astack secret` subcommands are unchanged.

| Source | Store | Status |
|--------|-------|--------|
| `vault:windows` | DPAPI for the current Windows user (PowerShell SecureString, started by its absolute `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` path, never from PATH); ciphertext in `.astack/vault/<provider>.<name>.dpapi` | real, tested on Windows |
| `vault:macos` | login keychain via `security` | adapter-ready (not exercised on a Mac here) |
| `vault:linux` | Secret Service via `secret-tool` | adapter-ready |
| `vault:bitwarden` | `bw get password <item>`, needs `BW_SESSION` | adapter-ready, read only |
| `vault:1password` | `op read <op://…>` | adapter-ready, read only |

Values travel on stdin (never argv), are never printed or logged, and never
touch the disk in plaintext. `astack secret vault status` shows which backends
are real on this machine.

```bash
astack secret vault status
astack secret vault set credential://portal/main                 # hidden prompt, default backend
printf '%s' "$VALUE" | astack secret vault set credential://portal/main --backend windows
astack secret vault set credential://bank/main --backend 1password --item op://Private/Bank/password
astack secret vault test credential://portal/main
astack secret vault remove credential://portal/main
```

**Exfiltration guard** (`trust-engine/redaction.mjs`): every value the broker
resolves is remembered in process memory, and `redactResolvedSecrets(text)` /
`redactResolvedDeep(value)` replace it — plain, base64, URL-encoded or
JSON-escaped — with `[redacted:<reference>]`. The audit engine, board
transcripts, sandbox output and A2A responses use it; other packages can import
it. Values shorter than six characters are not tracked.

## A2A endpoint (`interop-engine/a2a-server.mjs`)

A minimal Agent-to-Agent server. **Implemented subset** of A2A (protocol
version advertised as `1.0`, JSON-RPC 2.0 over HTTP, no streaming):

| Implemented | Not implemented |
|-------------|-----------------|
| `GET /.well-known/agent.json` and `/.well-known/agent-card.json` (agent card) | `message/stream`, `tasks/resubscribe` (SSE) |
| `message/send` (alias `SendMessage`) → Task | push notification configuration |
| `tasks/get` (alias `GetTask`), with `historyLength` | authenticated extended card |
| `tasks/cancel` (alias `CancelTask`) | file parts (text and data parts only), JSON-RPC batches, `ListTasks` |

- **Auth**: `Authorization: Bearer <token>`, the token resolved once at start
  from `credential://a2a/token` through the secret broker and compared in
  constant time. The agent card is public and lists capabilities only — no
  owner data, no learned skills.
- **Loopback by default** (`127.0.0.1:41241/a2a`); binding another address needs
  `a2a.allow_remote: true`.
- **Untrusted input**: a request with instruction-shaped content (English or
  Persian) is refused outright: task state `rejected`, nothing planned or run.
- **Plan only by default.** A request is answered with a plan through
  `runtime.chief.dryRun` unless the owner sets `a2a.execute: true`; only then
  is it handed to `runtime.runner` as a quoted request from an external agent,
  read-only (source `a2a`), under an authority ceiling of `a2a.ceiling`
  (default L1), capped by the owner's default level and never above L3, with
  no automatic pack skills and no past sessions. The agent card offers the
  `execute` skill only when execution is enabled.
- Artifacts, plans and error texts pass the strict pattern redactor and the
  resolved-secret guard.
- A run that needs approval maps to task state `input-required`. A remote
  agent cannot approve; a follow-up message only refreshes the task. Every task
  and every failed authentication is audited.

```bash
astack secret register credential://a2a/token --source vault:windows
astack secret vault set credential://a2a/token
astack a2a status
astack a2a card
astack a2a serve --port 41241
```

## Tests

`node tests/verify-board.mjs` (part of `npm test`): board lifecycle with a fake
runner (retries, backoff, dependency order, parallel limit, reviewer lane,
steering, approval wait, crash recovery, locking, service tick), the sandbox
against a fake Docker binary plus one real `node -e` run when Docker is up
(`ASTACK_SKIP_DOCKER=1` skips it), vault backends through an injected command
runner plus a real DPAPI round trip on Windows, the exfiltration guard, and an
A2A JSON-RPC round trip with bearer auth over HTTP.
