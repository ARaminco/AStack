# Pass 2: informational

Lower severity, still actioned through fix-first.

## Async and blocking
- Synchronous I/O (`readFileSync`, `execSync`, blocking HTTP) inside request
  handlers or async functions on a hot path.
- `sleep` in request code; long work done inline instead of on a queue.

## Field and column names
- Column names in queries checked against the real schema or migration; a wrong
  name returns empty results or a swallowed error.
- Reading a key that the query never selected.

## Conditional side effects
- One branch forgets a side effect the other performs (event, audit, cache bust).
- A log line claims an action that was conditionally skipped.
- Events or notifications emitted only on the happy path.

## Dead code and consistency
- Variables assigned and never read, unused imports, unreachable branches,
  commented-out blocks.
- Comments, docstrings or user-facing strings describing old behaviour.
- Version mismatch between package manifest, CHANGELOG and release title;
  CHANGELOG lines that misdescribe the change.

## LLM prompt issues
- Prompts listing tools that are not wired up; limits stated in two places that
  can drift; 0-indexed lists in prompts.

## Completeness gaps
- A shortcut where the complete version is a short step away: partial enum
  handling, a missing error path, a negative test that mirrors the happy one.

## Time and types
- "Today" keys that assume a 24h window or the server time zone; related
  features using different buckets for the same data.
- Values crossing JSON or PHP/JS boundaries changing type (`"8"` vs `8`) before
  hashing, comparing or caching.

## Frontend
- Inline style blocks re-parsed on every render; O(n*m) lookups in views; in-app
  filtering of rows that should be a `WHERE`.

## CI/CD and distribution
- Workflow changes: tool versions match the project, secrets via the secret
  store, artifacts named and published correctly, publish step re-runnable.

## Documentation drift
- Changed behaviour whose README, `documentation/` page or CLI help was not
  updated. Report the file and the stale statement; `ship` fixes it.
