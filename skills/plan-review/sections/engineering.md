# Mode B: engineering lock-in

Runs after scope is settled. For each section give findings with severity and
confidence, most severe first (or "No issues found" with one sentence on what
was examined), then the decision for each.

## 0. Complexity gate
Count planned changed files and new classes/services. At 8+ files or 2+ new
services, stop before section 1 and offer the owner the original arrangement vs
a smaller one with the same features. Research any new pattern, infrastructure
or concurrency approach against the framework's built-ins first.

## 1. Architecture
- Component boundaries, dependencies, coupling; where does each piece live?
- Data flow, bottlenecks, single points of failure, scaling limits.
- Security boundaries: auth, data access, tenancy, external input.
- One realistic production failure per new integration and how the plan handles it.
- Distribution: how a new artifact is built, deployed and updated.
- **Diagram** each new flow, state machine or pipeline in ASCII:
```
request -> controller -> FormRequest(validate) -> Service -> DB tx -> event -> queue job -> mail
                                                        \-> 422 on invalid
```

## 2. Data flow and edge cases
For every new path trace: happy, null/missing, empty/zero, upstream error,
timeout, duplicate (double click, retry, replayed webhook), stale state, back
button, slow network, concurrent edit, first run with no data, max-size input,
Persian/Arabic text and digits, time zones.

## 3. Error and rescue map
| Error | Trigger | Caught where | User sees | Logged/alerted | Test |
Flag catch-alls. A failure with no test, no handling and a silent result is a
**critical gap**.

## 4. Code quality
Reuse over duplication (only when behaviour truly matches); no premature
abstraction; error paths explicit; stale diagrams or comments in touched files.

## 5. Test matrix
| Behaviour / branch | Unit | Feature/integration | E2E/browser | Exists? |
Every new branch gets a row. Name the regression each test would catch; add the
negative and permission-denied cases; say which need real services.

## 6. Performance
Queries in loops, unbounded queries or caches, missing indexes, whole-file
loads, blocking calls without timeouts. Give scale (rows, requests/s) or say
"unknown"; never invent benchmarks.

## 7. Rollout
Migration order (expand, migrate, contract), feature flag, backward
compatibility during deploy, rollback path, observability (logs, metrics,
alerts) for each new path. On shared servers: the app's own resources only.

## 8. Parallel work
Group the implementation by module into lanes that can run in separate git
worktrees; shared modules go sequentially. With one module, write "sequential,
no parallelization".
