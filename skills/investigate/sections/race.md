# Race condition recipe

A race is two actors touching shared state with an ordering nobody enforces.
Make it deterministic before fixing it.

1. **Timing probes.** Log a monotonic timestamp (`performance.now()`,
   `hrtime`, `microtime(true)`) and the actor id at every read and write of the
   shared state (file, row, cache key, lock). A race shows as interleaved writes
   or a read between another actor's check and its write. Keep the output.
2. **Forced interleaving.** Inject a pause at the suspected point in one actor
   (behind a test-only hook) so the other runs inside the window. The bug must
   now appear every time; if not, the window is elsewhere.
3. **Concurrent-writer test.** Drive N >= 8 writers at once and assert the
   invariant, not the absence of an error:
   ```js
   const results = await Promise.allSettled(Array.from({ length: N }, (_, i) => writer(i)));
   // exactly one winner | all N applied | row or file intact | lock released
   ```
   In PHP use parallel processes or queue workers against a real database. This
   test, with the interleaving still injected, becomes the regression test.
4. **Fix shape: an atomic primitive.** Exclusive create (`wx`), compare-and-swap,
   `UPDATE ... WHERE status = ?` with an affected-rows check, a unique index with
   duplicate-key handling, `lockForUpdate()` inside a transaction,
   `Cache::lock()` with an owner and expiry. A check-then-act with a smaller
   window is not a fix. Rerun step 3 after the change and keep both outputs.
