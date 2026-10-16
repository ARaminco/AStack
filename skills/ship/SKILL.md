# Ship

Release checklist from a finished branch to a verified deploy:
tests → code-review → docs drift → version and CHANGELOG → commit → push → deploy
→ verify. Adapted from gstack `ship`, `land-and-deploy`, `canary` and
`document-release` (MIT, see `NOTICE`). Report to the owner in Persian
(`../../system/language-policy.md`); commits, tags and commands in English.

## Lazy sections
Open a file in `sections/` only when its step is reached
(`sections/manifest.json`). A release without a deploy never opens `deploy.md`.

## Steps
1. **Pre-flight.** Not on the base branch; `git fetch`; list the diff and
   commits since base. Uncommitted work is included. Over 200 changed lines and
   no plan review: suggest `plan-review` first (do not block).
2. **Tests:** `sections/tests.md`. Merge or rebase the base first, then run the
   project's declared commands. A lane that ran zero tests failed.
3. **Review:** run `code-review` on the full candidate (its gate-integrity
   findings must all have an owner disposition). Re-run after any fix.
4. **Docs drift:** `sections/docs-drift.md`.
5. **Version and CHANGELOG:** `sections/version-changelog.md`.
6. **Commit:** `sections/commit-push.md` (bisectable commits, no empty commits).
7. **Verification gate:** if anything changed after step 2, re-run the affected
   tests and review. **No completion claim without fresh evidence.**
8. **STOP for approval (L4).** Show the owner: branch, version, commits,
   test summary lines, review result, gate edits, what push and deploy will do.
   Push only after "approve"/«بفرست»; a standing approval recorded in the
   project's AGENTS.md covers only the exact action it names.
9. **Push:** `sections/commit-push.md`. Never force-push, never `--no-verify`.
10. **Deploy** (only if the project deploys and the owner approved it):
    `sections/deploy.md` (production safety rules).
11. **Verify live:** `sections/canary.md`; choose the verdict from evidence.
12. **Record:** `astack learn record "ship <project> <version>" --domain software --tools git,shell`
    and `astack interop handoff "<summary>" --next "..."`.

## Hard rules
- Irreversible steps (push, tag, publish, deploy, migration on production)
  each need the owner's approval and leave a receipt (commit SHA, run URL,
  probe output).
- Never weaken a test, raise a timeout or skip a check to get green; that is a
  gate finding for the owner.
- Secrets never enter commits, CHANGELOG or logs; `git diff --cached` is checked
  for keys and `.env` files before every commit.
- Shared servers: touch only this app's resources (details in `deploy.md`).
  Company-network or infrastructure changes go through the `cto` gate.
- Projects with their own release rules (review gate, CEO approval) keep them.

## Final summary (Persian, labels may stay English)
```
SHIP: <project> <old> -> <new> | branch <b> | commits N
Tests: <lane> <N passed> | Review: <N findings, M fixed> | Gate edits: none
Docs: current/updated | Push: <sha> | Deploy: <verdict> | Next: ...
```
