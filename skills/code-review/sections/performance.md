# Performance specialist

Give each finding its scale (rows, requests per second, bytes) or say "scale
unknown"; never invent benchmarks. Output format as in `security.md`.

## Queries
- N+1: associations traversed in loops, serializers or views without eager
  loading; resolvers querying per field.
- New `WHERE`, `ORDER BY` or join columns without an index; composite filters
  without a composite index; new foreign keys without an index.
- Unbounded queries: list endpoints or exports without `LIMIT`/pagination;
  `->get()` or `findAll()` on tables that grow.
- Counting or summing in application code what the database can aggregate.

## Algorithms
- Nested loops over collections, `find` inside `map`, repeated linear search
  where a map or set lookup works; sorting or filtering the same list twice.

## Caching
- Caches without a bound or expiry; keys that miss user or tenant; caches in
  front of guarded calls (see pass 1).

## Blocking
- Synchronous I/O or CPU-heavy work on the request path or event loop; external
  calls without timeouts.

## Frontend
- Heavy new dependencies (full lodash, moment), barrel imports, unoptimised
  images, no route-level code splitting.
- Fetch waterfalls; unstable props causing re-renders; layout thrashing;
  below-the-fold images without lazy loading.
