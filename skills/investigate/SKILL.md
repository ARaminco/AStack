# Investigate

Systematic debugging. **Iron law: no fix without a confirmed root cause.**
Adapted from gstack `investigate` (MIT, see `NOTICE`). Report to the owner in
Persian (`../../system/language-policy.md`); code, logs and commands stay English.

## Lazy sections
Open a file in `sections/` only when its step is reached
(`sections/manifest.json`). Never load all of them.

## Phase 1: Evidence before hypotheses
1. Collect the symptom: exact error, stack trace, URL or command, time, user.
   Missing context: ask one question at a time.
2. Recall first: `astack memory search "<component> bug"`; a bug recurring in the
   same files is an architectural smell.
3. Read the code path from symptom back to cause. Ask the graph before grepping:
   `astack graphify path "<entry>" "<symbol>"`.
4. Recent changes: `git log --oneline -20 -- <files>`. Worked before? The cause is
   probably in that diff; `git bisect` when the range is wide.
5. **Reproduce deterministically** before going further. No reproduction: gather
   more evidence (logs, data, timing), never guess.
6. Write: `Root cause hypothesis: <specific, testable claim>`.

## Scope lock
After the hypothesis, name the narrowest directory or module holding the fault
and edit only inside it. A needed edit outside it: stop and say why first.

## Phase 2: Pattern match
Open `sections/patterns.md` (pattern table and how to test a hypothesis).
Intermittent or CI-only → `sections/flake.md`. Passes alone, fails in the suite
→ `sections/polluter.md`. Timing or concurrent writers → `sections/race.md`.
A rerun, a wider timeout or a skip is never a hypothesis.

## Phase 3: Test the hypothesis
Add a temporary log or assertion at the suspected cause and run the
reproduction. Wrong: back to Phase 1 with the new evidence.
**3 strikes:** after 3 failed hypotheses or 3 failed fixes, STOP and report
(`sections/closing.md`, three options). Do not try a fourth on your own.

## Phase 4: Fix
1. Write a regression test that **fails** on the current code.
2. Make the smallest change that removes the cause, not the symptom. No
   adjacent refactors.
3. Show the test passing and run the full suite; paste the summary line.
4. Touching more than 5 files: ask the owner about blast radius first.

## Phase 5: Verify and report
Reproduce the original scenario again and confirm it is gone. Then write the
summary from `sections/closing.md`, record the lesson with
`astack memory remember "<root cause>" --facet lesson --body "..."`, and remove
temporary logging.

## Red flags
"Quick fix for now"; a fix proposed before tracing data flow; each fix reveals a
new problem elsewhere (wrong layer); "this should fix it" without a run.
Production data, servers or live sites: read-only unless the owner approves.
