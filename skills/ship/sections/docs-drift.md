# Documentation drift

Goal: every user-facing or operator-facing behaviour changed in this release is
described correctly somewhere a reader will look.

1. **Inventory** tracked and new docs: README*, `documentation/`, `docs/`,
   CLAUDE.md / AGENTS.md (outside managed blocks), CLI `--help` text, API specs
   (OpenAPI), `.env.example`, config references, runbooks. Skip dependencies,
   build output and generated files (edit their sources instead).
2. **Map the diff to claims:** for each changed command, flag, route, config
   key, env var, default value, migration or workflow, grep the docs for it.
3. **Classify each hit:**
   - factual and stale (wrong flag name, removed option, old default): fix it;
   - missing (new env var not in `.env.example`, new command undocumented): add
     a short factual entry;
   - narrative, security or removal changes, or anything uncertain: do not
     rewrite; list it for the owner.
4. **Preserve owner content:** change only the stale part, never reformat a
   file, never touch manually styled sections beyond the fix.
5. **Diagrams:** ASCII diagrams in touched docs and code comments that no longer
   match the flow are stale; update or flag them.
6. **Result line** for the summary: `Docs: current` | `Docs: updated <files>` |
   `Docs: blocked <reason>`. At most one repair round; a second drift goes to
   the owner.
