# Decision principles

Use these to answer intermediate questions without stopping the owner. Taste
decisions are collected for the final gate.

1. **Choose completeness.** Pick the approach that covers more edge cases; with
   AI doing the typing, the complete version usually costs minutes more.
2. **Fix the blast radius.** Problems in the files the plan touches and their
   direct callers are in scope when small (under 5 files, no new infrastructure).
3. **Pragmatic.** Two options fix the same thing: take the cleaner one quickly.
4. **Reuse first.** Duplicates something that exists (in this project, in the
   owner's other projects, in the framework)? Reuse it.
5. **Explicit over clever.** A 10-line obvious change beats a 200-line
   abstraction; choose what a new contributor reads at a glance.
6. **Bias to action.** Flag concerns, do not block on them; a merged, reviewed
   change beats another round of deliberation.

Tie-breakers: in scope decisions 1 and 2 dominate; in engineering 5 and 3; in
design 5 and 1.

## Decision classes
- **Mechanical:** one clearly right answer. Decide and log it.
- **Taste:** reasonable people disagree (two viable approaches, borderline
  scope of 3-5 files). Decide with a recommendation, surface at the final gate.
- **Owner challenge:** the review would change the owner's stated direction
  (merge, split, add, remove a feature or workflow) or a premise looks wrong.
  Never auto-decided. At the gate give: original direction, proposed change,
  reasoning, blind spots, cost of being wrong.

## Engineering preferences
- Every behaviour tested; no test without a regression it would catch.
- Smallest clear diff; a broken foundation may justify a rewrite, said openly.
- Boring technology by default; each new tool or service must earn its place.
- Make the change easy first (refactor), then make the easy change; keep the
  two separate.
- Reversibility: flags, incremental rollout, a rollback path for every deploy.
- Design for a tired human at 3 am: clear errors, logs, runbooks.
