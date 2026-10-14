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

A signed-in browser stays signed in for `console.session_days` (30 days).
`astack console token --rotate` signs every device out.

**Install it as an app (PWA).** In Chrome or Edge, use the install icon in the
address bar (or the menu's "Install Aramin"); on a phone, "Add to Home screen".
The installed app opens in its own window with the same session. Settings →
install shows the same option inside Aramin.

**Phone or another computer.** The console listens on `127.0.0.1` only. Reach it
from elsewhere only through a tunnel or reverse proxy that you control and that
serves HTTPS (installing as an app on a phone needs HTTPS too):

- keep the console on loopback, point the tunnel at `127.0.0.1:7717`, and add
  the tunnel's host name to `console.allowed_hosts` so the Host-header check
  accepts it; or
- bind another address deliberately: `console.allow_remote: true` with
  `console.host` for the daemon, or `astack console start --host <addr>` by hand
  (a warning is printed).

Then sign in on the phone with the token (option 3). Never expose the console
on a public address without HTTPS in front of it.

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
| تنظیمات / Settings | theme (light/dark/system), language, device notifications, install, sign out | — |

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
  Failed logins are limited to ten per address per minute.
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
| POST | `/api/login` | `{ token }` or `{ ticket }` |
| POST | `/api/logout` | |
| GET | `/api/home`, `/api/counts`, `/api/notifications` | |
| GET | `/api/approvals?state=pending\|all`, `/api/approvals/:id` | |
| POST | `/api/approvals/:id/decide` | `{ decision: "approve"\|"deny", confirm?, note? }` |
| GET | `/api/missions?state=`, `/api/missions/:id` | |
| POST | `/api/missions/:id/pause\|resume\|cancel` | `{ reason? }` |
| GET | `/api/runs`, `/api/runs/:id` | |
| POST | `/api/runs` | `{ objective, dryRun: true }` then `{ objective, dryRun: false, previewId }` |
| GET | `/api/jobs`, `/api/hooks` | |
| POST | `/api/jobs/:id/run` | safe kinds only |
| GET | `/api/audit?action=&risk=&month=&q=&page=&size=` | |
| GET | `/api/memory?q=&facet=`, `/api/memory/entity?q=`, `/api/memory/stats` | |
| GET | `/api/skills?q=&source=`, `/api/skills/:id` | |
| GET | `/api/board`, `/api/gateway`, `/api/system`, `/api/search?q=` | |
| GET | `/api/events` | Server-Sent Events |

## Configuration

All optional (see the commented `console:` block in `astack.config.yaml`):
`enabled`, `host`, `port` (7717), `allow_remote`, `allowed_hosts`,
`poll_interval` (3s), `session_days` (30), `locale` (`fa`).

## Files

`console/server.mjs` (HTTP, auth, CSP, static, routing), `console/api.mjs`
(runtime adapters and owner decisions), `console/auth.mjs` (token, sessions,
CSRF, tickets), `console/events.mjs` (SSE hub and poller),
`console/service.mjs` (daemon contract), `console/cli.mjs`
(`astack console`), `console/public/` (the app). Tests:
`tests/verify-console.mjs`.
