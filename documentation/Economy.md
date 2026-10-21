# Economy engine (3.8.0)

AStack controls Claude sub-agent cost while keeping the caller responsible for
reviewing delegated results. `astack interop sync` installs the Claude hooks and
the `codex-worker` agent; Codex needs no hooks. No provider calls are made by
the economy hooks. The statusline alone captures official Claude percentages.

Run `astack economy status` for account pressure, weighted hourly burn, the eight
largest sessions, live agents, Codex availability, local models and active routes.
`astack economy report --since 2026-10-20T06:10 --json` exports usage data.
`astack economy route --test Explore "Find the relevant files"` previews routing.

Search defaults to haiku, build/bulk-read/write/other to sonnet, and review/plan/legal
to opus. Policy only lowers the inherited or explicit model, except that legal
requires opus. `economy.respect_explicit` exempts caller choices from lowering.
Amber lowers ordinary reviews/planning; red recommends Codex for build/bulk-read
and caps non-legal work at sonnet. Critical keeps the same ceiling. Parallel caps
are 4/3/2/1; context budgets are 160k/120k/90k/90k. A denied agent must stop and
return its result so its lead can start a fresh context. The main chat suggests
`/compact` above 250k tokens or when account pressure is elevated.

`astack delegate "Implement the bounded change and run its tests" --to codex --mode write`
uses the independent ChatGPT-plan quota. Read mode is the default. Options include
`--cwd`, `--effort`, `--schema` and repeated `--image`. MCP offers
`astack_economy_status` and `astack_delegate` (including `schema_json`). Auto uses
Codex when logged in through ChatGPT and below 90% of its primary quota; otherwise
it can use Ollama for text-only classification, extraction or summaries of text
included in the task. Ollama cannot read workspace files or OCR image attachments
through this text endpoint. A failed delegate returns a reason for the caller to
continue. Results always need caller review.

`astack economy on|off` and `astack economy set routes.build sonnet` save project
overrides in `.astack/economy/state.json` and refresh wiring. The template's
`economy` section documents all defaults. The owner's hooks, explicit environment
choice and previous statusline are preserved. The previous statusline object is
encoded in the wrapper command, receives the original stdin and is restored when
economy is disabled; `economy.statusline.chain` also accepts a command explicitly.

All account data lives under `~/.astack/economy/`: incremental byte offsets and
deduplicated call records in `meter-cache.json`, official limits and session
contexts in `limits.json`, expiring live agents in `live.json`, short-lived route
model receipts in `routes.json`, routing/delegation
receipts in `ledger.jsonl`, and hook failures in `hook-errors.log`. These files
never store prompts, provider output, images or credentials. Cache writes use
atomic replacement and cross-process locks. Oversized transcript lines (2 MB or
more) are skipped without parsing or buffering them whole. Repeated API response
records count once per message id and request id, retaining maximum token counts.
Rotated or truncated files reset their offsets. Weighted units are a configurable
comparison measure, not dollars or the provider's quota formula.

Pressure uses the larger of official weekly (50/70/85%) and five-hour (70/85/95%)
levels. After 30 minutes it uses a recent meter estimate against an optional
`weekly_budget_units`; without that budget it reports unknown and applies green
caps. Hooks only inspect cached data and bounded transcript tails; run a report
to refresh metered estimates. Live agents expire after three hours. Admission is
locked across hook processes and counts live agents plus pending launches;
SubagentStart converts a launch reservation into a live entry under the same
lock. Unused launch reservations expire after three minutes, so a cancelled call
does not hold a slot indefinitely.

## Account-wide hooks (3.8.1)

`astack economy global on` adds the economy hooks and `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` (only when unset) to `~/.claude/settings.json`, pointing at `~/.astack/core/bin/astack-economy-hook.mjs`. Usage limits are per account, so this covers every folder, including projects whose core lives in a sub-folder and folders without AStack. In a project that wires its own economy hooks the global copy exits at once, so nothing is counted twice. The owner's file is backed up first; `astack economy global off` removes only AStack's entries.
