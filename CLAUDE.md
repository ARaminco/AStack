# Claude Code Operating Guide For AStack Enterprise

Claude Code and Codex share one operating contract: `AGENTS.md`. It is imported below, so Claude Code reads exactly the same rules Codex reads. Edit `AGENTS.md`, not this file, when a rule changes.

@AGENTS.md

## Claude Code Specifics
- The session-start hook in `.claude/settings.json` runs `astack interop hook session-start --runtime claude-code`: it imports Claude Code auto-memory into the shared store and injects the owner capsule, the latest Codex and Claude Code handoffs, and a memory brief.
- The `astack` MCP server is declared in `.mcp.json` and enabled in `.claude/settings.json`; its tools mirror the `astack` CLI for memory, context, standup and handoffs.
- Claude Code auto-memory is a cache. When something must survive into Codex sessions, write it with `astack memory remember` as well.
- The session-end hook records the session in `.astack/interop/journal.jsonl`; still write an explicit `astack interop handoff` after substantial work.
