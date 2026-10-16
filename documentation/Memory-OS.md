# Memory OS

AStack does not keep conversations. It keeps structured, temporal memory and
retrieves only what a request needs.

## Facets

| Facet | Holds | Half life |
| --- | --- | --- |
| identity | stable facts about the owner | 10 years |
| semantic | facts and long lived knowledge | 240 days |
| episodic | what happened, per episode | 45 days |
| project | project state, history, open items | 180 days |
| entity | people, companies, systems, cases | 365 days |
| relationship | how entities relate | 365 days |
| procedural | how work is done | 365 days |
| decision | decisions and their reasoning | 540 days |
| preference | owner preferences and patterns | 720 days |
| working | short lived session context | 2 days |
| calibration | estimate versus actual | 120 days |
| lesson | what failure taught | 300 days |

Every record carries provenance and validity:

```json
{
  "id": "sem-6a1c9f0b2d",
  "facet": "semantic",
  "subject": "Acme",
  "predicate": "accountant",
  "object": "Sara",
  "title": "accountant of Acme",
  "body": "Sara replaced John",
  "entities": ["company:acme", "person:sara"],
  "validFrom": "2026-02-19T08:00:00.000Z",
  "validTo": null,
  "supersedes": "sem-3d77aa10c4",
  "supersededBy": null,
  "confidence": 0.6,
  "importance": 0.5,
  "weight": 1,
  "hits": 3,
  "source": "conversation-summary"
}
```

## Temporal truth

Facts are replaced, never erased:

```bash
astack memory supersede sem-3d77aa10c4 "accountant of Acme" --object Sara
astack memory search "accountant Acme"                    # returns Sara
astack memory search "accountant Acme" --asOf 2026-01-20  # returns John
```

## Retrieval

`recall()` combines BM25 lexical relevance, recency decay per facet, stored
confidence, importance and how often a record proved useful. When the words do
not match but the engagement is known, it falls back to what belongs to that
domain, project or entity.

`brief()` renders a recall result inside a token budget, which is what the
context router embeds in a request package.

## Consolidation

`astack memory consolidate` merges near duplicates, decays stale weights, drops
expired records and compacts the JSONL files. It runs nightly through the
scheduler by default.

## Commands

```bash
astack memory search "<query>" [--facet decision] [--asOf 2026-01-20]
astack memory remember "<title>" --facet decision --body "<why>"
astack memory supersede <id> "<new title>" --object "<new value>"
astack memory entity "Company A"
astack memory context "<query>"
astack memory consolidate
astack memory stats
```

## Active memory (3.3.0)

Long-term memory is the facet store above: large, searchable, recalled on
demand. Active memory is the small working set that is always in context,
kept as named blocks with a character limit:

| Block | Holds |
| --- | --- |
| `owner/<label>` | the owner's standing facts |
| `project:<id>/<label>` | one project's decisions and state |
| `case:<id>/<label>` | one case's state, hearings, counsel |
| `agent:<id>/persona` | who the agent is (seeded at creation, kept across missions) |
| `agent:<id>/goals` | what the agent works toward now (follows each brief) |
| `<scope>/key-facts` | maintained by `memory reflect` |

```bash
astack memory active --project nobatgir --case 2026-003 --agent legal-drafter
astack memory block set case:2026-003/state -- "Hearing 20/10/2026, Dubai Court"
astack memory block append case:2026-003/state -- "Counsel replaced"
astack memory block replace case:2026-003/state --old="20/10" --new="27/10"
astack memory block history case:2026-003/state
astack memory block restore case:2026-003/state 1
astack memory reflect --dry-run
```

- Every edit is a new version in `.astack/memory/blocks/blocks.jsonl`; nothing
  is overwritten in place.
- An append that would overflow moves the oldest lines into the facet store,
  bound to the block's project or case.
- Secrets and instruction-like text are refused; read-only blocks change only
  with `--force` from the CLI.
- `reflect` writes `<scope>/key-facts` from the records that matter most and
  skips any key-facts block a person edited.

## Task-scoped recall

`astack memory search "<query>" --case 2026-003` (or `--scope
project:<id>,case:<id>`) returns what belongs to that case plus unbound
general knowledge. A record bound to another case or project is never
returned. Store case facts with `--case <id>` so they stay in their case. The
context router applies the scope automatically when the request names a known
project or Case node.
