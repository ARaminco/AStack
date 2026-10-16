# Post-deploy verification

Read-only: observe and report. Do not change code here unless the owner asks.

## Depth by change
| Change | Check |
| --- | --- |
| docs only | smoke: home page 200 |
| config only | smoke: key URLs 200 |
| backend | key URLs + error log + response time |
| frontend or mixed | full: open key pages in the dedicated browser (`browser_navigate`, `browser_snapshot`, `browser_console_messages`, `browser_network_requests`, `browser_take_screenshot`) |

## Health per page
- loads with status 200 and stays on the site (no redirect to an error page);
- no new console errors or failed requests compared with the baseline;
- real content (not blank, not a generic error page);
- load time under 2x the baseline (absolute 10 s as a ceiling).
Alert on changes, not absolutes: a baseline with 3 console errors that still
has 3 is fine. Confirm any problem on 2 consecutive checks before calling it.

## Optional watch
For risky releases, re-check key pages every 60 s for the agreed window
(default 10 min). A confirmed critical (page down) or high (new errors) issue
interrupts with options: A) investigate B) keep watching C) roll back D) dismiss.

## Rollback (owner-approved or automatic per `deploy.md`)
Code: previous release or a revert commit (never a force-push, never a history
rewrite). Then re-run these checks against the rolled-back version. A rollback
is done only when that version is live and healthy.

## Verdict (first that matches; never infer success from a merge or one 200)
| Evidence | Verdict |
| --- | --- |
| rollback requested, not yet confirmed live | ROLLBACK PENDING |
| rollback confirmed live and healthy | REVERTED |
| accepted health problems | DEGRADED |
| no deploy needed (docs-only, library) | MERGED, NO DEPLOY NEEDED |
| deploy confirmed and all checks pass | DEPLOYED AND VERIFIED |
| deploy confirmed, checks not possible | DEPLOYED (UNVERIFIED) |
| anything else | PUSHED (UNVERIFIED) |

Keep the screenshots and probe output as the evidence bundle; name their paths
in the summary.
