# Plan Review

Review a plan before code is written: challenge scope, lock in the engineering,
score the design. Review only: never implement here. Condensed from gstack
`plan-ceo-review`, `plan-eng-review`, `plan-design-review` and `autoplan` (MIT,
see `NOTICE`). Entry point also for `feature-planner`. Talk to the owner in
Persian (`../../system/language-policy.md`); identifiers and paths stay English.

## Lazy sections
Open a file in `sections/` only when its mode is reached
(`sections/manifest.json`). Never load all of them.

## Steps
1. **Read the plan and the code it touches.** Recall decisions first:
   `astack memory search "<feature>"`; map reuse with
   `astack graphify query "<capability>"`. Name the real problem, the target
   outcome and the cost of doing nothing.
2. **Decision principles:** open `sections/principles.md` once; they answer
   every intermediate question.
3. **Mode A, scope challenge:** `sections/scope-challenge.md`. Recommend one of
   EXPAND / SELECTIVE / HOLD / REDUCE with a reason tied to a plan fact; the
   owner picks. Each addition or cut is its own yes/no; nothing changes scope
   silently.
4. **Mode B, engineering lock-in:** `sections/engineering.md`: architecture,
   data flow diagram, edge cases, failure modes, test matrix, performance,
   rollout. Always runs, always after scope is settled.
5. **Mode C, design score:** only when the plan has UI: `sections/design-score.md`
   (seven dimensions, 0-10, what would make each a 10).
6. **Output:** `sections/outputs.md`: the review written into the plan (or a
   new file next to it), decisions table, NOT in scope, open questions.
7. **One final gate:** present the one-page brief with every taste decision and
   every change to the owner's stated direction; the owner approves, overrides,
   or asks for a revision (max 3 cycles). Then hand off: implement, then
   `code-review`, `qa`, `ship`.

## Modes on request
"just scope" → step 3 only. "eng review" → steps 4 and 6. "design review" →
step 5. No mode named → all applicable, in order 3 → 5 → 4 (engineering last,
so it reviews the amended plan).

## Hard rules
- Never auto-decide a change to the owner's stated direction (merge, split, add
  or remove a feature): ask at the final gate with the cost of being wrong.
- Every deferral is recorded with its reason; every rejection goes under NOT in
  scope.
- Unknowns stay unknown: never invent numbers, benchmarks or estimates.
- Projects with their own governance (CTO gate, review gate) keep it; this
  review does not bypass it.
- Record the approved decisions: `astack memory remember "<decision>" --facet decision`
  or `astack project decision` for a managed project.
