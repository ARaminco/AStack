# Localization

## Policy
Persian (`fa`) is the owner-facing language: conversation, reports, planning, review, progress, errors. English is the asset language: code, comments, identifiers, commits, database and API names, stored data, and this documentation. The full matrix lives in `astack.config.yaml` under `language`, and the global policy in `system/language-policy.md`.

## Locales
Four locales ship in `locales/`: `fa` (RTL), `en`, `ar` (RTL), `tr`. Selection order:

1. `ASTACK_LOCALE` environment variable
2. `cli.default_locale` in `astack.config.yaml` (default `fa`)
3. Fallback locale (`en`) for any missing key

`ar` and `tr` carry core strings and inherit everything else from English via the fallback chain, so the CLI never breaks on a missing key.

## Adding Strings
Add the key to `locales/en.json` **and** `locales/fa.json` (the two complete catalogs); `ar`/`tr` entries are optional. Keys are namespaced (`cli.agent.assigned`, `delivery.phase.execution`) and support `{placeholders}`:

```js
i18n.t("cli.agent.assigned", { id, agent, next })
```

## Detection Languages
Domain and workflow keyword detection is bilingual by design: every domain in `domains/domains.json` and every workflow in `workflow-engine/workflows.json` carries Persian and English keywords, so `astack domain detect` classifies «اظهارنامه مالیات» and "tax filing" identically.

## Owner Guides
Reader-facing entry points exist per language: [README.fa.md](../README.fa.md), [README.md](../README.md) (English), [README.ar.md](../README.ar.md), [README.tr.md](../README.tr.md), plus the full Persian guide [fa-guide.html](fa-guide.html).
