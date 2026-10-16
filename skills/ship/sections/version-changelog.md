# Version and CHANGELOG

## Version
1. Find the version source(s): `VERSION`, `package.json`, `composer.json`,
   `core/manifest.json`, an app config constant. If several exist they must
   agree; disagreement stops the step until the owner says which is right.
2. Already bumped on this branch (differs from base)? Keep it; do not bump twice.
3. Choose the level from the diff:
   - **patch:** fixes, small changes, no new capability;
   - **minor:** a new capability, route, page, command or migration: ask the
     owner with your recommendation;
   - **major:** breaking change for users, API clients or upgrades: ask.
4. The project has no version at all: ship without one; never invent `0.0.0`.
5. Write every version source in one change; read them back.

## CHANGELOG
1. Read the file's header and the last entry to copy its format exactly
   (heading style, date format, sections).
2. List every commit since base (`git log <base>..HEAD --oneline`) and read the
   diff; group by theme (features, fixes, performance, security, internal).
3. Write one entry for the new version, above the previous one. Lead with what a
   user can now do; plain language; no internal tracking ids.
4. Cross-check: every user-facing commit is represented; merges and fixes to
   work introduced on the same branch need no line.
5. Never put secrets, client names or case data in a CHANGELOG.
