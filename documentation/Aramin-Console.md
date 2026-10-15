# Aramin — the AStack console

Aramin (آرامین) is the owner's console for AStack: a local, installable web app
for the decisions and the overview that otherwise live in the CLI. It follows
a native-app admin pattern — a separate, clean app with a bottom tab bar on phones,
a side rail on desktop, a Ctrl/⌘-K command palette, bottom sheets, dark mode and
live notifications. Persian (RTL) is the default; English is one tap away.

It is plain Node.js and vanilla JavaScript: no npm dependency, no build step, no
CDN. The only bundled third-party asset is the Vazirmatn variable font, shipped
unmodified with its SIL Open Font License (`console/public/fonts/OFL.txt`).

## How to sign in

Pick the first line that fits:

1. **The daemon is running** (`astack daemon start`; the console starts with it
   by default):

   ```bash
   astack console open
   ```

   The browser opens on the console already signed in.
2. **No daemon** — run the console in a terminal and let it open the browser:

   ```bash
   astack console start --open
   ```

3. **By hand** — open `http://127.0.0.1:7717`, run `astack console token` in a
   terminal, and paste the token on the sign-in screen.
4. **Username and password** (3.1) — create a user once, and turn on
   two-factor sign-in:

   ```bash
   astack console user set ali      # hidden prompt; only an scrypt hash is kept
   astack console user totp ali     # prints the key and an otpauth:// URI for an authenticator app
   ```

   The sign-in screen then offers "username" and "token" side by side; with
   TOTP on it also asks for the 6-digit code.

A signed-in browser stays signed in for `console.session_days` (30 days), or
until it has been idle for `console.session_idle` when that is set.
`astack console token --rotate` signs every device out; so does Settings →
"Sign out everywhere".

### Sign-in options (3.1)

| Method | Where | Notes |
|---|---|---|
| Owner token | local listener | `console.auth: token` or `both` |
| One-time ticket (`console open`, `start --open`) | local listener, **from this computer only** | the request must come from a loopback peer with no proxy header (`CF-Connecting-IP`, `X-Forwarded-For`, `Forwarded`, …); a ticket through a tunnel is refused |
| Username + password (+ TOTP when on) | local listener | `console.auth: password` or `both` |
| Username + password + TOTP | internet listener | the only method there; TOTP is mandatory |

`console.auth` defaults to `both` once a console user exists, else `token`
(`password` with no user falls back to `token`, so the owner is never locked
out). Passwords are hashed with scrypt (N = 2^15, r = 8, p = 1, a salt per
user); an unknown username costs the same scrypt as a known one. TOTP is RFC
6238 (SHA-1, 30 s, 6 digits, one step of drift) and every code works once.

Every failure answers the same `invalid credentials`, is written to the audit
log (`console-login-failed`, never the secret) and counts against the address
and the username: `console.lockout.attempts` failures (5) within
`console.lockout.minutes` (15) lock both for that long (HTTP 429). The older
ten-per-minute limit per address stays in place.

