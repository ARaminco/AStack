### P1 — Runner and daemon (always-on AStack)

- **Runner** (`runner-engine/`, `runtime.runner`): unattended execution of the
  hosted work order through Claude Code headless, `codex exec`, a local Ollama
  model or a mock engine; `auto` routes cheap background work to the local
  model and real tasks to Claude Code. Missions run through the mission engine
  and stop at the same approval points; free-form runs turn
  `APPROVAL-REQUEST:` lines into owner approvals and resume after the
  decision. Daily budget, per-run budget and concurrency guards; every run is
  recorded in `.astack/runner/runs.jsonl` and the audit log.
- **CLI**: `astack run "<objective>" [--engine] [--model] [--budget] [--dry-run] [--mission] [--queue]`,
  `astack runner list|show|resume|status|drain|engines|enable-signal-runs`.
- **Queue bridges**: scheduler job kind `agent` (`--objective`, `--engine`,
  `--ceiling`, `--mode`), signal reaction `run-agent` (off until
  `astack runner enable-signal-runs`).
- **Daemon** (`daemon-engine/`): `astack daemon start [--foreground]|stop|status|logs`
  supervises `runner-engine`, `scheduler-engine` and `signal-engine` services
  (and later packages' `service.mjs`) with crash restart and backoff.
- **OS service**: `astack daemon install-service|uninstall-service|service-status [--dry-run]`
  for Windows Task Scheduler, macOS launchd and Linux systemd --user.
- `buildWorkOrder()` extracted from the hosted runtime adapter so the hosted
  and unattended paths share one work order (output unchanged).
- Doctor prints runner and daemon lines. New docs: `documentation/Runner-and-Daemon.md`.
