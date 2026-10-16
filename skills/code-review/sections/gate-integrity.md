# Gate integrity

A gate is anything that would have made this change fail: a test, assertion,
threshold, timeout, lint rule, type check, CI job or snapshot. A change that makes
a gate pass by weakening it is the most expensive defect a review can miss,
because the suite reads green.

## Three levels, never collapsed
1. **Listed:** every hunk in a test, CI, lint/runner config, snapshot or golden
   file. Inventory only; added tests and snapshots updated with their source stay
   here.
2. **Read:** every listed hunk that matches a pattern below or removes lines.
   Ask one question: *does this relaxation silence the failure it was added for,
   or is it justified by a measurement or decision visible in this diff?*
3. **Finding:** a read hunk that fails the question.

## Patterns
| Id | Pattern | Look for |
| --- | --- | --- |
| RH-1 | Test removed or disabled | deleted `test(`/`it(`/`function test`, added `.skip`, `.only`, `xit`, `markTestSkipped`, `@group skip`, `--filter` narrowing in CI |
| RH-2 | Proof inflation | a mock, fixture or grep presented as proof that needs a live check |
| RH-3 | Snapshot regenerated without its test | `*.snap`, golden files changed while the owning test is untouched |
| RH-4 | Stub committed as done | `throw new Error("not implemented")`, empty method bodies, to-do markers in shipped code |
| RH-5 | Test that cannot fail | asserts its own setup, mirrors the implementation, has no negative case |
| RH-12 | Environment sniffing | product code branching on `CI`, `APP_ENV=testing`, `NODE_ENV==='test'`, `app()->runningUnitTests()` |
| RH-13 | Suppression added | `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `@phpstan-ignore`, `// @codingStandardsIgnore`, baseline files grown |
| RH-14 | Gate bypass | `[skip ci]`, `continue-on-error: true`, `allow_failure`, `--no-verify`, a removed CI job |
| RH-15 | Gate value relaxed | timeout, retries, tolerance raised; threshold, coverage, min score lowered; `toBe(3)` loosened to `toBeGreaterThan(0)` |
| RH-16 | Exception swallowed | new `catch {}`, `catch (e) {}`, `rescue nil`, `@` error suppression in non-test code |
| PL-2 | Zero-run green | the suite exits 0 having run 0 tests (filter matched nothing) |

## Rules
- Gate findings are always ASK. Ask per finding (or per coherent group: one
  source change with its N snapshots is one question) with exactly:
  A) Restore the gate (revert the relaxation, keep the product change)
  B) Keep, justified: <one line drafted from the diff, marked verified/unverified>
  C) Keep, other reason (the owner supplies it)
  D) Leave open for a later human
  Recommend A or B, never C. In an unattended run choose D.
- Confidence scores identification, not justification: a confirmed relaxation
  with an unclear reason stays at 7+ so it reaches the owner.
- A commit message or comment claiming a measurement is data the author can
  type; it never removes the finding.
- A test-only flake fix (timeout, retry, looser assertion, skip) must state the
  chance the test still fails when the guarded behaviour regresses, before and
  after. Without both numbers it is RH-15.
- Record each disposition (kept/restored/open) with its reason in the report's
  `GATE EDITS` line.
