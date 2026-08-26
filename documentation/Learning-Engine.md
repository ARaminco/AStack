# Learning Engine

AStack turns repeated work into reusable capability without being asked.

## The loop

```
Real work -> episode -> pattern mining -> skill candidate -> forged skill
   ^                                                              |
   |                                    feedback, promotion, versions
   +--------------------------------------------------------------+
```

## Episodes

An episode is one unit of work that actually happened: the task, the domain,
the steps with their tools, the outcome, the duration, the artifacts and the
notes. Secrets are redacted before anything is written.

```bash
astack learn record "بایگانی مدارک پرونده و نگارش خلاصه" \
  --domain legal --tools filesystem,documents --steps "collect;ocr;index;brief"
astack learn episodes --limit 20
```

Each episode carries a **signature**: domain, action verb, normalized tokens and
tool chain. That is what makes repetition visible even when the wording, file
names and dates change every time.

## Pattern mining

Episodes are grouped by signature, then near neighbours are folded in by token
overlap. For each pattern the miner computes occurrences, distinct days, success
rate, stability of the step sequence, impact and a confidence score, and derives
the canonical procedure: steps in at least 60 percent of runs are required, the
rest are optional. Failures become guardrails.

A pattern qualifies when it has been done at least 3 times, on at least 2
different days, with a success rate of at least 0.6, and has at least two
procedure steps. Thresholds are configurable under `learning:` in
`astack.config.yaml`.

## The skill forge

A qualifying pattern is written as a real skill package under
`skills/learned/<id>/`: SKILL.md, rules.md, checklist.md, examples.md and a
machine readable skill.json with the evidence it was built from. Every save is
snapshotted under `versions/`.

Forged skills start as **draft**. They are never trusted because they were
generated.

## Reinforcement

```bash
astack learn feedback <skill-id> --outcome done
astack learn feedback <skill-id> --outcome failed --note "the download button moved"
```

| Transition | Condition |
| --- | --- |
| draft -> active | 3 uses, success rate >= 0.75 |
| active -> trusted | 10 uses, success rate >= 0.85 |
| any -> deprecated | 4 uses, success rate < 0.5 |

Confidence moves with a Bayesian update anchored on the evidence the skill was
built from. A status change creates a new version, so a rollback returns to the
version that worked.

## Commands

```bash
astack learn status
astack learn candidates [--ready]
astack learn forge [<candidate-id>]
astack learn brief "<task>"
astack skill list [--source learned] [--status active]
astack skill show <id>
astack skill test <id>
astack skill history <id>
astack skill promote <id> --status active
astack skill rollback <id> <version>
```

## Reflection without waste

Trivial work is not analysed. A learning pass runs when a mission has more than
one step, when something failed, or when a repeated pattern crosses its
threshold. Nightly, `learning-mine` forges whatever qualified during the day.
