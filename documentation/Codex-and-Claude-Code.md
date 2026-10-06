# Codex and Claude Code: One Operator, Two Runtimes

AStack runs equally in Claude Code and in OpenAI Codex (CLI, IDE extension or desktop app). Both runtimes load the same operating contract, reach the same tools, recall from the same memory and start every session from the same state. Work started in one runtime can be continued in the other without re-explaining anything.

## What is shared

| Concern | Single source of truth | Claude Code reaches it through | Codex reaches it through |
| --- | --- | --- | --- |
| Operating contract | `AGENTS.md` | `CLAUDE.md` → `@AGENTS.md` import | `AGENTS.md` (native) |
| Tools | `astack` MCP server (`node bin/astack.mjs mcp serve`) | `.mcp.json` + `enabledMcpjsonServers` and `permissions.allow: mcp__astack` in `.claude/settings.json` | `[mcp_servers.astack]` with `default_tools_approval_mode = "approve"` in `.codex/config.toml` |
| Session start state | `astack interop hook session-start` | `SessionStart` hook in `.claude/settings.json` | `SessionStart` hook in `.codex/hooks.json` |
| Session trace | `.astack/interop/journal.jsonl` | `SessionEnd` hook | `SessionEnd` hook |
| Durable memory | `.astack/memory/` (structured facets) | CLI or MCP tools; auto-memory is imported at session start | CLI or MCP tools |
| Handoffs | journal + episodic memory | `astack interop handoff` / `astack_handoff_write` | the same |

Neither runtime's private memory is a source of truth. Claude Code auto-memory (`~/.claude/projects/<workspace>/memory/`) is imported into the shared store at every Claude Code session start; a changed file supersedes its earlier record. Codex memories live in an opaque store that AStack does not read, so the contract tells Codex to write durable facts to the shared store instead.

## Setup

```bash
node bin/astack.mjs interop sync            # generate or merge the wiring for both runtimes
node bin/astack.mjs interop sync --trust-codex   # also trust the project in ~/.codex/config.toml (backup kept)
node bin/astack.mjs interop status          # prove parity
```

`sync` merges into existing files: owner MCP servers, hooks, permissions and Codex settings are kept, the astack entries are added or refreshed, and running it twice changes nothing. A malformed owner file is reported as `invalid` and never overwritten. Installs upgraded from 2.1 are wired by the `2026.7-runtime-interop` migration.

One-time trust steps that cannot be automated safely:

- **Codex** — the project must be trusted (`--trust-codex`, or accept it in Codex), and project hooks run only after you review them once: open Codex in the project, run `/hooks` and trust the two astack hooks. Trust is recorded against the hook's hash, so re-trust after `sync` changes a hook.
- **Claude Code** — accept the workspace trust dialog once; until then Claude Code ignores the `permissions.allow` entry and asks before each MCP call.

## The session loop

1. **Start** — the hook imports Claude Code memory (Claude Code only), records `session-start` and injects the same context into either runtime: the contract hash, the latest handoffs and session ends from both runtimes, the owner capsule, open work and a memory brief. `astack interop context` prints it.
2. **Work** — recall with `astack memory search` / `astack_memory_search`, write durable facts with `astack memory remember` / `astack_memory_remember`. Records written through MCP carry the calling runtime as their source.
3. **Handoff** — `astack interop handoff "<summary>" --done "..." --findings "a;b" --open "q1;q2" --next "..."`. Secrets are redacted.
4. **End** — the hook records branch, head and uncommitted file count.

## MCP tools

`astack_standup`, `astack_memory_search`, `astack_memory_remember`, `astack_memory_supersede`, `astack_memory_entity`, `astack_context_map`, `astack_context_search`, `astack_ask`, `astack_skill_catalog`, `astack_handoff_write`, `astack_journal`, `astack_interop_status`.

Each tool runs the astack CLI with an argument vector (never a shell string), so it can do nothing the CLI could not, and both runtimes get byte-identical results. `astack mcp tools` lists them.

## Runtimes in missions

`codex` is a hosted runtime like `claude-code`: it writes the same work order format to `.astack/runtimes/codex/work-orders/`. The model router gives the runtime hosting the current session a tie-break preference, so a work order is executed by whoever is already at the keyboard; an explicit `preferred` runtime still wins. To run Codex unattended through `codex exec`, set `runtime.providers.codex.command` (and `args`) in `astack.config.yaml` and allow the command in the automation policy; the generic CLI adapter is then used.

## Verified

`npm test` (suite `verify-interop`) covers merging, idempotence, the journal, handoffs, Claude memory import, Codex trust, the MCP protocol over stdio and the migration. The integration was also checked against real runtimes: Codex CLI 0.160.0 loaded `AGENTS.md`, received the session-start context with the shared contract hash and called `astack_interop_status`; Claude Code loaded `AGENTS.md` through `CLAUDE.md`, received the same context and called the same tool.

## Limits

- Memory, journal and missions live in `.astack/`, which is local and git-ignored. Both runtimes share them on the same machine and checkout; a cloud agent working from a fresh clone starts without them.
- Hook and MCP commands use paths relative to the workspace root; start both runtimes from the repository root.
