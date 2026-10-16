# Code review checklist

- [ ] Base and full candidate (committed, staged, unstaged, untracked) identified; files and lines recorded.
- [ ] Whole diff read before the first finding.
- [ ] Pass 1 run; sideways sweep done for every finding (siblings listed).
- [ ] Every test, CI, lint, snapshot or threshold hunk read for gate integrity.
- [ ] Pass 2 run.
- [ ] Stack section loaded only if Laravel/Livewire/Filament or Next.js files changed.
- [ ] Specialists chosen from the trigger table; skipped ones named with the reason.
- [ ] Suppressions applied; every finding quotes file:line and carries a confidence.
- [ ] Mechanical findings auto-fixed; all others asked in one question.
- [ ] Gate findings asked with the four options; dispositions recorded.
- [ ] Behaviour fixes have a regression test shown failing first.
- [ ] Re-review after edits; no more than 3 cycles.
- [ ] Report uses the output format; unverified items named.
- [ ] Owner-facing summary in Persian; code, paths and commands in English.
- [ ] Nothing committed or pushed by this skill.
