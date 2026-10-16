# Investigate checklist

- [ ] Symptom recorded exactly (error, trace, command or URL, time).
- [ ] Memory recalled for earlier bugs in the same component.
- [ ] Code path traced; recent changes to the files read.
- [ ] Bug reproduced deterministically before any fix.
- [ ] Root cause hypothesis written as a testable claim.
- [ ] Edits kept inside the module under investigation.
- [ ] Matching recipe opened (flake, polluter, race) only when the pattern fits.
- [ ] Hypothesis confirmed with a probe; no rerun, timeout or skip used as a fix.
- [ ] Stopped and reported after 3 failed hypotheses or fixes.
- [ ] Regression test shown failing before the fix and passing after.
- [ ] Smallest fix; owner asked before touching more than 5 files.
- [ ] Full suite run; summary line pasted; zero-test runs not counted as passes.
- [ ] Original scenario reproduced again and confirmed fixed.
- [ ] Temporary probes removed; lesson stored in shared memory.
- [ ] Debug report delivered in Persian with status DONE, DONE_WITH_CONCERNS or BLOCKED.
