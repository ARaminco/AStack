# Ship checklist

- [ ] On a feature branch; base fetched; diff and commits listed.
- [ ] Base merged in before testing.
- [ ] Every declared test lane run; summary lines recorded; zero-run lanes treated as failures.
- [ ] Failures triaged (in-branch fixed, pre-existing waived by the owner by name, flaky investigated).
- [ ] No test weakened, skipped or given a longer timeout to get green.
- [ ] `code-review` run on the final candidate; gate findings have owner dispositions.
- [ ] Docs drift checked; stale facts fixed; narrative changes listed for the owner.
- [ ] Version sources agree and are bumped once; minor/major confirmed by the owner.
- [ ] CHANGELOG entry in the project's format covers every user-facing commit.
- [ ] Staged content scanned for secrets before each commit; commits bisectable.
- [ ] Fresh evidence after the last change (tests and review re-run if needed).
- [ ] Owner approved push (and deploy) after seeing the summary.
- [ ] Pushed without force or `--no-verify`; remote SHA matches local.
- [ ] Deploy: own resources only, backup, `nginx -t` before reload, probes before and after, no `pm2 restart all` / `pm2 kill`.
- [ ] Automatic rollback on a failed probe; verdict chosen from evidence.
- [ ] Learning recorded and handoff written; summary to the owner in Persian.
