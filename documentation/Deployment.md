# Deployment

AStack is a local, Markdown-first agent operating system. Deployment means distributing the repository to the machine or agent environment that will use it — there is nothing to host.

## Distribution Model
- **Canonical repository** — the source of truth (`upgrade.source`). Push here to publish a new core version.
- **Embedded installs** — projects that carry a copy of the core. They pull new versions with `astack upgrade`; installs that predate the engine bootstrap with `scripts/astack-upgrade.mjs`. See [Upgrade.md](Upgrade.md).

## Release Checklist
1. `npm test` — all five suites green. Run `npm run test:browser` too when the browser engine changed.
2. Bump the version in `core/manifest.json`, `package.json`, and `astack.config.yaml` (kept identical).
3. Confirm `astack.config.yaml` contains no secrets and `locales/` covers all supported locales.
4. Confirm memory seed files contain only intentional content.
5. Update documentation for anything user-visible, and `CHANGELOG.md` for the release.
6. Confirm every new capability declares an honest status, and that nothing adapter-ready is described as working.
7. Confirm no credential, personal path or private URL entered a committed file.
8. Confirm `upgrade-engine/manifest.json` lists every new engine directory under `managed` and every owner-data path under `preserve`, and that any data migration is idempotent.
9. Commit, tag `v<version>`, and push to the canonical repository — embedded installs can upgrade from that moment. The tag triggers the release check workflow.
