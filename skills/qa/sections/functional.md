# Functional probes: API, CLI, job, webhook

Use the repository's own commands and clients (curl, `php artisan`, `npm run`,
the project CLI, queue tools), not a new harness and not the browser.

## Contract map
For each contract record: source (doc, route, test), setup, exact probe,
expectation, outcome (pass / fail / blocked / not run / inconclusive / n/a + reason).

| Contract | Observe |
| --- | --- |
| Success | expected output and the final business effect, not just a 2xx |
| Invalid or missing input | declared rejection, correct status, no state change |
| Auth | valid, missing, invalid identity; wrong owner or role; no effect when denied |
| CLI process | exit code, stdout and stderr separately; files and state changed |
| State transitions | initial, intermediate, final; only permitted transitions |
| Timeout, cancellation | deadline honoured, partial state, owned work stopped, recovery |
| Retry | attempts and backoff as promised; no unbounded retry |
| Duplicates, idempotency | same request or event twice: number of durable effects |
| Concurrency, order | competing operations in both orders; final invariant holds |
| Partial failure | interrupt after an effect, restart or replay, inspect duplicates and dead letters |

Acceptance, enqueue, processing, retry and final effect are different events;
a 202 is not completion. A missing service that prevents execution makes the
contract blocked, never passed.

## Evidence per probe
Exact command or method, path, headers (secrets by variable name only) and body;
initial and final state; exit or status; stdout and stderr kept apart; runtime
and revision; evidence path. Never mask a failure by piping to `|| true` or
discarding stderr.

## Webhooks and queues
- Replay a captured payload against a local or staging endpoint only.
- Check signature verification by sending one with a wrong signature.
- Send the same event twice; count the durable effects.
- Messaging side effects (email, SMS, WhatsApp) must hit a sandbox or a fake;
  if they would reach a real person, the probe is blocked until the owner decides.

## Modes
Full: every applicable contract in scope. Quick: success plus the highest-risk
changed edge. Regression: replay the previous run's failed probes against the
documented expectation (never against recorded buggy output), then check
changed adjacent behaviour.
