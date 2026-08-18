# Providers

Providers are abstract manifests under `providers/` — one directory per AI runtime, each with a `manifest.json`. The registry lists them; the Orchestrator picks `claude-code` as the default execution provider when present.

## Shipped Providers
`claude-code` (primary), `openai`, `codex`, `gemini`, `openrouter`, `ollama`, `deepseek`, `local-models` — eight in total, mirrored by the `models.providers` block in `astack.config.yaml` (enable flags, default models, endpoints such as the local Ollama URL).

## Model Routing
`models.routing` maps task types to providers (planning, coding, review, local). Agents carry a `provider` field (default `claude-code`) so a mission can be earmarked for a specific runtime; the work order records it.

## Adding A Provider
Create `providers/<id>/manifest.json` — no core modification is required:

```json
{ "id": "my-provider", "name": "My Provider", "kind": "llm", "models": ["default"] }
```

Then enable it under `models.providers` in `astack.config.yaml` if it should participate in routing.