**Install it as an app (PWA).** In Chrome or Edge, use the install icon in the
address bar (or the menu's "Install Aramin"); on a phone, "Add to Home screen".
The installed app opens in its own window with the same session. Settings →
install shows the same option inside Aramin.

**Phone or another computer.** The console listens on `127.0.0.1` only. Reach it
from elsewhere only through a tunnel or reverse proxy that you control and that
serves HTTPS (installing as an app on a phone needs HTTPS too):

- **from the internet** (a public host name through Cloudflare Tunnel or
  similar): use the separate internet listener, `console.remote` — see
  [Internet exposure](#internet-exposure-31). Port 7717 never answers the
  public host name, even when it is listed in `allowed_hosts`;
- **inside a network you control** (a VPN, a LAN name): keep the console on
  loopback, point the private proxy at `127.0.0.1:7717` and add its host name
  to `console.allowed_hosts`, or bind another address deliberately:
  `console.allow_remote: true` with `console.host` for the daemon, or
  `astack console start --host <addr>` by hand (a warning is printed).

Then sign in on the phone with the token or a console user. Never expose the
console on a public address without HTTPS in front of it.

## Start it

```bash
astack console open             # a console is already running: open the browser signed in
astack console start            # http://127.0.0.1:7717
astack console start --open     # also opens the browser and signs in once
astack console token            # print the owner token (created on first use)
astack console token --rotate   # new token; every device is signed out
astack console status           # running?, address, token and session count
```

Under the AStack daemon the console is the `console` service
(`console/service.mjs`, daemon service contract) and starts with the other
services: by default the daemon loads every installed service, and
`console.enabled: false` keeps it from starting the console. When
`daemon.services` is set, the console starts only if the list includes
`console`.

`astack console open` works across processes: it writes a one-time ticket
(only its SHA-256 hash and expiry) to `.astack/console/tickets.json`, opens
`<console url>/#ticket=<ticket>`, and the running console redeems it once
within a minute. When no console is running it says so and exits with an
error.

## Screens

| Tab / page | What it shows | Writes |
|---|---|---|
| خانه / Home | greeting, pending approvals, active missions, open incidents, background jobs, installed engines, recent audit | — |
| تأییدها / Approvals | every request with its exact action, target, values, authority level, risk, requester, mission and expiry | approve / deny |
| مأموریت‌ها / Missions | list by state, detail with steps, linked approvals, findings, artifacts and the event timeline | pause / resume / cancel |
| حافظه / Memory | faceted recall (or `runtime.search` when installed), entity view over the knowledge graph, facet stats | — |
| اجراها / Runs | `runtime.runner` runs, refused runs with their reason, runner status | start a run (dry run first) |
| کارهای پس‌زمینه / Jobs | scheduler jobs with history, inbound hooks and inbox, incidents | run a safe job now |
| گزارش ممیزی / Audit | the audit log with action, risk and month filters, search and paging | — |
| مهارت‌ها / Skills | built-in, learned and pack skills; skill text in a read-only sheet | — |
| تابلوی کار / Board | `runtime.board` columns and cards | — |
| درگاه پیام / Gateway | `runtime.gateway.status()` | — |
| سیستم / System | versions, doctor counts, optional engines, `*/service.mjs` presence, daemon state (`.astack/daemon/state.json`), runtimes, this console | — |
| تنظیمات / Settings | theme (light/dark/system), language, device notifications, install, account, sign out, sign out everywhere | end every session |
| گفت‌وگوها / Conversations (3.1, first tab) | Claude Code sessions of the configured projects: list, read, continue, start new | send a message, stop, allow/deny a tool |

Optional engines are feature-detected on every request (`runtime.runner`,
`runtime.gateway`, `runtime.search`, `runtime.skillHub`, `runtime.board`,
`runtime.sandbox`, `runtime.daemon`). A missing one shows a "not installed"
card; nothing breaks.

## Trust model

Aramin adds no new authority. Every write is an owner decision that goes through
the engine the CLI already uses, with the actor `owner@console`:

- **Approve / deny** call `runtime.approvals.approve|reject`; the receipt
  (`RC-…`) is the engine's own and is shown after the decision. An approval is
  *irreversible* when its level is L4 or higher or its action is a send, pay,
  submit, delete, publish (and similar) verb; then the owner must type the last
  four characters of the request id. The server checks the code — the button
  state alone is never trusted.
- **Pause / resume / cancel** call `runtime.missions`. Resume continues the run
  like `astack mission resume`, so every step still passes the tool registry,
  the authority ceiling and the approval gate.
- **Runs** call `runtime.runner.execute` with `source: "console"`. A real run is
  accepted only for an objective that was previewed with a dry run in the same
  session within fifteen minutes; one preview authorizes one run.
- **Run now** is limited to jobs that only read, refresh or tidy
  (`http-check`, `heartbeat`, `context-refresh`, `learning-mine`,
  `memory-consolidate`, `project-digest`, `signal-process`). `command` and
  `browser-task` jobs run from the CLI only.
- Pause, resume, cancel, run-now, console runs and logins are written to the
  audit log in addition to what the engines record.

Values are shown exactly, except that anything shaped like a secret is masked;
`credential://` references are shown and never resolved. Hook secrets and
tokens never leave the server. Inbound text (messages, memory, skill files) is
rendered escaped and is never interpreted.

## Conversations (3.1)

The first tab (bottom tab on phones, first rail item on desktop) lists and
drives Claude Code sessions, like the sessions panel of Claude Code in VS Code.

**List.** Transcripts are read from `~/.claude/projects/<slug>/*.jsonl` (or
`CLAUDE_CONFIG_DIR`) for every folder in `console.chats.projects` (default:
this workspace). The slug is Claude Code's own rule — every character that is
not a letter or digit becomes `-` (`C:\Projects\shop` → `C--Projects-shop`);
`c--…` and `C--…` both match, and on Windows the whole name is compared
without case. Sessions are grouped by project, newest first, with a title (the
owner's `/rename` title, a `summary` entry, Claude Code's generated title, or
else the first real user message), the last activity (DD/MM/YYYY HH:mm), the
message count and the git branch. Sidechain transcripts and old-style
`agent-*.jsonl` files stay out of the list; a session's sub-agents
(`<session>/subagents/*.jsonl`) open read-only from the conversation. Search
filters titles; pages hold 30.

**Reading.** User and assistant text is rendered as safe markdown — everything
is escaped first, then headings, lists, quotes, tables, links (http/https
only), inline code and fenced code blocks (with a copy button) are recognised;
no raw HTML survives. Each block picks its direction from its first strong
letter (Persian is right-to-left). Tool calls become one-line chips (tool name
and a short target) that expand to a redacted preview of the input and the
result. Thinking blocks, meta entries and injected tags (`<system-reminder>`,
IDE file/selection tags, command wrappers, task notifications) are left out.
The last 12 turns load first; "earlier messages" loads 12 more. Everything
that leaves the server passes `redactSecretsStrict` (provider keys, URL
credentials, card numbers, IBANs, Persian and English credential phrases,
opaque tokens).

**Continuing and starting.** The composer sends with Enter (Shift+Enter for a
new line) on desktop and with the send button on phones. A message spawns
Claude Code headless in the session's project folder through the runner's
spawn rules (Windows npm shims unwrapped, no shell, nothing on argv but
flags):

```text
claude -p --resume <session id> | --session-id <new uuid>
       --output-format stream-json --verbose --include-partial-messages
       --permission-mode default --strict-mcp-config --mcp-config <turn file>
       --permission-prompt-tool mcp__astack__permission_prompt
       --disallowedTools <console.chats.disallowed_tools + the runner's mandatory .astack/** and approval denies
                          + the console/vault/gateway state denies (3.1.1)>
       --allowedTools Read Grep Glob [--max-budget-usd <what is left today>]
```

The prompt goes to stdin. Events stream to the browser over `/api/events`
(`chat` events: start, partial text, assistant text, tool, tool result,
permission, done with cost and duration). One turn per session runs at a
time (a second message gets 409); Stop ends the process tree (`taskkill /T`
on Windows, the process group elsewhere). A new conversation picks a project
and starts with `--session-id <uuid>`; it appears in the list as soon as
Claude Code writes its transcript. Since 3.1.1 the Claude Code child runs with
`ASTACK_UNATTENDED=1`, like a runner child: it and everything it starts can
request approvals but never decide one, and `astack console token` and
`astack console user set|remove|totp` refuse to run there. Decisions are made
by the console server process (which is not unattended): the MCP permission
server only records the request and waits. The mandatory denies always
apply, so a conversation cannot write `.astack/**` or run `astack approval`.
The binary must pass the automation policy (`astack schedule policy
allow-command claude`), like the runner's.

**State denies (3.1.1).** Every turn, local or remote, also gets
`CHAT_STATE_DENIES` (`console/chats.mjs`):
`Read(//**/.astack/{console,vault,gateway}/**)` and the matching `Edit(…)`
rules (plus the same patterns relative to the project), `Edit(//**/.astack/**)`
(the workspace may sit outside the project folder),
`Bash(*.astack/{console,vault,gateway}*)`, `Bash(*astack* console*)`,
`Bash(*astack.mjs* console*)` and the PowerShell equivalents. The syntax
follows Claude Code 2.1.x's permission rules: file access is checked against
`Read(path)` and `Edit(path)` only — a `Read` deny also covers Grep and
Glob (best effort) and blocks Edit and Write on the same path, an `Edit` deny
covers every editing tool — while `Write(…)`, `Grep(…)` and `Glob(…)` path
rules are accepted but never consulted, so they are not used. `//` anchors at
the filesystem root (`//**` spans every drive on Windows, whose paths are
matched as `/c/...`); `*` in a Bash or PowerShell rule matches any text.
Permission rules match what Claude writes; they are not an OS sandbox (a
script that opens files itself is not covered), which is why the
unattended environment and the server-side checks stay in place as well.

**Permissions.** With `permission_mode: default`, every tool use outside
`console.chats.allowed_tools` (default `Read,Grep,Glob`) is sent to
`mcp__astack__permission_prompt`: the astack MCP server (started for the turn
with `ASTACK_UNATTENDED=1`, so it can ask but never decide) records an
approval with action `claude.tool`, the tool, a redacted input preview and
`requestedBy: console-chat:<session>`, and waits. The approval shows in the
conversation as an inline Allow / Deny card, in Approvals, as a console
notification and — through `runtime.gateway.notify` — on the owner's phone.
The answer goes through the same approvals engine (`owner@console`); an
irreversible-looking request (`git push`, `deploy`, …) needs the typed code.
Claude Code receives `{"behavior":"allow","updatedInput":…}` (the exact input
that was shown) or `{"behavior":"deny","message":…}`; an approval is consumed
by the one tool use it allowed. An unanswered request expires after
`approval_timeout_minutes` (10) and is a deny; when a turn ends, its open
cards are denied. `bypassPermissions` (and `--dangerously-skip-permissions`)
is never used.

**Budget.** Every turn's cost is appended to `.astack/console/chats/ledger.jsonl`;
the list shows today's total. With `console.chats.daily_budget_usd` set, a turn
is refused once the day's spend reaches it and otherwise gets
`--max-budget-usd` for what is left.

## Internet exposure (3.1)

The console has a second, optional listener for a tunnel such as Cloudflare
Tunnel. Port 7717 stays exactly as before and keeps refusing the public host
name; the tunnel points at the internet listener instead:

```yaml
console:
  remote:
    enabled: true
    host: 127.0.0.1          # loopback only: cloudflared runs on this machine
    port: 7718
    hostname: console.example.com
    runner: false            # 3.1.1: true allows real runs and "run now" (with a step-up code)
    access:                  # 3.1.1: required — the listener does not start without team and aud
      team: example          # example.cloudflareaccess.com
      aud: <application AUD tag>
      emails: [owner@example.com]   # 3.1.1: optional allowlist of Access identities
```

```yaml
# cloudflared config.yml (locally managed tunnel)
tunnel: <tunnel id>
credentials-file: <path to the tunnel's credentials JSON>
ingress:
  - hostname: console.example.com
    service: http://127.0.0.1:7718      # the internet listener, never 7717
    originRequest:
      access:                           # cloudflared itself rejects requests without a valid Access token
        required: true
        teamName: example
        audTag:
          - <application AUD tag>
  - service: http_status:404            # catch-all: nothing else is served
```

Do not set `httpHostHeader` (or `originServerName`): the listener answers only
`Host: <hostname>`, which cloudflared passes through unchanged. A
dashboard-managed tunnel takes the same settings in its public hostname's
"Additional application settings" (Access: "Protect with Access", the team
name and the AUD tag).

What the internet listener does differently:

- answers only `Host: <hostname>` (anything else: 421) and only on loopback;
- takes the client address from `CF-Connecting-IP` (never on 7717), so the
  lockout applies per real client;
- signs in with username + password + TOTP only — token and one-time-ticket
  sign-in get 403 — and refuses to start (with a clear message in the log
  and in `astack console status`) until a console user has TOTP on and, since
  3.1.1, until `access.team` and `access.aud` are set;
- sessions last at most 12 hours (`session_hours`) and end after
  `idle_minutes` (60) unused; the cookie is `__Host-aramin_sid` with
  `Secure; HttpOnly; SameSite=Strict`; a session belongs to the listener
  that created it;
- every write needs the CSRF token and `Origin: https://<hostname>`;
- approving anything irreversible (L4+, or a send/pay/delete/publish…
  verb) asks for a fresh TOTP code as well as the typed confirmation; a
  successful step-up is audited (`console-step-up`, never the code);
- every request (the app shell included) must carry a valid
  `Cf-Access-Jwt-Assertion`: an RS256 JWT checked against
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (keys cached for
  an hour), with `aud`, `iss`, `exp` and `nbf` verified — defence in depth
  next to cloudflared's own enforcement. With `access.emails` set, the JWT's
  `email` claim must be one of them (compared without case); the Access
  identity is written into every login audit record;
- runs: a dry-run preview works; a real run (`dryRun: false`) and "run now"
  on a job are 403 unless `remote.runner: true`, and then need a fresh TOTP
  code (`totp` in the body) as well;
- conversations are closed (`remote.chat: false`: every `/api/chats` call is
  403 and the tab is hidden with a short explanation). Their tool requests
  (`claude.tool` approvals) are left out of the approvals list, detail,
  counts, home screen, search, notifications and the SSE stream (`activity`,
  `notification`, `counts`); approving one is 403, denying one is allowed.
  If `remote.chat: true` is ever set after a further review, internet turns
  get no pre-allowed tools, each tool approval needs a fresh TOTP code, and
  reads/writes of `.env*`, `.astack/**`, `.ssh`, `.claude` and `Z:/**` are
  denied;
- 4xx/5xx answers carry a generic text (`forbidden`, `not found`, …) and
  never an internal error message; flags the app needs (`stepUpRequired`,
  `remoteRunner`) stay; a malformed `%` escape in a path or cookie is a 400;
- the SSE stream sends a keep-alive comment every 20 seconds (Cloudflare drops
  idle connections after about 100).

The local listener (7717) is never behind a proxy: since 3.1.1 it refuses
(403, `request refused`) any request carrying `CF-Connecting-IP`, `CF-Ray`,
`Cf-Access-Jwt-Assertion`, `Forwarded`, `X-Real-IP` or any `X-Forwarded-*`
header, and it refuses `Host: <remote hostname>` (421) even when
`console.host` is not loopback. A tunnel pointed at the wrong port therefore
gets nothing.

Exposure checklist:

1. `astack console user set <name>` and `astack console user totp <name>`; add
   the key to an authenticator app. On Windows the TOTP secret is kept with
   DPAPI (`vault:windows`); `astack console user list` shows where.
2. Create a Cloudflare Access self-hosted application for the host name: one
   allow policy for your own e-mail, a short session (for example 12 hours),
   and copy the team name and AUD tag into `console.remote.access`; list the
   same e-mail in `console.remote.access.emails`.
3. Configure cloudflared as above: ingress to `http://127.0.0.1:7718` only,
   `originRequest.access.required: true` with `teamName` and `audTag`, no
   `httpHostHeader`, the `http_status:404` catch-all last. Never point the
   tunnel at 7717.
4. Set `console.remote` as above. Keep `remote.chat: false` and
   `remote.runner: false` unless you have decided otherwise; keep
   `allowed_hosts` free of the public name.
5. Restart the console. `astack console status` must show the internet
   listener running with `access: on`; if it is stopped, the line says why.
6. From outside: `https://<hostname>` first shows the Cloudflare Access
   login, then Aramin's sign-in, which needs the authenticator code. On the
   machine, a request straight to `http://127.0.0.1:7718` is refused (421 for
   any other host name, 403 without a valid Access token), and `curl -H "X-Forwarded-For: 1.2.3.4" http://127.0.0.1:7717/api/health`
   gets 403.
7. After any password or TOTP change (`astack console user set|totp`) the
   user's sessions end everywhere; `astack console token --rotate` ends every
   session. Use `logout-all` from Settings if a phone is lost.
8. Optional: `console.session_idle: 12h` for the local listener too.

## Security

- Binds `127.0.0.1` by default. A non-loopback host must be typed with
  `--host` (a warning is printed) or allowed for the daemon with
  `console.allow_remote: true`. Put HTTPS in front of it if you do.
- On loopback the `Host` header must be `127.0.0.1`, `localhost` or `[::1]`
  (plus `console.allowed_hosts`), which closes DNS-rebinding.
- Owner token: 32 random bytes in `.astack/console/token` (mode 0600 where the
  OS supports it). Never logged in full; the start banner shows a masked form.
- Login exchanges the token for a session cookie: `HttpOnly; SameSite=Strict`.
  Only SHA-256 hashes of session ids are written (`.astack/console/sessions.json`).
  Failed logins are limited to ten per address per minute; since 3.1 five
  failures in fifteen minutes also lock the address and the username for
  fifteen minutes (see [Sign-in options](#sign-in-options-31)).
- 3.1: the internet listener adds `Secure` `__Host-` cookies, a 12-hour cap,
  mandatory TOTP, step-up TOTP for irreversible approvals and optional
  Cloudflare Access verification (see [Internet exposure](#internet-exposure-31)).
- 3.1.1: Cloudflare Access is required on the internet listener (with an
  optional e-mail allowlist); the local listener refuses proxy headers and the
  public host name; password sessions are bound to the user's credential
  version (a password or TOTP change, or removing the user, ends them); the
  lockout counters are persisted in `.astack/console/lockouts.json` (SHA-256
  hashes of the keys, expiry times only), so a restart does not reset them;
  new and changed password hashes use scrypt N=2^17 (older hashes still verify
  and are upgraded at the next successful sign-in); TOTP secrets are
  DPAPI-encrypted on Windows (`.astack/vault/console-totp.<user>.dpapi`; a
  plaintext secret from 3.1.0 moves there at the next sign-in) and printed
  only at enrolment; strict redaction also masks labelled base32 secrets.
- Every write needs the session's CSRF token in `x-csrf-token` and a same-origin
  request.
- Strict CSP (`default-src 'self'`, no inline script or style, `frame-ancestors 'none'`),
  `nosniff`, `no-referrer`, `X-Frame-Options: DENY`.
- `--open` and `astack console open` use a one-time ticket in the URL fragment
  (never sent in a request line), valid for one sign-in within a minute.
  `console open` shares it with the running console through
  `.astack/console/tickets.json`, which holds only the ticket's hash and expiry.

## Live updates and notifications

`GET /api/events` is a Server-Sent Events stream. Events emitted on
`runtime.eventBus` in the console's process are forwarded as `activity`; a
light poller (`console.poll_interval`, default `3s`) compares pending approvals,
mission states, runner runs and open incidents, so work started by another
process (CLI, scheduler daemon, gateway) is noticed too. Differences become
`notification` events (new approval, mission or run finished/failed/refused,
new incident) and `counts` updates for the badges. When the owner allows it,
the browser shows a system notification while Aramin is in the background.

## PWA

`manifest.webmanifest` (name and short name "Aramin", Persian description,
standalone, shortcuts to approvals and missions), SVG and PNG icons including a
maskable one, and `sw.js`, which caches the shell for offline start and never
caches or intercepts `/api/*`. The server stamps a content hash of
`console/public/` into the worker, so a changed shell replaces the old cache.

## API (JSON, session required unless noted)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | public, no data |
| GET | `/api/i18n?lang=fa\|en` | public, UI strings from `locales/*.json` → `console` |
| GET | `/api/session` | public; `authenticated`, `csrf`, `features` |
| POST | `/api/login` | `{ token }`, `{ ticket }` (local, this computer only) or `{ username, password, code? }` |
| POST | `/api/logout` | |
| POST | `/api/logout-all` | 3.1: end every session |
| GET | `/api/chats?q=&project=&page=&size=` | 3.1: conversation list, projects, today's spend |
| GET | `/api/chats/:id?before=&turns=&agent=` | 3.1: one conversation (a window of turns; `agent=` a sub-agent) and the running turn |
| POST | `/api/chats` | 3.1: `{ project, prompt }` starts a new session |
| POST | `/api/chats/:id/messages` | 3.1: `{ prompt }` continues a session |
| POST | `/api/chats/:id/stop` | 3.1: stop the running turn |
| GET | `/api/chats/status` | 3.1: running turns and today's spend |
| GET | `/api/home`, `/api/counts`, `/api/notifications` | |
| GET | `/api/approvals?state=pending\|all`, `/api/approvals/:id` | |
| POST | `/api/approvals/:id/decide` | `{ decision: "approve"\|"deny", confirm?, note?, totp? }` (`totp`: the step-up code on the internet listener) |
| GET | `/api/missions?state=`, `/api/missions/:id` | |
| POST | `/api/missions/:id/pause\|resume\|cancel` | `{ reason? }` |
| GET | `/api/runs`, `/api/runs/:id` | |
| POST | `/api/runs` | `{ objective, dryRun: true }` then `{ objective, dryRun: false, previewId }` (internet listener: `remote.runner` and `totp`) |
| GET | `/api/jobs`, `/api/hooks` | |
| POST | `/api/jobs/:id/run` | safe kinds only (internet listener: `remote.runner` and `{ totp }`) |
| GET | `/api/audit?action=&risk=&month=&q=&page=&size=` | |
| GET | `/api/memory?q=&facet=`, `/api/memory/entity?q=`, `/api/memory/stats` | |
| GET | `/api/skills?q=&source=`, `/api/skills/:id` | |
| GET | `/api/board`, `/api/gateway`, `/api/system`, `/api/search?q=` | |
| GET | `/api/events` | Server-Sent Events |

## Configuration

All optional (see the commented `console:` block in `astack.config.yaml`):
`enabled`, `host`, `port` (7717), `allow_remote`, `allowed_hosts`,
`poll_interval` (3s), `session_days` (30), `locale` (`fa`); 3.1 adds `auth`,
`session_idle`, `lockout.attempts|minutes`, `remote.*` (enabled, host, port,
hostname, session_hours, idle_minutes, chat, access.team, access.aud; 3.1.1:
runner, access.emails; 3.1.3: totp) and
`chats.*` (enabled, projects, permission_mode, allowed_tools,
disallowed_tools, tools, approval_timeout_minutes, daily_budget_usd,
max_parallel, model, strict_mcp, partial_messages, command, claude_home).
Write Windows project paths with forward slashes (`C:/Projects/shop`).

### Your own name for the panel (3.1.3)

Aramin is the console's base name. An install can show its own name and
icons without touching the core:

```yaml
console:
  brand:
    name: Gisoo
    name_fa: گیسو
    icons: brand/icons     # optional, relative to the workspace
```

The shell, the installable-app manifest and every UI string use the brand;
the build hash includes it, so an installed app refreshes its cached shell.

### Internet listener without an authenticator (3.1.3)

`console.remote.totp: false` is an owner decision for installs where
Cloudflare Access (always required) is accepted as the first factor: the
internet listener then starts without a TOTP user, signs in with the
password, and asks for the password again (instead of a code) to approve an
irreversible item or start a run. A user who still has TOTP enabled is asked
for the code as before.

## Files

`console/server.mjs` (HTTP, auth, CSP, static, routing), `console/api.mjs`
(runtime adapters and owner decisions), `console/auth.mjs` (token, sessions,
CSRF, tickets), `console/events.mjs` (SSE hub and poller),
`console/service.mjs` (daemon contract), `console/cli.mjs`
(`astack console`), `console/public/` (the app); 3.1: `console/users.mjs`
(users, scrypt, TOTP, lockout), `console/access.mjs` (Cloudflare Access JWT),
`console/chats.mjs` (transcripts and turns), `lib/tool-summary.mjs` and the
permission tool in `interop-engine/mcp-server.mjs`. Tests:
`tests/verify-console.mjs`, `tests/verify-console-chats.mjs`.
