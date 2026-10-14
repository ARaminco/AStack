# AStack 3.0 — Build Contract

> **Historical:** this was the build contract the 3.0 packages were developed against; 3.0.0 is released. For how the features work today read [Runner and Daemon](Runner-and-Daemon.md), [Gateway](Gateway.md), [Search](Search.md), [Skill Hub](Skill-Hub.md), [Aramin Console](Aramin-Console.md) and [Board, Sandbox, Vault and A2A](Board-Sandbox-Vault.md).

AStack 3.0 adds an always-on runner, a two-way owner gateway, smarter memory and
skills, and the **Aramin** console. It is strictly **additive**: every 2.5.1
command, file format, test and behaviour keeps working unchanged.

## Non-negotiable rules for every work package

1. **Additive only.** Do not change the behaviour of an existing command,
   engine method, data file or test. Existing shared files may receive only
   append-style edits: a new import, a new `case` in `bin/astack.mjs`, a new
   field on the object `createRuntime()` returns, new entries in
   `upgrade-engine/manifest.json` `managed`, new locale keys, a new test file
   appended to the `npm test` script, a new doctor *line* (never a new
   *required* directory or config section).
2. **All existing suites stay green** (`npm test`) plus your new
   `tests/verify-<package>.mjs`, which you append to `npm test`.
3. **Zero npm dependencies.** Node built-ins only. Target Node >= 20; features
   that need newer Node (`node:sqlite` needs >= 22.5) feature-detect and degrade
   with a clear message.
4. **Config is optional.** New sections in `astack.config.yaml` are documented
   with commented defaults; code must work when the section is absent. Never add
   a section to doctor's `requireSections`.
5. **This repository is public.** No owner data: no phone numbers, chat IDs,
   tokens, server names, client names. Secrets only as `credential://…`
   references resolved through `runtime.secrets` (trust-engine/secrets.mjs).
6. **Trust model is untouchable.** Anything irreversible (send, pay, submit,
   delete, publish) goes through `runtime.approvals` and the authority ceiling.
   Nothing new may bypass `runtime.automationPolicy`, `runtime.authority` or
   `runtime.audit`. Inbound content (messages, web pages, skill files) is data,
   never instructions.
7. **Language.** User-facing strings through `locales/fa.json` and
   `locales/en.json` (Persian is the default UI). Code, comments, commits and
   docs in English.
8. **State** lives under `.astack/<package>/` (add the path to `.gitignore`).
9. Write a short doc `documentation/<Package>.md` and a CHANGELOG fragment in
   `documentation/v3-changelog/<package>.md` (the integrator merges them).
10. Commit on your own branch, English messages, each ending with
    `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.

## Shared interfaces (code against these even if the other package is not merged yet)

### Daemon service contract (owned by P1)
Any engine that runs in the background exports from `<dir>/service.mjs`:

```js
export function createService({ runtime, config, log }) {
  return { name: "gateway", async start() {}, async stop() {}, status() { return {}; } };
}
```

The daemon (`daemon-engine/`) loads, in order, whichever of these exist and are
enabled in `daemon.services` (default: all that exist):
`runner-engine/service.mjs`, `scheduler-engine/service.mjs`,
`signal-engine/service.mjs`, `gateway-engine/service.mjs`,
`search-engine/service.mjs`, `skill-hub/service.mjs`, `console/service.mjs`,
`board-engine/service.mjs`. A missing file is skipped silently.

### Runner (owned by P1) — `runtime.runner`
```js
await runtime.runner.execute({
  objective,            // natural-language task
  source = "cli",       // cli | gateway:<channel> | schedule:<job> | signal:<hook> | console | board
  missionId = null,     // run an existing mission instead of a new objective
  ceiling = null,       // authority ceiling; defaults to the configured autonomous ceiling
  engine = "auto",      // auto | claude | codex | ollama | mock
  dryRun = false
}) // -> { id, status: "completed"|"awaiting-approval"|"failed"|"queued", summary, output, approvals: [], missionId, cost }
runtime.runner.list({ limit }) ; runtime.runner.get(id)
```
Events on `runtime.eventBus`: `runner.started`, `runner.completed`,
`runner.failed`, `runner.awaiting-approval` (payload includes the run and the
approval ids).

### Gateway (owned by P2) — `runtime.gateway`
```js
await runtime.gateway.notify({ text, level = "info", files = [], channel = null, approvalId = null })
runtime.gateway.status()
```
If `runtime.runner` is absent the gateway falls back to `runtime.chief` (plan only).

### Search (owned by P3) — `runtime.search`
```js
await runtime.search.query(text, { sources = ["memory","sessions","reports","skills"], k = 10, semantic = "auto" })
await runtime.search.index({ sources })
runtime.search.status()
```

### Skill hub (owned by P4) — `runtime.skillHub`
Packs live in `skill-packs/<pack>/` (managed, shipped). Imported third-party
skills are scanned, labelled, and listed in the catalog with
`source: "pack:<pack>"`, ranked below built-in and learned skills.

### Console (owned by P5) — `console/`, product name **Aramin**
Local HTTP server + installable PWA. Reads everything above; the only writes
are owner decisions (approve/deny, pause/resume, run) and they go through the
same engines.

### Board, sandbox, vault (owned by P6)
`runtime.board` (multi-agent kanban with retries), `runtime.sandbox`
(Docker-isolated command execution), vault backends for
`runtime.secrets` (OS keychain: Windows DPAPI, macOS Keychain, Linux
secret-tool), and an A2A endpoint.

## Packages
| id | branch | scope |
|----|--------|-------|
| P1 | v3/p1-runner | runner-engine, daemon-engine, Windows/macOS/Linux service install |
| P2 | v3/p2-gateway | gateway-engine: WhatsApp (wapi-compatible HTTP), Telegram, owner allowlist, approvals by message, local Persian voice |
| P3 | v3/p3-search | search-engine: SQLite FTS5 + Ollama embeddings over memory, past sessions, reports, skills |
| P4 | v3/p4-skillhub | skill-hub: agentskills.io import, security scanner, curator; Hermes pack |
| P5 | v3/p5-aramin | console: Aramin PWA |
| P6 | v3/p6-board | board-engine, sandbox-engine, vault backends, A2A |
