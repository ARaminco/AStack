# Patterns and hypothesis testing

| Pattern | Signature | Where to look |
| --- | --- | --- |
| Race condition | intermittent, timing-dependent, duplicates | shared state, jobs, double submit (`race.md`) |
| Null propagation | `TypeError`, "on null", "undefined is not" | optional values, missing relations, empty API fields |
| State corruption | inconsistent or half-updated data | transactions, model events, observers, hooks |
| Integration failure | timeout, unexpected response | external APIs, webhooks, queues, DNS, TLS |
| Configuration drift | works locally, fails on the server | `.env`, cached config (`config:cache`), feature flags, PHP/Node version, extensions |
| Stale cache | old data, fixed by a cache clear | Redis, OPcache, CDN, route/view cache, browser, Next.js data cache |
| Encoding and locale | garbled Persian/Arabic, wrong digits, wrong sort | collation, `utf8mb4`, bidi marks, Persian vs Latin digits, time zone |
| Permissions | 403/500 only for some users or paths | policies, file ownership, storage symlink, SELinux |
| Resource limits | fails under load or with big input | memory limit, upload size, worker timeouts, open files, disk full |

Before calling two code paths duplicates, read their callers: what looks
identical usually differs in a guard, transaction or scope, and the "duplicate"
is the one that is right.

## Testing a hypothesis
1. Predict what the evidence will show if the hypothesis is true.
2. Add one temporary probe (log, assertion, breakpoint) exactly at the suspected
   cause; run the reproduction.
3. Matches: proceed to the fix. Does not match: record what you learned, return
   to Phase 1. Never stack a second guess on an unconfirmed first one.

## Searching outside
If no pattern fits, search the generic error class and framework version only.
Strip hostnames, IPs, paths, SQL, customer names and case data first; never send
owner or client data to a search engine. A documented known bug becomes a
hypothesis to test, not a fix to apply.
