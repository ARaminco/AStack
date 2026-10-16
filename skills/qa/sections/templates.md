# QA output template

Write to `.astack/qa/<run>/qa-<target>-<YYYY-MM-DD>.md` and save
`baseline.json` (`date`, `url`, `healthScore`, `issues[{id,title,severity,category}]`,
`categoryScores`). Owner-facing prose in Persian; ids, paths, commands English.

```markdown
# QA: <app>

| Field | Value |
| --- | --- |
| Date | DD/MM/YYYY |
| Target | <url or command>, <environment> |
| Branch / commit | <branch> / <sha> |
| Tier / time box | Standard / 15 min (used: 12 min, 23 probes) |
| Surfaces | web, API |
| Framework | Laravel 12 + Livewire / Next.js 16 / ... |

## Health: 72 -> 91 (web)   Contracts: 14 pass, 1 fail, 2 blocked (API)

## Top 3 to fix
1. QA-001 <title>: <one line>
2. ...

## Issues
### QA-001 <short title>
Severity: high | Category: functional | Where: /booking/new
Expected: ... Actual: ...
Repro: 1. ... 2. ... 3. Observe ...
Evidence: shots/qa-001-before.png, notes P-007
Fix: verified | best-effort | reverted | deferred; commit <sha>; test <path>

## Console health
| Error | Count | First seen |

## Regression tests
| Issue | Test | Status |

## Not covered
<contracts or pages not tested and why: time box, blocked, needs owner>

## Summary
QA found N issues, fixed M (verified X, best-effort Y, reverted Z), deferred D,
health X -> Y.
```

Regression mode adds: baseline vs current score, fixed since baseline, new
since baseline.
