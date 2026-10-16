# Practice skills (3.5.0)

Five built-in skills carry the day-to-day software practice: planning,
reviewing, debugging, testing and releasing. They replace the thin generic
packs with deep, practical procedures condensed from
[gstack](https://github.com/garrytan/gstack) (MIT; see `NOTICE`).

| Skill | Use it for | Risk |
| --- | --- | --- |
| `plan-review` | before code: scope challenge (expand, selective, hold, reduce), engineering lock-in (architecture, data flow, edge cases, test matrix), design score 0-10 | L1 |
| `code-review` | before merge: two passes, specialists only when the diff triggers them, gate integrity, fix-first, Laravel 12 / Livewire / Filament and Next.js 16 items | L2 |
| `investigate` | any bug: reproduce, root cause, regression test, stop after 3 failed attempts; recipes for flaky tests, races and test polluters | L2 |
| `qa` | exploratory testing of web, API, CLI and webhooks, using the project's own browser; evidence note per probe, regression test before every fix | L3 |
| `ship` | release: tests, review, docs drift, version and CHANGELOG, push and deploy only after owner approval, safe deploy with automatic rollback | L4 |

Older packs stay and point to the new entry points: `security-review`,
`laravel-review`, `node-review` and `filament-review` → `code-review`;
`bug-hunter` → `investigate`; `feature-planner` → `plan-review`.

A typical flow: `plan-review` → implement → `code-review` → `qa` → `ship`.

## The lazy-section convention

Each skill is a short skeleton plus sections:

```
skills/<id>/
  SKILL.md                 steps and hard rules, about 3 KB
  checklist.md             the executable checklist
  skill.json               catalog entry; "sections" points at the manifest
  sections/manifest.json   id, file, title and trigger of every section
  sections/<name>.md       detail for one step
```

The skeleton names the section to open at each step ("open
`sections/security.md` when the diff touches auth"). An agent reads the
skeleton, then only the sections its task reaches. A small diff review loads
the skeleton and two or three sections instead of the whole procedure; the
manifest is a passive index for tools and humans and never decides by itself.

Rules for writing a section:

- one step or one specialist per file, actionable lines only;
- no duplicated rules between skeleton and sections;
- trust rules (approval before irreversible actions, owner types passwords, no
  secrets in files) stay in the skeleton so they are always loaded;
- owner-facing output follows `system/language-policy.md` (Persian), code and
  commands stay English.

```bash
astack skill search "review my diff"     # finds code-review
astack skill show qa                     # the skeleton only
```
