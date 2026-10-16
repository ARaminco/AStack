# Testing specialist

Output format as in `security.md`; a proposed test goes in a `Test:` line with
the target file path and the test code, and is always ASK.

## Gaps
- New error, rejection or guard paths with no failing-case test.
- Permission checks never tested for the denied case; rate limits never shown to
  block; sanitizers never fed malicious input.
- Boundary values: zero, negative, max, empty string or list, null, one element,
  Unicode and right-to-left text (Persian/Arabic input is normal here).
- Changed methods whose tests cover only the old branch.

## Negative assertions
- A new "is absent" assertion records a behaviour removal: cite the requirement
  that authorizes it, or report it as a product decision shipped as a test.
- A rename or removal can empty an old negative assertion (it now passes forever).
  Grep tests for negative assertions naming the old value.

## Isolation and flakiness
- Shared mutable state, order dependence, real clock, time zone or locale,
  real network calls, unseeded random data, tight `sleep`/`waitFor` timings,
  assertions on unordered results.

## Low-value tests (informational, never auto-delete)
A new test earns its place only with four answers: what behaviour it protects,
which credible regression makes it fail, why existing coverage misses that, and
that it needs no production seam used only by tests. Flag tests that assert
nothing, compare a value with itself, copy fixtures, grep source text that is not
a contract, or duplicate a shared helper's tests per caller.

## Regression tests
- A test named as a regression with no record of failing before the fix proves
  the mock, not the fix. Ask for the fail-before / pass-after evidence.
