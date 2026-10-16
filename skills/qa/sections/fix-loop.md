# Fix loop

For each fixable issue in the selected tier, most severe first. Third-party
widgets and infrastructure problems are "deferred", not fixed here.

## a. Diagnose
Replay the failing probe from the same starting state; form a causal hypothesis
(use `investigate` for anything not obvious). Environment failures and unclear
contracts never authorize a code change.

## b. Regression test before the fix
- Match two or three nearby tests (naming, imports, fixtures) and use the
  project's test command (`php artisan test --filter`, `vendor/bin/pest`,
  `npm test -- <file>`, `node --test`).
- Extend an existing table or fixture when one covers the boundary; never add a
  production seam just for the test.
- Smallest test that proves it: unit for logic, feature/integration for state
  and requests, browser end-to-end only when smaller tests miss the journey.
- Run it and show it failing **because of the defect** (not a bad fixture).
- Header comment: `// Regression: QA-NNN <short description>, found by qa on YYYY-MM-DD`.
- CSS-only defects may use screenshot evidence instead of a test; say so.

## c. Fix
Read the surrounding code; make the minimal change. No refactors, no features.

## d. Re-test
Run the regression test, the original probe and the adjacent happy path.
For web defects take an after screenshot. A failed or unavailable re-check stays
unresolved: one revised fix, then revert this run's change.

## e. Commit locally
`git add <only the verified source and test files>` then
`git commit -m "fix(qa): QA-NNN <short description>"`. One fix per commit.
Never push; publishing goes through `ship`.

## f. Classify
- **verified:** passed d with a regression test.
- **best-effort:** applied, could not fully verify (needs auth state or a
  service); say what is missing.
- **reverted:** regression or still failing; undo only this run's change, keep
  the valid red test uncommitted, mark the issue deferred.

## g. Self-check
Every 5 fixes and after any revert: is the loop doing more harm than good?
Stop after 2 reverts, any edit outside the finding's files, or 30 fixes.
