# Graphify: Code Graph With Token Budgets

[Graphify](https://github.com/safishamsi/graphify) (PyPI `graphifyy`, command `graphify`) parses the workspace with tree-sitter into a knowledge graph (`graphify-out/graph.json`): files, symbols, imports, calls and communities. A question is answered with a scoped subgraph instead of raw files. AStack drives Graphify for Claude Code and Codex alike and puts every answer under an AStack token budget.

## Why AStack drives it instead of Graphify's installers

`graphify claude install` and `graphify codex install` write different sections into `CLAUDE.md` and `AGENTS.md` and register hooks with an absolute path to the local executable. That breaks the shared contract (see [Codex and Claude Code](Codex-and-Claude-Code.md)) and the repository's portability. AStack instead keeps:

- one Graphify section in `AGENTS.md`, read by both runtimes;
- four MCP tools on the existing `astack` server (`astack_graph_query`, `astack_graph_explain`, `astack_graph_path`, `astack_graph_affected`), so no extra server per runtime;
- one line in the session-start context: graph size, freshness and the budget;
- budgets and metering in AStack, not in the runtime.

## Setup

```bash
astack graphify setup      # uv tool install graphifyy (falls back to pipx, then pip --user),
                           # graphify hook install, first build
astack graphify upgrade    # move Graphify to its latest release
astack graphify status     # version, freshness, git hooks, budget, tokens served, savings
```

The build is AST-only: local, no model calls, no API key. The git hooks rebuild the graph after every commit and checkout; after a pull or a large uncommitted change run `astack graphify build`. `graphify-out/` is git-ignored because it is machine-local (the hook install also registers a merge driver in `.gitattributes`, which is unnecessary while the directory is ignored).

## Asking the graph

```bash
astack graphify query "how does a mission resume after approval" [--budget 1500]
astack graphify explain "MissionEngine"
astack graphify path "ChiefOfStaff" "ToolRegistry"
astack graphify affected "detectRuntime"      # impact before a change
astack graphify benchmark                      # Graphify's own token benchmark, cached for status
```

## Token control

```yaml
graphify:
  enabled: true
  package: graphifyy
  output: graphify-out
  query_budget: 1500   # default cap per answer
  max_budget: 4000     # a requested --budget never exceeds this
  git_hooks: true
```

- `query` passes the budget to Graphify's own traversal; `explain`, `path` and `affected` are trimmed to it on a line boundary. A trimmed answer says so and how to widen it.
- Every successful answer is appended to `.astack/context/graphify-usage.jsonl`. `astack graphify status` reports queries, tokens served, how many hit the cap, and the estimated tokens saved against the benchmark's naive corpus cost.
- A stale graph (HEAD moved past `built_at_commit`, or files changed after the build) is flagged in every answer and in the session-start line.

On this repository at release: 3,052 nodes, 4,672 edges; Graphify's benchmark measured 25.5× fewer tokens per query (~8,000 against ~203,000 naive), and AStack's default budget caps each answer at 1,500 tokens.

## Limits

- Documents, PDFs and images need semantic extraction with a model (`graphify extract . --backend ...`); AStack's build is code-only, so for prose keep using `astack context map` and the document maps.
- Graphify must be installed per machine; without it the tools answer with the setup command and nothing else changes.
