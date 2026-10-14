# Gateway — the assistant in your pocket

`gateway-engine/` (exposed as `runtime.gateway`) lets the owner command AStack
from WhatsApp or Telegram, receive its reports, and approve irreversible steps
from the phone. It is part of AStack 3.0 and is off until configured.

```
phone ──► channel adapter ──► allowlist ──► dedup ──► voice → text
                                                  │
              ┌───────────────────────────────────┼─────────────────────┐
         «بفرست» / «نه»                        /command                 anything else
     runtime.approvals (receipt)        /status /pending /runs     runtime.runner.execute
     → resume run / mission             /stop /help                (or chief: plan only)
                                                  │
phone ◄── format (Latin digits, no bidi isolates, no tables, split) ◄── rate limit ◄─┘
```

## Channels

| id | transport | inbound | credentials |
| --- | --- | --- | --- |
| `whatsapp-wapi` | a self-hosted wapi gateway (Whapi-compatible REST) | polling `GET /messages/list` | `credential://wapi/<name>` |
| `whatsapp-bridge` | AStack's own linked-device bridge (Baileys), installed on demand | long poll on a loopback API | random token in `.astack/gateway/bridge/bridge.json` |
| `whatsapp-cloud` | official Meta WhatsApp Business Cloud API | signed webhook on the gateway listener | `credential://whatsapp-cloud/access-token`, `…/app-secret`, `…/verify-token` |
| `telegram` | Telegram Bot API | long polling `getUpdates` | `credential://telegram/bot` |
| `cli` | loopback, for tests and `astack gateway test cli` | in-process | none |

Every adapter implements `configured()`, `health()`, `poll()`, `sendText()`,
`sendFile()`, `downloadVoice()`, `normalizeId()` and `aliases()`; webhook
adapters add `handleVerify()` and `handleWebhook()`.

### whatsapp-wapi
Endpoints used (all with `Authorization: Bearer <channel token>`):
`GET /messages/list?from_me=false&sort=asc&time_from=<unix s>&count=100`,
`POST /messages/text {to, body, quoted}`, `POST /messages/file` (multipart),
`GET /media/{message id}` for voice notes, `GET /health`. The cursor is the
newest timestamp seen; `time_from` is inclusive and the boundary message is
dropped by the gateway's dedup. A private address (`127.0.0.1`, LAN) is refused
by the automation policy until the owner allows private targets deliberately
with `astack schedule policy allow-private` (sets `network.allowPrivateNetworks`
in `.astack/security/automation.json`).

### whatsapp-bridge (linked device)
```bash
astack gateway whatsapp setup     # copies gateway-engine/bridges/whatsapp-baileys to .astack/gateway/bridge/app and npm-installs it there
astack gateway whatsapp pair      # QR in the terminal (also in .astack/gateway/bridge/status.json for the console)
astack gateway whatsapp start|stop|status
```
**Pair a separate bot number, never your personal WhatsApp account.** The
bridge never forwards anything the paired number itself sends, so on a
personal account your own messages would be invisible to AStack anyway, and the
bridge would be reading a private account it has no business reading.

- Pinned dependencies (`@whiskeysockets/baileys 7.0.0-rc13`, `qrcode-terminal 0.12.0`)
  live only in `.astack/gateway/bridge/app/node_modules`; the core stays dependency free.
