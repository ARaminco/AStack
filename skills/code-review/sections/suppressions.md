# Suppressions: do not flag

Flag only what a senior engineer on this team would change. Zero findings is a
valid outcome.

- Harmless redundancy that aids readability.
- "Add a comment explaining this threshold/constant".
- "This assertion could be tighter" when it already covers the behaviour.
- Consistency-only changes with no behavioural effect.
- Regex or parser edge cases that the constrained input never produces.
- A test exercising several guards at once.
- Threshold values as a code-quality comment ("extract a constant"). This never
  suppresses gate integrity: a relaxed threshold is still read there.
- Harmless no-ops.
- Anything the same diff already addresses: read the full diff first.
- "Add error handling" where the framework or caller already owns the error
  (exception handler, error boundary, top-level catch).
- "Function too long" for an exhaustive switch, config object, test table or
  generated code.
- "Possible null" when a guard in scope already narrows the value.
- N+1 on a small fixed-cardinality loop or an already batched path.
- Hard-coded values in test fixtures, examples or docs.
- `Math.random()`/`rand()` for jitter, sampling or animation.
