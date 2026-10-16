# Pass 1: critical

Highest severity. Cite file:line and the fix for each finding.

## SQL and data safety
- String interpolation or concatenation into SQL, even of "numeric" values. Use
  bindings (`?`, named parameters, query builder). Column or sort names from input
  need an allowlist; bindings do not protect identifiers.
- Check-then-act (TOCTOU) that should be one atomic `UPDATE ... WHERE`.
- Writes that bypass model validation or events (raw update, `saveQuietly`,
  `update_column`, bulk `update()`), when the skipped rule matters.
- N+1: an association read inside a loop or view without eager loading.

## Races and concurrency
- Read-check-write or find-or-create without a unique index, or without catching
  the duplicate-key error and retrying.
- Status transitions not done as `UPDATE ... SET new WHERE id = ? AND status = old`;
  two workers can skip or double-apply them.
- Jobs or webhooks that are not idempotent while the transport retries.
- Unsafe HTML rendering of user data (`{!! !!}`, `dangerouslySetInnerHTML`,
  `v-html`, `innerHTML`).

## LLM output trust boundary
- Model output (emails, URLs, names, JSON) persisted or mailed without format and
  shape validation.
- Model-supplied URLs fetched without an allowlist (SSRF to internal hosts).
- Model output stored in memory, knowledge bases or vector stores without
  sanitising (stored prompt injection). Model output executed (`eval`, shell).

## Command injection
- `exec`, `execSync`, `shell_exec`, `system`, `proc_open`, `subprocess(..., shell=True)`
  with interpolated input. Use argument arrays (`execFile`, `spawn` with args,
  `Process::run([...])`).

## Enum and value completeness
When the diff adds an enum value, status, role, type constant, or widens what an
input accepts (new MIME type, flag, looser validator):
- Read (not just grep) every consumer that switches on, filters by or displays the
  value. A consumer that falls through to a wrong default is the finding; it is
  usually outside the diff.
- Find allowlists holding sibling values and confirm the new one is there.

## Sideways sweep (every finding)
A finding is a defect class, not a line.
- **Siblings:** grep the same pattern at every other entry point (routes, CLI
  commands, jobs, webhooks, cron, hooks). Rate on the worst one; list all under
  one finding.
- **Forced critical:** data loss, a trust-boundary bypass (auth, tenancy,
  signature, consent, redaction skipped) and uncapped spend (a paid call, retry
  or loop with no cap) are CRITICAL and are never downgraded.
- **New cache in front of a guarded call:** name each check a cache hit skips
  (auth, quota, rate limit, tenant). Skipping one is a bypass.
- **Static to dynamic import:** list the side effects no longer loaded at start
  (registrations, route tables, schema setup).
- **Parity claims:** a changed function with a declared twin (mirrored helper,
  parity test) whose twin was left unchanged.
