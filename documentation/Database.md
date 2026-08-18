# Database

AStack itself requires no database. All platform state is plain files, versionable and inspectable:

- Durable memory: Markdown under `memory/` (eleven scopes).
- Operational state: JSON under `.astack/` — projects, teams, agents, backups, upgrade cache.

This is deliberate: an agent runtime can read, diff, and repair every byte of state with ordinary file tools, and backups are simple copies.

## For Applications Built With AStack
PostgreSQL is the preferred default for owner projects. Database reviews (the `database` department and `database-review` skill) check schema design, migrations, indexes, constraints, query plans, transactions, backup and restore paths, and data lifecycle choices. Database names, tables, and columns follow the English-assets language policy.
