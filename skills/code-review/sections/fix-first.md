# Fix-first, confidence and re-review

## Verify before scoring
Quote the motivating line (file:line, verbatim). For framework-generated names,
quote what generates them (migration, cast, attribute, decorator). If you cannot
quote it, the finding is unverified: confidence 4 (appendix) or 5 (main report
with a caveat), never higher.

| Score | Meaning | Display |
| --- | --- | --- |
| 9-10 | Code proves a concrete bug or exploit | normal |
| 7-8 | Strong pattern match, very likely | normal |
| 5-6 | Could be a false positive | "Medium confidence, verify" |
| 3-4 | Suspicious, may be fine | appendix only |
| 1-2 | Speculation | only a suspected catastrophe, labelled speculative |

## Classify
| AUTO-FIX (apply, one line each) | ASK (owner decides) |
| --- | --- |
| dead code, unused variables and imports | security, auth, injection |
| missing eager loading | races and concurrency |
| stale comments | design decisions |
| magic numbers to named constants | fixes over 20 lines |
| version or path mismatches in docs and config | enum completeness |
| missing output validation on model/LLM data | removing functionality |
| inline styles, O(n*m) view lookups | user-visible behaviour, migrations |
| | gate integrity (four options, see `gate-integrity.md`) |
| | every proposed test, every simplification |

Critical findings lean to ASK; informational ones to AUTO-FIX. If reasonable
engineers could disagree, it is ASK.

## Ask once
Put all ASK items in one numbered question: severity, file:line, problem,
recommended fix, options A) Fix B) Skip, and an overall recommendation. Record
each Skip with its reason; never ask the same question twice in one run.

## Apply approved fixes
For a behaviour fix: write the regression test first and show it failing for
the original defect, then fix, then run it with the adjacent happy path. If the
proof cannot run, report the gap and do not claim a verified fix.
Format: `[FIXED + TEST] file:line - problem -> fix, test at <path>`.

## Re-review
After edits, review the changed candidate again (steps 2-8). At most 3 cycles;
at the third, report the remaining findings as not converged and stop.

## Claims need evidence
"Looks fine" is not evidence. A safety claim cites the line that enforces it; a
coverage claim names the test file and case; a command claim names the command
and its observed result. A suite that ran zero tests is not a pass.
