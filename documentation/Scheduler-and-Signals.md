# Scheduler and Signals

Two ways work starts without a conversation.

## Scheduled jobs

```bash
astack schedule add "watch the portal" --kind http-check --every 10m \
  --url https://portal.example.gov/health --expectStatus 200 --maxLatency 2000
astack schedule list
astack schedule show watch-the-portal
astack schedule tick          # run everything that is due
astack schedule watch         # keep a supervisor loop alive
astack schedule status
astack schedule incidents
```

### Job kinds

| Kind | Purpose |
| --- | --- |
| http-check | watch a web service: status, latency, body assertions, JSON path |
| command | run an allowlisted command |
| agent-missions | dispatch due agent missions |
| context-refresh | rebuild the workspace index |
| learning-mine | forge skills from repeated work |
| memory-consolidate | merge, decay and compact memory |
| project-digest | report open project health |
| signal-process | process the inbound hook queue |
| browser-task | run a browser flow and capture evidence |
| heartbeat | liveness |

### Reliability

Schedules accept `--every 10m`, `--cron "*/10 * * * *"` or `--at <iso>`.
Failures retry with exponential backoff. Repeated failures open an incident and
can assign an agent; the first success closes it. Every run is logged with its
duration, metrics and summary. `astack schedule defaults` installs the platform's
own maintenance jobs.

## Inbound signals

One webhook URL can be registered in any external tool — a WhatsApp gateway, a
monitoring system, a portal notifier, a form:

```bash
astack signal create "whatsapp inbox" --source whatsapp \
  --mapping '{"text":"message.text","from":"message.from"}'
# endpoint: http://127.0.0.1:8787/hooks/whatsapp-inbox?token=...
# signing secret is shown once

astack signal rule whatsapp-inbox --contains "پرونده,دادگاه" \
  --then '[{"action":"create-mission","params":{"title":"پیگیری: {text}"}}]'

astack signal serve --port 8787
```

### Verification

Requests are checked for the shared token or an HMAC-SHA256 signature over the
raw body, a timestamp window, a replay nonce, a size cap and a per address rate
limit. A failed check is refused and logged.

### Normalization and reactions

Every payload becomes one event shape: source, sender, subject, text, domain,
attachments, trust. Message text is sanitized as untrusted content. Rules then
match on content, sender, domain or a regular expression, and run reactions:

notify, memory-append, record-episode, create-mission, assign-agent, run-job,
create-work-item, browser-task, open-incident, reply.

Reactions are checked against the automation policy, so an inbound message can
never do more than the owner allowed that hook to do.

### Offline mode

When the external tool cannot reach a local port, feed the hook from the CLI or
a relay:

```bash
astack signal emit whatsapp-inbox --payload '{"message":{"text":"...","from":"..."}}'
astack signal process
```
