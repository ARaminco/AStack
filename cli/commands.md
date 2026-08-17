# CLI Commands

AStack Enterprise CLI commands are implemented in `bin/astack.mjs` (with handlers in `cli/orchestration-cli.mjs` and `delivery-engine/cli.mjs`) and exposed through the `astack` binary.

| Command | Purpose |
| --- | --- |
| `astack init` / `astack install` | Validate the install and report readiness |
| `astack doctor` | Health check: layers, config sections, counts |
| `astack upgrade` (`update`) | Upgrade the embedded core from the canonical repository |
| `astack review "<request>"` | Orchestrator analysis: domain, workflow, departments, briefings |
| `astack domain [detect "..."]` | List domains or classify a request |
| `astack team <create\|list\|show\|add\|remove\|project\|status\|disband>` | Manage cross-functional teams |
| `astack agent <create\|list\|show\|brief\|assign\|run-due\|report\|pause\|resume\|retire\|standup\|workload>` | Manage agents and scheduled missions |
| `astack lead <plan\|team\|delegate\|standup\|review>` | Leadership: plan, form teams, delegate, supervise |
| `astack project <...>` | Full delivery lifecycle (see `documentation/Project-Management.md`) |
| `astack workflow` | List workflows |
| `astack provider` | List providers |
| `astack plugin` | List plugins |
| `astack memory` | List memory scopes |
| `astack knowledge` | List knowledge packs |
| `astack backup` | Back up memory scopes |
