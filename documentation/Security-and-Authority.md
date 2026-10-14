# Security and Authority

## Authority levels

| Level | Meaning |
| --- | --- |
| L0 | no external action |
| L1 | read and search only |
| L2 | create a draft |
| L3 | modify or fill, never commit |
| L4 | commit only with owner approval |
| L5 | approved autonomous execution |

The **ceiling** is the highest level that may run on its own in a scope.
Anything above it is escalated to the owner, not silently dropped. A level on
the **deny** list is refused outright.

```bash
astack authority show
astack authority default L3
astack authority set domains legal L1
astack authority set sites portal.example.gov L3
astack authority check "submit the return" --level L4 --site portal.example.gov
```

## Automation policy

Background jobs and webhook reactions run unattended, so they are the strictest
surface:

- shell commands are denied unless allowlisted (`node`, `npm`, `git`, `astack`
  by default; `rm`, `curl`, `powershell` and similar are always denied),
- private network targets are denied by default,
- reactions are limited to an allowlist of actions.

```bash
astack schedule policy
astack schedule policy allow-command ffmpeg
astack schedule policy allow-host portal.example.gov
```

## Secret broker

Agents, skills, memories, prompts and logs only ever see a reference:

```bash
astack secret register credential://portal/company-a --site portal.example.gov
# value goes in the environment, never in a file AStack writes
export ASTACK_CRED_PORTAL_COMPANY_A="..."
astack secret check credential://portal/company-a
```

The value is resolved at the moment of use, inside the tool that needs it, and
every resolution is audited with a fingerprint rather than the value.

### Vault backends (3.0)

Instead of an environment variable, a reference can live in the operating
system's vault. The value is read from a pipe or a hidden prompt, travels on
stdin (never argv), and never touches the disk in plaintext:

```bash
astack secret vault status                                  # which backends are real here
astack secret vault set credential://portal/company-a       # hidden prompt, default backend
printf '%s' "$VALUE" | astack secret vault set credential://portal/company-a --backend windows
astack secret vault test credential://portal/company-a
```

`vault:windows` (DPAPI, through the absolute Windows PowerShell path) is real
and tested; `vault:macos`, `vault:linux`, `vault:bitwarden` and
`vault:1password` are adapter-ready (the last two read only). A UTF-8
byte-order mark that Windows PowerShell puts in front of piped input is
stripped before the value is stored. Every value the broker resolves is
remembered in memory and scrubbed — plain, base64, URL-encoded or
JSON-escaped — from audit records, board transcripts, sandbox output and A2A
responses. Details: [Board, Sandbox, Vault and A2A](Board-Sandbox-Vault.md).

## Untrusted content and prompt injection

The trust hierarchy is explicit:

1. system policy,
2. owner instruction,
3. trusted skill instruction,
4. external content — web pages, documents, inbound messages.

External content is data. It is redacted, scanned for instruction shaped
patterns and quarantined before it can reach memory, a skill or another agent.
Nothing in category 4 can raise its own authority.

## Boundaries

- Filesystem access is scoped to the workspace; path escapes are refused.
- Every external action produces an audit record.
- High risk writes require approval by default.
- Dry run is available for missions, browser flows and tool calls.

## Unattended work and remote surfaces (3.0)

3.0 lets AStack act while nobody is at the keyboard and accept requests from a
phone, a browser and other agents. None of it adds authority; these rules keep
it that way.

**Runner: the ceiling is enforced in the tools.**
- The ceiling defaults to the autonomous ceiling; a caller may lower it, never
  raise it.
- At L0–L2, and for every run that is not the owner's own request, Claude gets
  only `Read`, `Grep`, `Glob` with `dontAsk` and Codex the `read-only` sandbox,
  whatever the configuration says. Wider configured tools apply only at L3+ for
  the sources `cli`, `console` and `gateway:*`. `a2a` and `signal:*` runs are
  always read-only.
- `bypassPermissions`, Codex `danger-full-access` and the Codex arguments that
  switch its sandbox or approvals off are refused.
- Spawned engines must pass the automation policy
  (`astack schedule policy allow-command claude`).

**Approval forgery is blocked.** Every Claude run gets mandatory denies that a
custom deny list cannot drop (`Write`/`Edit` on `.astack/**`, any
`astack approval`, any Bash touching `.astack`), and every runner child gets
`ASTACK_UNATTENDED=1`, under which the approval engine,
`astack approval approve|reject|deny` and `astack browser resume` refuse to
decide. A model asks for an irreversible step with an `APPROVAL-REQUEST:` line,
which becomes a normal approval for the owner.

**Gateway approvals.**
- Only allowlisted owner accounts and groups are heard; everyone else is
  ignored and audited. Outbound messages go only to owners and allowlisted
  groups.
- A decision is a message that contains only the word («بفرست», «ارسال کن»,
  «تایید», "approve" / «نه», «رد», "deny") and optionally the code. In a group it
  needs a quote of the prompt or its code. In a private chat a bare word counts
  only when exactly one request is open and its prompt went to that chat within
  `gateway.approval_window_minutes` (30). Forwarded messages are never
  decisions. Voice notes cannot approve unless `gateway.voice.allow_approvals`.
- Every prompt names where the work came from (command line, gateway message,
  external agent, signal, scheduled job, console, board or mission).
- The webhook listener binds loopback unless `gateway.listener.allow_remote`.

**Outsiders stay outsiders.** A2A and signal runs are capped at the owner's
default level (a domain ceiling never raises them), get no automatic pack
skills and no past sessions, and the signal engine passes only the hook's own
`defaults.domain`. A2A refuses injection-shaped requests and is plan-only
unless `a2a.execute: true`; a remote agent can never approve.

**Console.** Loopback by default with a Host-header check, an owner token in
`.astack/console/token`, `HttpOnly; SameSite=Strict` session cookies stored as
hashes, CSRF on every write, a login rate limit, a strict CSP and one-time
sign-in tickets. Irreversible approvals need the last four characters of the
request id typed by the owner, checked by the server.

**Redaction of every new output.** Runner records, prompts and outputs,
gateway messages and A2A artifacts pass the strict pattern redactor —
credential keywords including Persian ones (رمز، پسورد، گذرواژه، کلمه عبور،
کد تایید، کد ورود، توکن), short keywords (pass, pwd, pin, otp, 2fa, cvv),
provider token shapes, card numbers and IBANs — and the resolved-secret guard.
The search index never opens credential-named files and redacts the same
shapes.

**Inbound fence.** Inbound text is quoted inside a random per-run fence; any
fence-shaped marker in the content is removed first, and instruction-shaped
text (English and Persian) is quarantined.

**Sandbox masks.** Every `.astack/`, `.ssh/`, `.claude/`, `.gnupg/` and
`.aws/` folder inside a mount becomes an empty tmpfs, and every `.env*` file and
`.git/config` an empty read-only file, at any depth; image and user come only
from configuration; environment values travel in a temporary env file.

**Skill packs.** Third-party skills are scanned, never executed by the import,
rank below built-in skills, and reach a work order labelled third-party.
High-risk skills are never selected automatically; `hermes/godmode` and
`hermes/obliteratus` are blocked through `skill-packs/hermes/OVERRIDES.json`.

**Known limit.** Approval records are not signed yet. The
`ASTACK_UNATTENDED` gate and the mandatory `.astack/**` denies close the
forgery path for runner children, but a process running as the owner outside
the runner can still append to `.astack/approvals/requests.jsonl` directly.
