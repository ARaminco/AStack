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
