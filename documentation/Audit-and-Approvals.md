# Audit and Approvals

## Approvals

A request states exactly what will happen if the owner says yes:

```bash
astack approval pending
# - AP-3f2a90bd11 | portal.submit | submit the quarterly vat return
#     parameters: {"period":"Q1-2026","amount":"8250 AED"}
#     mission: M-9a2c1 | expires: 2026-05-05T09:00:00.000Z
astack approval approve AP-3f2a90bd11 --note "checked the numbers"
```

An approval produces a **receipt** with a scope and an expiry. Consuming it
makes it unusable, so one "yes" can never authorize a second submission.
Unanswered requests expire instead of lingering.

## Resuming

Approval is a checkpoint, not a restart:

```bash
astack mission resume M-9a2c1     # continues from the approved step
astack browser resume M-9a2c1     # continues the browser flow in place
```

## Audit trail

```bash
astack audit list --limit 20
astack audit show AU-71c0d9ab34
astack audit stats
```

Every record carries timestamp, actor, agent, team, project, mission, tool,
action, target, risk level, approval state, result and evidence links. Targets
and results pass through the secret redactor before they are written.

## Evidence

Browser evidence bundles are hash chained and verifiable:

```bash
astack browser evidence <bundle>
astack browser evidence verify <bundle>
```

## Verification

An action is not reported as done because it was attempted. Missions verify
independently — a confirmation number, a changed status, a downloaded receipt —
and the verification step is part of the plan, not an afterthought.
