# Browser Operator

AStack drives a real Chromium profile through the DevTools protocol. There is no
browser automation dependency: the operator speaks CDP over the WebSocket that
ships with Node.

## Persistent profiles

A profile is a real browser profile directory under
`.astack/browser/profiles/<id>`. The owner signs in once in a visible window and
every later automated run reuses that session:

```bash
astack browser profile create owner
astack browser login owner --url https://portal.example.gov
astack browser health owner
```

Cookies are snapshotted for session health and for authenticated scheduled
checks. They live inside `.astack`, are never printed by any command and never
enter a prompt.

## Flows

A flow is a list of steps. Each step declares an authority level:

| Steps | Authority |
| --- | --- |
| goto, wait, waitFor, extract, screenshot, pdf, scroll, assert, cookies | L1 |
| fill, type, select, check, click, upload | L3 |
| submit, confirm, pay, delete, approve | L4 |

```bash
astack browser run --profile owner --url https://portal.example.gov \
  --steps '[{"action":"fill","selector":"#period","value":"Q1-2026"},
            {"action":"fill","selector":"#amount","value":"8250"},
            {"action":"click","selector":"#validate"},
            {"action":"assert","textContains":"validated"},
            {"action":"submit","selector":"#send"}]' \
  --evidence vat-q1 --mission M-vat-q1
```

The run stops before `submit`, captures the state as evidence and returns a
resumable checkpoint. After the owner approves:

```bash
astack browser resume M-vat-q1
```

Execution continues from the same point; it never replays the earlier steps.

## Evidence

Every screenshot, PDF and download is hashed and chained to the previous entry:

```bash
astack browser evidence vat-q1
astack browser evidence verify vat-q1
```

A broken chain or an altered file is detected, which is what makes a bundle
usable in front of a counterparty or an auditor.

## Untrusted content

Page text is data. Extractions are returned in an envelope marked
`untrusted: true`, scanned for instruction shaped content and quarantined when
found. A page saying "ignore previous instructions" changes nothing.

## Requirements and limits

- Needs Chrome, Edge, Brave or Chromium installed, or `ASTACK_BROWSER_PATH`.
- Needs Node 22 or newer, because the DevTools connection uses the global `WebSocket` that Node
  ships from that version. Everything else in AStack runs on Node 20; `astack browser status`
  says which of the two is missing before anything is attempted.
- `astack browser status` reports the driver honestly; with no browser the
  operator refuses to run instead of pretending.
- Selector based automation. When a site changes, the failure is recorded as a
  guardrail and the related skill is marked for update.
- Run `npm run test:browser` for the end to end check against a real browser.