- Installed with `npm install --ignore-scripts`: no dependency runs code at
  install time. Baileys needs none (`npm view @whiskeysockets/baileys@7.0.0-rc13
  scripts`: its only install hook, `preinstall`, is a Node version check that
  `engines` already states; protobufjs' `postinstall` only concerns its CLI).
- `/send-media` only sends files whose real path lies inside the bridge's
  `outbox/` or `media/` folder; the gateway copies a file into `outbox/`,
  sends it, and deletes the copy. Session credentials can never be sent.
- Session credentials: `.astack/gateway/bridge/auth/` (gitignored with the rest of `.astack/gateway/`).
- Loopback only: binds `127.0.0.1`, rejects non-loopback `Host` headers, and
  requires the shared token header `x-astack-bridge-token`.
- Owner gate: strangers are dropped inside the bridge without storing content;
  in an allowlisted group only owners are heard; sends to anything but an owner
  or allowlisted group are refused with 403.
- LID ↔ phone: allowlists may use a phone number or a LID; aliases are resolved
  from the `lid-mapping-*.json` files Baileys keeps, plus the `participantAlt` /
  `remoteJidAlt` twin Baileys 7 attaches to first contacts.
- Echo tracking: ids of sent messages are remembered (bounded FIFO) so an echo
  is never read back as a command; `fromMe` messages are never forwarded.
- One bridge per session: an exclusive lock file in the bridge directory, and a
  pidfile with a per-start instance id. A process is "ours" only when it answers
  `/health` with our token and that instance id; anything else holding the port
  is reported, never signalled.
- Reconnect with exponential backoff (1 s → 60 s); logged-out sessions stop and
  ask for re-pairing. Sends are serialised on the one socket with a timeout.

### whatsapp-cloud
Set `phone_number_id` (and optionally `waba_id`) in config, register the three
credentials, enable the channel, and expose the listener
(`gateway.listener`, default `127.0.0.1:8788`) through your own TLS tunnel or
reverse proxy. Webhook URL: `https://<your host>/gateway/whatsapp-cloud/webhook`.

- `GET` handshake echoes `hub.challenge` only for `hub.mode=subscribe` and a
  matching `hub.verify_token` (constant time); without a verify token it refuses.
- `POST` checks `X-Hub-Signature-256` over the raw body with the app secret
  (constant time) before parsing; without an app secret it refuses everything.
- Callbacks for another phone number id or WABA are ignored; deliveries are
  acknowledged first and processed afterwards (Meta retries slow answers).
- Meta only accepts free-form messages within 24 hours of the owner's last
  message to the business number; outside that window the send fails with
  Graph error 131047 and the gateway reports it — message the bot once a day,
  or keep Telegram as the notification channel.

### telegram
Create a bot with @BotFather, store its token as `credential://telegram/bot`
(`astack secret vault set credential://telegram/bot` and paste it at the hidden
prompt, or `astack secret register credential://telegram/bot` then set
`ASTACK_CRED_TELEGRAM_BOT`), and list your numeric Telegram user id(s) as owners.
`astack gateway test telegram` calls `getMe`; a `404` there means the token is
wrong (see [Troubleshooting](Troubleshooting.md#gateway)).

## Owners and groups
```yaml
gateway:
  owners:
    telegram:
      - "100000001"     # every listed account is the owner
      - "100000002"
  groups:
    whatsapp-bridge:
      - "120000000000000000@g.us"
```
Keep real ids out of a committed config with
`astack gateway owner add <channel> <id> [--group]` (stored in
`.astack/gateway/owners.json`). An empty list admits nobody.

- Messages from anyone else are ignored and audited (`gateway-ignored`).
- A group is heard only when listed, and then only its owner members; replies go
  to the group. Nothing is ever sent to a non-listed target.
- Notifications and approval requests go to **all** owner accounts on all
  enabled channels (aliases of one person are sent once).

## Requests, commands and approvals
- Any other text becomes `runtime.runner.execute({ objective, source: "gateway:<channel>" })`.
  The authority ceiling is the runner's default; the gateway never raises it.
  Runner statuses `completed`, `awaiting-approval`, `queued`, `failed`,
  `refused` (budget, concurrency, engine) and `dry-run` each get a plain reply.
  Without a runner the gateway answers with the chief of staff's plan and says
  that nothing ran.
- Text that looks like a prompt injection is quarantined and not run.
- Commands: `/status`, `/pending`, `/runs`, `/stop <id>` (pauses a mission —
  reversible), `/help`.
- Approval requests (from the runner, a mission, or anything that calls
  `runtime.approvals.request`) are sent with the exact action, values, level and
  a four-character code. The owner answers by replying to that message, or with
  the code: «بفرست», «ارسال کن», «تایید» / "approve" — or «نه», «رد» / "deny".
  A message is a decision only when nothing but the word (and code) is in it;
  «بفرست به سارا …» is a new request.
- The decision goes through `runtime.approvals` with actor `owner@<channel>` and
  produces the normal receipt, then the run (runner) or mission (mission engine)
  resumes. A second owner account answering an already decided request gets
  «قبلاً تصمیم گرفته شد» with who and when, and nothing happens.
- Several open requests and a bare «بفرست» → the gateway lists the codes and
  decides nothing.
- In a group a decision always needs a reply to the request's message or its
  code; a bare word there decides nothing.
- In a private chat a bare word (no quote, no code) counts only when exactly
  one request is open and its prompt was delivered to that same chat, before
  the reply, within `gateway.approval_window_minutes` (default 30). Otherwise
  the gateway asks for the quote or the code.
- A forwarded message is never a decision (Telegram `forward_origin` and the
  older `forward_*` fields, WhatsApp `contextInfo.isForwarded` /
  `forwardingScore`, wapi and Cloud API `forwarded` flags).
- Every prompt says where the work came from: command line, your gateway
  message, an external agent (A2A), an inbound signal, a scheduled job, the
  console, the board or a mission.
- Everything the gateway sends passes the strict pattern redactor and the
  resolved-secret guard before it is formatted or queued.
- Voice notes cannot approve unless `gateway.voice.allow_approvals: true`.

## Output rules
Plain, short Persian by default (`gateway.language`), one item per line,
Markdown tables flattened to labelled lines, Latin digits, bidi isolates and
overrides (U+2066–U+2069, U+202A–U+202E) stripped, secrets redacted, long output
split into labelled parts, rate limited per channel (`rate_limit_per_minute`,
overflow goes to a persisted outbox), every send checked against the
automation policy (`notify`) and the authority engine (`gateway.send` at
`send_level`, default L2) and audited (`gateway-sent`).

## Voice (local, Persian)
`gateway-engine/voice.mjs` downloads the note and runs
`python -I gateway-engine/scripts/transcribe.py` (faster-whisper, model
`large-v3-turbo`, language `fa`, device auto: CUDA float16 → CPU int8). The
model is loaded per note and released when the process exits.

```bash
astack schedule policy allow-command python   # spawning python is a policy decision
astack gateway voice setup [--yes]           # detect; with --yes: pip install --user faster-whisper
astack gateway voice test <file> [--language fa]
```
GPU use needs the CUDA 12 cuBLAS and cuDNN 9 runtime DLLs on `PATH`
(`pip install nvidia-cublas-cu12 nvidia-cudnn-cu12` is one way); without them
the script falls back to CPU automatically.

## CLI
```bash
astack gateway status [--json]
astack gateway test <channel>                    # read-only health call
astack gateway send --to owner --text "…" [--channel c] [--file f] [--yes]   # preview unless --yes
astack gateway poll --once [--channel c]
astack gateway serve                             # foreground service when the daemon is not installed
astack gateway owners | owner add|remove <channel> <id> [--group]
astack gateway voice setup|status|test <file>
astack gateway whatsapp setup|pair|start|stop|status
```

## Service
`gateway-engine/service.mjs` implements the daemon service contract: one poll
loop per pull channel (long poll for Telegram and the bridge), the webhook
listener for push channels, bridge start/adoption, live approval prompts from
`approval.requested` and `runner.awaiting-approval`, and a sweep that announces
approvals requested in other processes. It does nothing unless
`gateway.enabled: true`. Call `runtime.gateway.bind(runtime)` before using the
gateway outside the service and CLI, so it can reach `runtime.runner`.

The webhook listener binds `127.0.0.1` by default and refuses any other host
unless `gateway.listener.allow_remote: true` is set deliberately (put a TLS
tunnel or reverse proxy in front). Its per-address rate-limit map is bounded,
and a failure answers `500 {"error": "internal error"}` with the detail only in
the log.

## State
`.astack/gateway/`: `state.json` (cursors, seen ids, approval prompts and codes,
outbox, send log — written atomically), `owners.json`, `locks/`, transient
`media/`, and `bridge/` (app, auth, token, pidfile, status, log).

## Credits
The linked-device bridge design and its safety behaviour (owner-message gate,
LID ↔ phone alias resolution, outbound id tracking, reconnect backoff, bridge
ownership by identity, group gating) and the Cloud API webhook verification are
ported from [Hermes Agent](https://github.com/NousResearch/hermes-agent)
(MIT License, © Nous Research), re-implemented for AStack's stricter rules.
