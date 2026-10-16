# Required outputs and the final gate

Write the review into the plan file (a `## Review` section) or a sibling file;
never claim a save you did not read back. Prose for the owner in Persian.

## Sections
- **Summary:** 1-3 sentences.
- **Mode and scope decisions:** mode, each addition/cut with the owner's answer.
- **What already exists:** reused code, packages, other projects.
- **NOT in scope:** each item with its reason (deferred or rejected).
- **Diagrams:** every new flow, state or pipeline (ASCII).
- **Error and rescue map** and **failure modes**, critical gaps first.
- **Test matrix.**
- **Design scores** (when UI): dimension, before, after.
- **Rollout and rollback.**
- **Parallel lanes.**
- **Implementation tasks:** ordered, each small enough to review, with its tests.
- **Open decisions:** what still needs the owner, with a recommendation each.

## Final gate brief (one page, Persian)
```
Plan: <name>   Mode: SELECTIVE   Reviews: scope, design 6->8, engineering
Urgent outside this plan: <security or data-loss issues found, or none>
Owner challenges (need your decision):
  uc1: <proposed change to your direction> - why - cost if wrong
Taste decisions (defaults applied, override if you disagree):
  d1: <choice> (principle 5; alternative: ...)
Critical gaps: <count, listed>
Options: A) approve  B) approve with overrides  C) ask questions  D) revise  E) start over
```
A: record the decisions and hand off. B or D: apply, re-run the affected mode
(engineering always last), present again; at most 3 cycles.
