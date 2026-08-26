# Token Optimization

Token efficiency is a design constraint, not an afterthought.

## Budgets

Configured in `astack.config.yaml`:

```yaml
context:
  owner_capsule_budget: 800
  memory_budget: 2500
  project_budget: 3500
  repo_map_budget: 2000
  skill_budget: 3000
  tool_catalog_budget: 500
  retrieval_budget: 12000
  max_files: 8
```

Every producer respects its budget: the owner capsule, the memory brief, the
project block, the workspace map, the skill catalog and the tool catalog each
render inside their allowance, and the router stops before the total.

## The rules the platform follows

1. Never resend large static instructions.
2. Never load all roles, skills, memories, tools, files or documents.
3. Never send raw histories between agents; use structured handoffs.
4. Prefer identifiers and references over duplicated content.
5. Cache stable structural knowledge and invalidate by content hash.
6. Retrieve progressively: catalog, then selection, then full content.
7. Report what was omitted so nothing is silently lost.
8. Track estimated tokens avoided and show them.

## Progressive disclosure in practice

| Surface | Startup cost | Full cost on demand |
| --- | --- | --- |
| Owner identity | ~50-800 tokens | profile file |
| Workspace | ~2000 token map | `context expand <path>` |
| Skills | ~600 token catalog | `skill show <id>` |
| Tools | ~500 token catalog | `tool inspect <id>` |
| Memory | ~2500 token brief | `memory search` |

## Measuring

```bash
astack context stats     # tokens rendered, tokens avoided, savings ratio
astack skill stats       # catalog size
astack tool stats        # catalog size
astack doctor --verbose  # index size and savings
```
