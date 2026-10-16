# Test polluter recipe

A polluter is an earlier test that leaks state the victim depends on: the victim
passes alone and fails in the suite or in one shard.

1. **Get the execution order** of the failing run (CI log or the runner's
   verbose listing); take the files that ran before the victim.
2. **Confirm the dependency:** victim alone passes; earlier files plus victim,
   in that order, fails. Run each at least 3 times.
3. **Bisect** the earlier files: keep the half that still breaks the victim,
   repeat until one file remains. Log the list at every step.
4. **Name what leaked:** an environment variable, the working directory, a
   module-level cache or singleton, a mock or spy left installed, a fake clock,
   a server or watcher still listening, a temp file under a shared path, a
   database row or transaction not rolled back, a container binding or facade
   fake (Laravel), config changed at runtime, a global timer.
5. **Fix the polluter, not the victim.** Restore or isolate the state where it is
   created (`afterEach`/`tearDown`, `mkdtemp`, `RefreshDatabase`, a private env).
   A `beforeEach` added to the victim hides the leak for the next victim.
6. **Report:** `POLLUTER: <file> leaked <what> into <victim>; fixed by <change>`,
   with the bisect log. A polluter already on the base branch is outside this
   change: route it with the flake recipe's evidence.
