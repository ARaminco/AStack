# Stop questions and the debug summary

## 3-strike stop
After 3 failed hypotheses or 3 failed fixes, stop and ask the owner (in Persian):
```
3 hypotheses tested, none confirmed. This may be an architectural problem,
not a simple bug.
A) Continue: I have a new hypothesis: <one line>
B) Escalate: someone who knows this system should look
C) Instrument: add logging now and catch it next time
```
Recommend one option and say why.

## Blast radius (fix touches more than 5 files)
```
This fix touches N files: a large blast radius for a bug fix.
A) Proceed: the root cause really spans these files
B) Split: fix the critical path now, defer the rest
C) Rethink: look for a narrower fix
```

## Debug summary
```
DEBUG SUMMARY
Symptom:         <what was observed>
Root cause:      <what was actually wrong, with file:line>
Evidence:        <reproduction, probe output that confirmed it>
Fix:             <change, with file:line>
Regression test: <path::case>, failed before, passes after
Suite:           <command> -> <summary line>
Related:         <earlier bugs in the same area, architectural notes>
Status:          DONE | DONE_WITH_CONCERNS | BLOCKED
```
- DONE: cause found, fix applied, regression test written, suite passes.
- DONE_WITH_CONCERNS: fixed but not fully verifiable (intermittent, needs the
  server); say exactly what is unverified.
- BLOCKED: cause unclear after investigation; say what was ruled out.

Owner-facing text is Persian; the block's labels, paths and commands stay English.
Save a substantial summary under the project's reports folder if it has one.
