### Smarter recall: `astack search` (P3)

- New `search-engine/`: one index over memory records, past Claude Code and Codex
  sessions for this workspace, markdown reports, the skill catalog and missions.
  `runtime.search.query / index / status` implement the v3 contract.
- SQLite FTS5 (BM25) through `node:sqlite` at `.astack/search/index.db`; on Node
  older than 22.5 the same API falls back to an in-memory BM25 index with a clear
  message.
- Persian-aware normalization at index and query time: ی/ي/ى, ک/ك, ه/ة/ۀ, Persian
  and Arabic digits, harakat, tatweel, ZWNJ as a word break plus joined aliases.
- Optional semantic layer: Ollama `bge-m3` embeddings stored as BLOBs, hybrid
  ranking by reciprocal rank fusion; `--semantic auto|on|off`.
- Incremental reindex by fingerprint, content hash and parser version.
- Secrets never indexed: credential-named files skipped, assignments and known
  token shapes redacted.
- Memory search respects supersede: current facts by default,
  `--include-superseded` for history, `--as-of` for a point in time.
- `astack search owner-profile`: deterministic owner profile from identity,
  preference and decision memories plus recent sessions.
- `astack memory search` and `astack context search` show "also found in past
  sessions" when the index exists (unchanged output otherwise).
- Daemon service `search-engine/service.mjs` for periodic incremental reindex.
- New test suite `tests/verify-search.mjs` (appended to `npm test`).
