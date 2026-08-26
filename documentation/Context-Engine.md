# Context Engine

The context engine is the token budget of the platform. It keeps an incremental
index of the workspace, ranks it, and renders a map that fits a budget — for a
code repository, a legal case folder or an accounting archive alike.

## What it indexes

- **Code**: symbols (classes, functions, exported constants, types, tables),
  imports, per file term index.
- **Documents**: heading outline, links, first paragraph summary.
- **Data and config**: top level keys, sections, CSV headers.
- **Opaque files** (PDF, office, images, audio): metadata only, flagged so the
  reader knows to use a reader skill instead of guessing.
- **Domain records**: case numbers, parties, hearings, statutes, invoices,
  IBANs, account codes, fiscal periods, tax ids, routes, env vars, tables.

Domain records are what make the map work outside software: two documents that
share a case number or an invoice number are linked in the graph exactly the
way two source files are linked by an import.

## Ranking

1. Build the graph: imports, document links, shared record clusters.
2. Run a personalized PageRank seeded by the query and the owner's pins.
3. Combine graph authority, query focus, recency, record density, critical paths
   and the domain lens into one explainable score.

The domain lens steers browsing but never overrides retrieval: a strong query
match is not penalised because the active lens prefers another kind of file.

## Budgeted rendering

Three levels of detail are used — deep (members with line anchors), outline
(one headline per file) and path (grouped listing). Whatever does not fit is
reported explicitly:

```
## omitted
- 259 files and 1229 members are indexed but not printed (150.0k tok)
- reveal with: astack context query "<terms>" | astack context expand <path>
```

Precision is never traded for compression: the map is an index with line
anchors, and `expand` returns the full structure of any file on demand.

## Freshness

The index records size, mtime and a content hash per file. `verify()` reports
stale, added and missing files, and the map declares its own freshness in the
header. A stale map is refreshed before it is served, never silently returned.

## Commands

```bash
astack context build [--force]
astack context map "<query>" [--budget 4000] [--print]
astack context search "<query>" [--limit 10]
astack context expand <path>
astack context related "<entity or symbol>"
astack context stats
astack context refresh
astack context pin <path>
```

## Measured, not claimed

`astack context stats` reports tokens rendered, tokens avoided and the savings
ratio from real usage. On this repository a 2.4k token map replaces a 181k
token corpus.
