# Flaky test recipe

A flake is a test whose verdict depends on something other than the code it
guards. No rerun, wider timeout, retry or skip until the cause is named and probed.

1. **Reproduce on the base branch.** In a separate worktree
   (`git worktree add <dir> <base>`) run the failing test file alone N >= 10
   times; record `failed/N`. Repeat on the branch. Fails on base too: the cause
   is outside this change. Only on the branch: inside it.
2. **Name the dependency.** Compare logs of a passing and a failing run at the
   first divergence: timing, file order, shared state, network, clock, time
   zone, a resource limit, random data. "Flaky" is a symptom, never a cause.
3. **Date it.** Compare the test's duration or retry count across the last
   green CI runs; the run where it first moved names the commit to read.
4. **Forced probe.** Make the smallest change that fails the test every time for
   the stated cause (inject a delay, pin file order, freeze the clock, exhaust the
   resource). Show it failing, then passing after the fix. No probe, no cause.
5. **Never loosen.** A wider timeout, retry, looser assertion or skip is a gate
   relaxation (`code-review` gate integrity, RH-15). A test-only fix must state
   the chance the test still catches a real regression, before and after, from
   the forced probe. A number that drops needs the owner's decision.
6. **Rerun only when the cause is known and outside the change** (infrastructure,
   a polluter already fixed on base, a provider outage), and say so in the report.
7. **Evidence in the report:** probe output before and after, `failed/N` on base
   and branch, the first-moved commit, and the routing: fixed here, rerun with
   an outside cause, or owner decision needed.
