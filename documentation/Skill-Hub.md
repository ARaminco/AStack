# Skill Hub

The skill hub (`skill-hub/`, `runtime.skillHub`) imports third-party skills in
the open [agentskills.io](https://agentskills.io) / Anthropic `SKILL.md` format
into **auxiliary packs**, scans them, and offers them to the skill catalog
*below* AStack's built-in and learned skills.

Imported skills are data. Nothing in a pack is executed, imported or required by
the import, the scan, the catalog or the selection. A skill that ships scripts
is marked `requiresReview: true` and stays a document until a person decides to
use it.

## Layout

```
skill-hub/
  frontmatter.mjs   tolerant YAML front-matter parser (never throws, never evaluates)
  scanner.mjs       static security scanner
  sources.mjs       local folder, git URL, GitHub owner/repo/path (+ #ref)
  importer.mjs      discovery, description, byte-for-byte copy, compat detection
  skill-hub.mjs     SkillHub: packs, entries, search, show, import, scan, remove
  curator.mjs       keep / refine / retire report over every skill source
  service.mjs       daemon service (optional update check, check only)
skill-packs/
  .gitattributes    "* -text": pack files are stored byte for byte
  <pack>/
    <skill-id>/     the upstream skill folder, unchanged
    catalog.json    generated index (id, name, description, category, tier,
                    keywords, risk, findings, hasScripts, compat, upstream, license)
    PACK.md         source URL, commit, licence, import date, excluded files
    SCAN.md         risk counts and every high/blocked finding with file:line
    LICENSE         attribution header + upstream licence, verbatim
.astack/skill-hub/  cache/ (shallow clones), staging/, trash/, curation.json, updates.json
```

`skill-packs/` is a managed directory (shipped with the core and copied by
`astack upgrade`); it is kept separate from `skills/` so a pack can never shadow
or modify a built-in skill.

## Commands

```
astack skill pack list
astack skill pack search "<query>" [--pack <name>] [--limit 8] [--raw]
astack skill pack show <pack>/<skill-id>           # SKILL.md + live scan summary
astack skill pack import <source> --pack <name> [--path a,b] [--dry-run]
astack skill pack scan <pack>                      # re-scan, refresh catalog.json and SCAN.md
astack skill pack remove <pack>                    # moved to .astack/skill-hub/trash/
astack skill pack updates                          # compare git-sourced packs with upstream
astack skill catalog --packs                       # catalog with pack skills appended
astack skill curate [--apply] [--source builtin|learned|pack] [--all]
```

A source is a local folder, a git URL (`https://…/repo.git#ref`) or a GitHub
shorthand `owner/repo[/path][#ref]`. Remote sources are shallow-cloned into
`.astack/skill-hub/cache/` with `git clone --depth 1`, after the URL passes
`runtime.automationPolicy.allowHost` and the invocation passes `allowInvocation`.
The commit and origin of a checkout are read from `.git/` files directly; git is
never run inside an untrusted checkout. Imports and removals are recorded in
`runtime.audit`.

Import pipeline: discover every folder holding `SKILL.md` → copy it byte for byte
into `.astack/skill-hub/staging/<pack>` (binaries, symbolic links and files over
2 MB are excluded and listed) → scan the staged copy → write `catalog.json`,
`PACK.md`, `SCAN.md`, `LICENSE` → move the previous pack version to the trash →
swap the staged pack into place. `--dry-run` writes nothing.

Tiers: when a skill lives under `skills/` or `optional-skills/` of the source,
its `tier` is `core` or `optional`; the next path segment is its `category`.

## Scanner

Static and conservative. Each finding has a class, a severity and `file:line`.

| Class | Examples | Severity |
| --- | --- | --- |
| injection | "ignore previous instructions", "you are now", concealment from the user, jailbreak markers, agent-directed HTML comments | high; critical inside an HTML comment |
| hidden-text | zero-width characters (a Persian ZWNJ between letters is allowed), bidi controls | medium / high; critical in code |
| pipe-to-shell | `curl … \| sh`, `bash <(curl …)`, `iwr … \| iex`, encoded PowerShell | high |
| credential-access | `~/.ssh`, `~/.aws/credentials`, `.env` reads, keychains, browser profiles, `credential://` | medium / high |
| exfiltration | request catchers, pastebins, chat webhooks, raw-IP URLs | medium / high; credential access plus exfiltration in one script is critical |
| destructive | `rm -rf /`, `format c:`, `del /s`, `mkfs`, fork bombs | critical (one step lower when the line is a warning) |
| obfuscation | `eval(atob(…))`, `base64 -d \| sh`, long base64/hex blobs | critical / medium |
| binary | executables (critical), other binaries (low), symlinks, oversized files | |
| script | any script file: informational, but sets `requiresReview` | info |

Risk of a skill is its worst finding: `low`, `medium`, `high` (status `review`,
down-ranked) or `blocked` (critical; never listed for selection, still
inspectable with `show`).

## Catalog integration

`SkillCatalog` receives the hub as an optional `hub` option (append-only):

- `list()`, `catalog()`, `stats()` are unchanged by default; `includePacks: true`
  (CLI `--packs`) appends pack skills after every built-in and learned skill.
- `search()` returns the same built-in/learned hits as before; when packs are
  enabled, pack hits fill the remaining slots *below* them.
- `select(request)` returns `{ primary, auxiliary, all }`; the Chief of Staff
  attaches it to the brief as `catalogSkills`, and `astack ask` prints it while
  packs are enabled.
- Pack entries carry `source: "pack:<pack>"`, `auxiliary: true`, `risk`,
  `compat`, `tier`, `category`. Scores are multiplied by `skills.packs.weight`
  (0.6), by `review_penalty` (0.8) for high-risk skills and by `runtime_penalty`
  (0.5) for skills marked `compat: hermes-runtime`.
- With `skills.packs.enabled: false` every output is byte-identical to a core
  without the hub (covered by `tests/verify-skillhub.mjs`).

## Curator

`astack skill curate` reports, per skill: uses and success rate (episodes whose
`skill` field names it, plus a learned skill's own metrics), last use,
duplicates and near-duplicates across sources (Jaccard over keywords, tags and
description; ≥ 0.5 duplicate, ≥ 0.3 near-duplicate) and a recommendation:

- **retire** — blocked pack skill; failing (≥ 4 uses, < 50 % success); a pack
  skill duplicating a built-in or learned one.
- **refine** — unreliable (≥ 3 uses, < 75 %); high-risk pack skill; overlaps
  another skill; learned skill unused for 120 days.
- **keep** — everything else. Built-in skills are never retired.

Without `--apply` nothing changes. With `--apply`, learned skills are set to
`deprecated` through the learning engine and pack skills are listed in
`.astack/skill-hub/curation.json` as retired; both are reversible and no file is
deleted.

## Configuration

Optional; defaults apply when the section is absent:

```yaml
skills:
  packs:
    enabled: true
    weight: 0.6
    runtime_penalty: 0.5
    review_penalty: 0.8
    update_check: false
    update_check_hours: 24
```

## Daemon service

`skill-hub/service.mjs` implements the service contract. With
`update_check: true` it runs `git ls-remote` for each git-sourced pack every
`update_check_hours`, writes `.astack/skill-hub/updates.json` and emits
`skill-hub.update-available`. It never imports or changes a pack.

## The Hermes pack

`skill-packs/hermes/` holds the 211 skills of
[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
(`skills/` → tier `core`, `optional-skills/` → tier `optional`) at commit
`79651b71bd56efd76d06f3de1df64dde09b58ff3`, MIT licence. See its `PACK.md` and
`SCAN.md`. Skills that depend on Hermes' own tools, CLI or gateways are marked
`compat: hermes-runtime` and down-ranked. To refresh it:

```
astack skill pack import NousResearch/hermes-agent --pack hermes --path skills,optional-skills --dry-run
```

`tests/verify-astack.mjs` skips `skill-packs/` in its wording check: pack files
are upstream text, copied verbatim.
