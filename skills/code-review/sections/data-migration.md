# Data migration specialist

Output format as in `security.md`. Production data loss is CRITICAL on sight.

## Reversibility
- A real `down()`/rollback exists and undoes the change; rolling back does not
  break the code that will be running.

## Data loss
- Dropping columns or tables that still hold data or are still read (deprecate
  first, drop in a later release).
- Type changes that truncate (`varchar(255)` to `varchar(50)`, decimal scale).
- Renames without updating every reference (ORM, raw SQL, views, reports).
- `NOT NULL` added to a column that holds nulls, without a backfill first.

## Locks and duration
- Schema changes on large tables that take long exclusive locks (MySQL
  `ALTER` without an online algorithm, PostgreSQL index without
  `CONCURRENTLY`); several `ALTER`s that could be one.
- Backfills updating every row in one statement instead of batches.

## Indexes
- Missing index on a new foreign key; duplicate indexes; unique indexes added
  over data that already has duplicates.

## Deploy order
- Old code plus new schema (or the reverse) during a rolling deploy must both
  work. Expand, migrate, contract: add nullable, backfill, switch code, enforce,
  remove later.
- Migrations that need a feature flag or a separate release; seeders or data
  fixes that run in production without being idempotent.
- Before running on a shared production server: a fresh backup and a tested
  restore command (owner rule, see `ship`).
