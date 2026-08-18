# Memory Engine

The Memory Engine (`memory-engine/memory-engine.mjs`) persists durable context as Markdown files under `memory/`, one file per scope. Memory survives upgrades — the directory is on the upgrade engine's preserve list.

## Scopes
Eleven scopes: `global`, `project`, `department`, `role`, `team`, `agent`, `decision`, `coding-standards`, `architecture`, `business`, `user-preferences`.

- `team` and `agent` were added in version 2: every agent dispatch and report is appended to `agent`, giving a permanent audit trail of delegated work.
- `decision` doubles as the **calibration feed**: closed projects append effort-ratio entries, and the delivery engine reads them back to calibrate future duration estimates (`ProjectEngine.calibration`).

## API
```js
runtime.memory.scopes();            // list scope names
runtime.memory.read("decision");    // full scope text
runtime.memory.append("team", "kickoff decisions ...");
runtime.memory.backup();            // snapshot all scopes under .astack/backups/
```

`astack memory` lists scopes; `astack backup` writes a timestamped snapshot.

## Conventions
- Entries are append-only bullet lines; keep them short, factual, and in English (they are stored data).
- Structured entries use `[tag] key=value` form (see the calibration and agent entries) so they stay machine-readable.
- Sprint retrospectives and recorded project decisions land in `decision` automatically.
