# QA checklist

- [ ] Surface chosen (web, API, CLI, job, webhook) before setup; a missing URL did not force a browser.
- [ ] Isolation resolved: where data, mail and messages really go; unknown ownership blocked.
- [ ] Boundaries, tier and time box announced in Persian before the first probe.
- [ ] Working tree clean or the owner chose commit/stash.
- [ ] Dedicated browser status checked; owner typed any password or OTP.
- [ ] One probe at a time; an evidence note written before the next probe.
- [ ] Each failure replayed once from the same starting state before recording.
- [ ] No submit, pay, send, delete or publish on a live site without owner approval.
- [ ] Issues classified by severity and category; score only for tested categories.
- [ ] Baseline reported before fixing.
- [ ] Each fix has a regression test shown failing first, then passing.
- [ ] Original probe and adjacent happy path re-run after each fix.
- [ ] One local commit per verified fix; nothing pushed.
- [ ] Stopped after 2 reverts, an unrelated edit, or the cap.
- [ ] Final pass done; output written; uncovered areas named.
