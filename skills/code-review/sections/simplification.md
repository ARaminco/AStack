# Simplification (advisory)

Hunts unrequested structure only. Findings are always INFORMATIONAL, ASK and
never auto-applied. Each finding uses exactly one tag and says what to cut and
what replaces it, with net lines removable:

- `delete:` dead code, unused flexibility, speculative feature. Replacement: nothing.
- `stdlib:` hand-rolled code the standard library or framework ships (name it).
- `native:` a dependency doing what the platform does (`<input type="date">`
  over a picker, CSS over JS, a DB constraint over app code, `Intl` over moment).
- `speculative:` an interface or factory with one implementation, config nobody
  sets, a layer with one caller.
- `shrink:` same logic in at least 5 fewer lines; show the shorter form.

Example:
`[INFORMATIONAL] (confidence 8/10) app/Support/Dates.php:4 - native: Carbon wrapper class used for one format call. Fix: call format() inline. Removes 22 lines.`

Never targets: tests, error paths, edge-case branches, input validation,
security measures, accessibility. Coverage is the testing specialist's job.
