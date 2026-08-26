# Skill System

Skills are operational capability, not prompts. There are two kinds and one
catalog over both.

## Built in skills

`skills/<id>/` ships with AStack: review packs plus the advanced operational
packs.

| Skill | What it does | Risk |
| --- | --- | --- |
| speech-to-text | audio and video to timed, attributed transcript | L1 |
| document-ocr | scans and photos to text, tables and verified fields | L1 |
| image-design | art direction to finished, channel ready images | L2 |
| document-intelligence | document maps and cited answers without re-reading | L1 |
| web-operator | real work on websites with a stop before commits | L4 |
| data-extraction | documents to validated CSV and JSON | L1 |
| legal-case-brief | intake, timeline, evidence, risk, next action | L2 |
| financial-close | reconciliation, adjustments, trial balance, report | L2 |
| tax-filing | traceable calculation, portal filing, receipt | L4 |
| contract-review | obligations, risk table, redline proposals | L2 |
| 25 review packs | security, architecture, performance, SEO and more | L1 |

## Learned skills

`skills/learned/<id>/` is written by the learning engine from real episodes and
preserved across upgrades. Each carries its evidence, metrics, guardrails and
version history.

## Progressive disclosure

An agent receives a one line entry per skill and loads the full content only for
the one it selected:

```bash
astack skill catalog --budget 600     # ~600 tokens for the whole library
astack skill search "تبدیل صوت به متن"
astack skill show speech-to-text      # full content, on demand only
```

## Package shape

```
skills/<id>/
  SKILL.md      mission, when to use, protocol, quality gates, output format
  rules.md      non negotiable rules, including the language and trust policy
  checklist.md  executable checklist
  examples.md   real examples
  skill.json    id, domains, keywords, capabilities, requiredTools,
                requiredCredentials, riskLevel, approvalLevel, procedure,
                confidence, status, metrics, evidence
  versions/     immutable snapshots (learned skills)
```

## Lifecycle

candidate -> draft -> active -> trusted, with deprecated as the exit.

For **learned** skills every transition is driven by recorded outcomes: a
forged skill starts as a draft and is promoted, demoted or retired on its own
metrics, and `astack skill test <id>` checks that it still has a reproducible
procedure, enough evidence and an acceptable success rate.

**Built in** packs ship as `trusted` by editorial decision — they are written
and reviewed, not measured — and carry no metrics until they are used. Their
static check verifies the package is complete; it cannot verify a track record
that does not exist yet. Record outcomes with `astack learn feedback` if you
want a built in pack to earn its confidence the same way a learned one does.
