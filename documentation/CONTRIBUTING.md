# Contributing

- Use Conventional Commits; keep commit messages, code, comments, and identifiers in English.
- Keep owner-facing strings Persian and route them through `locales/` (en + fa complete; ar/tr optional).
- Extend through manifests (domains, departments, roles, workflows, templates, providers, plugins, knowledge packs) — do not add special cases to the Orchestrator.
- When a catalog changes, update the count assertions in `tests/verify-astack.mjs` and run `npm test` (all three suites) before committing.
- Keep documentation accurate: any user-visible change updates the matching page in `documentation/` and, when counts change, the audit page.
- Preserve upgrade safety: new engine paths belong in `upgrade-engine/manifest.json` under `managed`; owner-data paths belong under `preserve`.
