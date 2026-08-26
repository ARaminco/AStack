# Agent Runtimes

AStack is not tied to one model or one agent runtime. Everything above the
runtime interface — teams, missions, skills, tools — is provider independent.

## Interface

```
start(brief)   run(sessionId)   resume(id)   pause(id)   cancel(id)
handoff(id)    spawn(parent)    report(id)   status(id)
```

Sessions are persisted under `.astack/runtimes/<runtime>/` so a long running
task survives a restart.

## Adapters

| Adapter | Status | Notes |
| --- | --- | --- |
| claude-code | implemented | Writes the compact work order the hosting Claude Code session executes: objective, retrieved context, selected skills, tool catalog, authority ceiling. |
| cli | experimental | Any runtime drivable from a command line. Configure `runtime.providers.<id>.command`; the prompt is passed as a file and execution is gated by the automation policy. |
| mock | mock-only | Deterministic runtime used by tests, dry runs and `astack runtime test`. |

Adding one means extending `AgentRuntime` and registering it in the runtime
registry — no change anywhere else in the platform.

## Handoffs

Agents never exchange transcripts. A handoff is a structured packet:

```json
{ "task": "...", "whatWasDone": "...", "findings": [], "artifacts": [],
  "openQuestions": [], "recommendedNextStep": "..." }
```

## Model router

The router maps a task class and its risk onto a tier, then picks the installed
runtime whose declared strengths and recorded history fit best. No commercial
model name is hard coded anywhere in core logic.

```bash
astack runtime list
astack runtime route "refactor the billing module" --risk L1
astack runtime test mock
astack runtime performance
```

A high authority action is routed up a tier automatically: an irreversible step
is never decided by the cheapest model.
