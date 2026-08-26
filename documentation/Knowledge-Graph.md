# Knowledge Graph

A temporal graph of the entities an owner actually works with.

## Types

Person, Company, Project, Case, Document, Account, Transaction, Website,
GovernmentPortal, Task, Decision, Event, Skill, Workflow, Tool,
CredentialReference, Agent, Team.

## Relationships

works_with, works_for, owns, contains, involves, belongs_to, operates,
performed, produced, related_to, supersedes, depends_on, authorized_by,
located_in, represents.

## Temporal validity

An exclusive relationship supersedes the previous one instead of overwriting it:

```bash
astack graph add "Company A" --type Company
astack graph add "John Miller" --type Person
astack graph relate --from company:company-a --type works_with --to person:john-miller --exclusive
# months later
astack graph relate --from company:company-a --type works_with --to person:sara --exclusive
astack graph neighbours company:company-a                      # Sara
astack graph neighbours company:company-a --asOf 2026-03-01    # John Miller
astack graph history company:company-a
```

## Resolution

`resolve()` matches a mention by name, alias and token overlap, which is how
"the accountant of Company A" is answered in a new session without loading any
history. `expand()` walks one hop out so the context router can pull in the
neighbourhood of a match without dragging in the whole graph.

## Storage and adapters

The default backend is two append only JSONL files under `.astack/graph`.
The engine's surface — upsertNode, relate, neighbours, expand, resolve, lookup,
history, stats, compact — is deliberately narrow so a SQLite or external graph
backend can replace it without touching callers.
