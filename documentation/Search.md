# Search: Smarter Recall

`search-engine/` gives AStack one place to ask "where did we see this before?"
across everything the workspace has seen: memory records, past Claude Code and
Codex sessions, reports, skills and missions. It is local, dependency free and
Persian-aware.

```bash
astack search reindex                       # incremental; first run builds everything
astack search "قرارداد اجاره تمدید"          # hybrid when embeddings exist, lexical otherwise
astack search "rollback a failed update" --source reports,sessions --k 5
astack search "hosting provider" --source memory --as-of 2026-06-01
astack search status
astack search owner-profile                 # "who the owner is", deterministic
```

## How it works

| Layer | Implementation |
|-------|----------------|
| Store | `node:sqlite` (Node >= 22.5) at `.astack/search/index.db`: an FTS5 table ranked by BM25 (title weighted 3×), vectors as Float32 BLOBs |
| Fallback | On older Node, or `search.backend: json`, the same API runs on `.astack/search/index.json` ranked in memory with BM25. Every command prints why the fallback is in use |
| Normalizer | `search-engine/normalize.mjs`, applied at index and query time |
| Semantic | Ollama `POST /api/embed`, default model `bge-m3` (multilingual, handles Persian), cosine similarity in JS |
| Ranking | Reciprocal rank fusion (k = 60) of the BM25 list and the vector list; chunks of one session turn or report section collapse into one result |

### Persian normalization

Index and query text go through the same function, so spelling variants meet:

- `ي` `ى` → `ی`, `ك` → `ک`, `ة` `ۀ` → `ه`, `أ` `إ` `آ` → `ا`, `ؤ` → `و`
- Persian `۰-۹` and Arabic-Indic `٠-٩` digits → `0-9`
- harakat and tatweel removed; Arabic presentation forms folded by NFKC; Latin lower-cased
- ZWNJ (U+200C), ZWJ and bidi marks are word breaks, so «پرونده‌ها» matches «پرونده»;
  the joined spelling of every ZWNJ compound is indexed as an alias, so «میخواهم»
  typed without the ZWNJ still finds «می‌خواهم»
- Arabic-script punctuation (، ؛ ؟) breaks words; terms of three or more letters are
  prefix-matched («قرارداد» finds «قراردادها»)

### Sources

Each source is a module in `search-engine/sources/<id>.mjs` exporting `id`,
`version` and `units(context)`. A unit (file, facet, catalog) has a key, a
fingerprint (mtime and size) and a `read()` that returns documents plus a content
hash. Reindexing is incremental: an unchanged fingerprint is skipped, an unchanged
hash only refreshes the fingerprint, a removed unit leaves the index, and a bumped
`version` re-reads the whole source.

| Source | What is indexed |
|--------|-----------------|
| `memory` | Every memory-engine record. Superseded records keep their validity window: hidden by default, shown with `--include-superseded`, and `--as-of <date>` answers what was believed then. Forgotten records are never indexed |
| `sessions` | Claude Code transcripts in `~/.claude/projects/<slug of the workspace>/*.jsonl` and Codex rollouts in `~/.codex/sessions/**` whose `cwd` is the workspace. Only the owner's words and the assistant's text replies, one document per turn; tool calls, tool output, thinking blocks, injected reminders and IDE wrappers are left out |
| `reports` | Markdown under `search.reports.paths` (default `documentation/`) plus `memory.import_paths`, one document per heading section |
| `skills` | The skill catalog one-liners |
| `missions` | Mission titles, goals, step titles, report summaries and findings |

Queries search `memory, sessions, reports, skills` by default
(`search.default_sources`); add `--source missions` or set the config.

### Secrets

Files whose names look like credentials (`credentials.md`, `.env*`, `*.pem`,
`id_rsa`, names with token / secret / password / api-key) are never opened. Every
stored text passes `search-engine/redact.mjs`: `key: value` / `key=value`
assignments for credential keywords, JWTs, provider key shapes (sk-, ghp_, xox*,
AKIA, AIza, glpat-, bot tokens), private key blocks, `user:pass@` in URLs,
Bearer/Basic headers and long mixed-case opaque strings. Prose such as "Token
Budgets" is left alone.

## Commands

```text
astack search "<query>" [--source a,b] [--k 10] [--semantic on|off|auto] [--as-of DATE]
                        [--include-superseded] [--budget TOKENS] [--json]
astack search reindex [--source a,b] [--force] [--semantic off] [--sessions-root PATH,...] [--embed-limit N]
astack search status [--json]
astack search owner-profile [--budget 900] [--summarise] [--json]
```

- `--semantic auto` (default) uses vectors when the model answers and vectors exist;
  `on` tries and reports why not; `off` stays lexical.
- Results show source, title, path, date, a snippet around the best-matching line
  and a score, within the token budget (`search.budget`, default 1200). Omitted
  results are counted, never silently dropped.
- `--sessions-root` adds another project's sessions for this run (for example the
  repository a worktree was cut from). Configure `search.sessions.project_roots`
  to make it permanent; a later reindex without it removes those sessions.
- `owner-profile` writes `.astack/search/owner-profile.md` and `.json` from
  identity, preference and decision memories plus recent sessions (topics,
  language mix). `--summarise` adds a short summary through `runtime.runner` when
  the runner is installed, with an L1 ceiling; without it the deterministic
  profile is shown and the reason printed.

## Integration

- `runtime.search` implements the contract in `documentation/V3-Plan.md`:
  `query(text, { sources, k, semantic })`, `index({ sources })`, `status()`.
- `astack memory search` and `astack context search` append "also found in past
  sessions" (lexical, no network) when the index exists and has a match. Without
  an index their output is unchanged. Disable with `search.hooks: false` or
  `--no-sessions`.
- `search-engine/service.mjs` is the daemon service: an incremental reindex every
  `search.reindex_every` (default `15m`) and once shortly after start.
- `astack doctor` prints one `Search:` line.

## Configuration

All optional; see the commented `search:` block at the end of
`astack.config.yaml` for every key and its default.

## Semantic layer setup

```bash
ollama pull bge-m3          # ~1.2 GB, one time
astack search reindex       # embeds every document that has no vector yet
```

The GPU is shared: embedding runs only during reindex, in batches of 16, and a
query embeds one short string.
