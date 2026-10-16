# Tests on merged code

## 1. Integrate first
Merge or rebase the latest base into the branch before testing, so the tests
run on what will land. Conflicts: resolve only the obvious ones; anything
semantic goes to the owner.

## 2. Find the commands
Use what the project declares: CLAUDE.md/AGENTS.md "Testing", `package.json`
scripts, `composer.json` scripts, `Makefile`, CI workflow files. Typical lanes:
`npm test`, `php artisan test` / `vendor/bin/pest`, `vendor/bin/phpstan`,
`npm run lint`, `npm run build`, `npx tsc --noEmit`. Never invent a command or
install a second test framework next to a working one. No tests at all: report
the gap and ask whether to ship untested.

## 3. Run and read the summary line
Pass each lane on its runner's summary line, not on exit code alone:
- `tests ran: N` with no failures → pass;
- `0 tests` / "No tests found" / an empty filter → **zero-run, a failed lane**;
- count not printed → keep the exit-0 pass and say "count unavailable".
Paste each lane's summary line into the record. Keep stderr; never pipe a test
command through `|| true`.

## 4. Triage failures
For each failing test decide ownership:
- **In this branch** (fails here, passes on base): fix it here (use
  `investigate`), then rerun the lane.
- **Pre-existing** (fails on base too): ask the owner: fix now, ship with a
  named waiver, or stop. A waiver covers only that test and that failure.
- **Flaky:** follow `investigate` flake recipe; a rerun is diagnostic, never the
  green.
Never delete, skip or loosen a test to make the lane pass.

## 5. Builds
Run declared build or generation commands (`npm run build`, asset builds,
`php artisan config:cache` dry runs where the project does that in CI). A failed
build stops the release.
