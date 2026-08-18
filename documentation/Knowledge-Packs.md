# Knowledge Packs

Knowledge Packs are independently installable knowledge modules under `knowledge-packs/`. Each pack bundles best practices, standards, rules, templates, examples, checklists, common mistakes, and recommendations for one topic. Eighteen packs ship with the core.

## Usage
- `astack knowledge` lists installed packs.
- The Orchestrator and skills reference pack content when a request touches the pack's topic.
- Packs are data, not code: adding or editing one requires no core changes.

## Authoring
Create `knowledge-packs/<pack-id>/` with the pack's Markdown content and keep the writing in English (software-asset language policy). Persian summaries belong in owner-facing conversation, not in the pack files.

## Upgrades
The pack registry (`knowledge-packs/knowledge-pack-registry.mjs`) is core-managed, but the `knowledge-packs/` content directory is **preserved** during `astack upgrade` — packs you install or customize are never overwritten. New packs arriving with a core version appear only in fresh clones or when copied manually.
