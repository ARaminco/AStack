# Plugins

Plugins are isolated directories under `plugins/`, each with a `plugin.json` manifest declaring `type`, `entry`, `status`, and `compatibility`. The registry (`plugins/plugin-registry.mjs`) discovers them at runtime; `astack plugin` lists them.

## What Plugins Are For
Extending AStack without touching the core: additional roles, review protocols, provider adapters, domain knowledge, or workflow variants. The architecture rule is strict — new capability enters through manifests (providers, plugins, domains, departments, workflows, knowledge packs), never through edits to the Orchestrator.

## Upgrades
The registry file is core-managed; the `plugins/` content directory is **preserved** — `astack upgrade` never touches installed plugins.

## Authoring
```
plugins/<plugin-id>/
  plugin.json      # { "id", "type", "entry", "status", "compatibility" }
  ...entry files
```

Keep plugin code and manifests in English; ship owner-facing strings through the locale files.
