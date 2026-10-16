# Issue taxonomy and health score

## Severity
| Severity | Definition | Examples |
| --- | --- | --- |
| critical | blocks a core flow, loses data, exposes data, crashes the app | submit shows an error page; booking lost; another user's record visible |
| high | major feature broken, no workaround | search wrong; upload silently fails; login redirect loop |
| medium | works with noticeable problems, workaround exists | page > 5 s; validation missing but submit works; mobile layout broken |
| low | cosmetic or polish | typo; 1px misalignment; inconsistent hover |

## Categories (one primary per issue)
Links (broken destinations) → Accessibility → Functional → Performance → Visual →
Content → UX → Console. Deduplicate one root cause across pages.

- **Visual:** overlap, clipped text, horizontal scroll, broken images, z-index,
  dark mode, RTL mirroring, mixed Persian/Latin digits, wrong font.
- **Functional:** dead buttons, wrong redirects, validation missing or bypassed,
  state lost on refresh or back, double submit, wrong search results.
- **UX:** dead ends, no loading indicator, > 500 ms without feedback, vague
  errors, no confirmation before destructive actions.
- **Content:** typos, outdated text, lorem ipsum, truncation, wrong labels,
  unhelpful empty states, untranslated strings.
- **Performance:** load > 3 s, layout shift, > 50 requests, huge images,
  blocking scripts.
- **Console:** uncaught exceptions, failed requests, CORS, mixed content, CSP.
- **Accessibility:** missing alt text, unlabeled inputs, keyboard traps, no
  focus outline, poor contrast, missing `lang`/`dir`.

## Health score (web)
Score each tested category 0-100, exclude untested ones (say "not scored").
- Console: 0 errors 100; 1-3 70; 4-10 40; 11+ 10.
- Links: 100 minus 15 per unique broken destination (floor 0).
- Others: start at 100; critical -25, high -15, medium -8, low -3 (floor 0).
- Weights: Console 15, Links 10, Functional 20, Visual 10, UX 15,
  Performance 10, Content 5, Accessibility 15. Compare scores only at equal coverage.

Functional surfaces get contract outcomes (pass/fail/blocked counts), never a score.
