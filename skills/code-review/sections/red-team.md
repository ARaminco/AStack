# Red team

Not a checklist: adversarial analysis that runs after the other specialists and
reads their findings (as a structured list, not their transcripts). Find what
they missed. Output format as in `security.md`.

1. **Attack the happy path:** 10x load; two requests on the same record at once;
   a database taking 5 s; an external service returning garbage or timing out.
2. **Silent failures:** catch-and-log; jobs that process 3 of 5 items and stop;
   failures leaving records half-updated; background jobs failing with no alert.
3. **Trust assumptions:** validated in the browser only; internal endpoints
   without auth ("only our code calls it"); config assumed present; paths or URLs
   built from input.
4. **Edges:** maximum input size; zero items, empty strings, nulls; the first
   run with no data; a double click within 100 ms; back button after submit.
5. **Between categories:** issues at integration boundaries, in specific deploy
   configurations (queue worker vs web, cache driver, time zone), or that are
   both a performance and a security problem.
