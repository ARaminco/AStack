# Mode A: scope challenge

## 0. Premise
- What is the real problem, the target outcome, and the cost of doing nothing?
- Does the plan solve the pain directly, or a proxy for it?
- What already solves each sub-problem (code, package, another project of the
  owner, a framework built-in)? For any rebuild, say why reuse is worse.
- 12-month picture: `current -> this plan -> ideal`; does this move toward it?

## 1. Recommend a mode (the owner chooses)
Count the planned file additions, edits and deletions (label estimates):
- more than 15 files → REDUCE;
- unclear or mixed → HOLD;
- greenfield product or system → EXPAND;
- added capability → SELECTIVE;
- fix or refactor → HOLD.
State the recommendation with a "because" that ties a concrete plan fact to the
mode's benefit. "Go big" from the owner means EXPAND; "show me options" means
SELECTIVE. Choosing a mode approves no change by itself.

## 2. Mode work
| | EXPAND | SELECTIVE | HOLD | REDUCE |
| --- | --- | --- | --- | --- |
| Posture | build the ideal: 10x value for 2x effort | harden scope, offer each extra neutrally | keep scope, make it bulletproof | minimum valuable core |
| Proposals | additions, each opt-in | cherry-picks, each opt-in (top 5-6) | none | cuts, each opt-in |
| Also | ideal version from the user's side; at least 5 small delights | run the HOLD checks too | complexity check | keep what the goal needs |

**HOLD checks:** more than 8 files or more than 2 new classes/services → can
fewer moving parts reach the same goal? Which work can be deferred without
blocking the goal? Keep the stated acceptance criteria.

## 3. Ask per item
For each addition: A) add to this plan B) defer (recorded with reason) C) skip.
For each cut: A) defer B) keep. Show effort (S/M/L/XL), risk and the user-facing
effect; mark one `(recommended)`. Wait for each answer; never batch silent cuts.

## 4. Record
- Accepted → plan scope. Deferred → the project's backlog (`astack project`
  backlog or the plan's Deferred list) with context. Skipped → NOT in scope with
  the reason.
- Keep one decision table: id, question, current, proposed, status
  (open/approved/deferred/declined), owner's answer.
- Time check: for EXPAND/SELECTIVE/HOLD, which parts must exist in hour 1, in
  week 1, and what is impossible to change after launch (data model, URLs,
  public API)?
