# Mode C: design score

Only when the plan has a user interface. Start with one overall rating:
"This plan is 4/10 on design completeness because it says what the backend does
but never what the user sees."

## Method
For each dimension: rate 0-10; if below 10, say exactly what would make it a 10;
resolve each gap with the owner (one question per gap); re-rate after the fix
("now 8/10, still missing the mobile nav").

## Seven dimensions
1. **Information architecture:** what the user sees first, second, third on
   each screen; navigation and naming in the owner's language.
2. **Interaction states:** loading, empty, error, partial, success, disabled
   for every component. An empty state has a reason, context and a primary action.
3. **User journey:** the path from entry to done, including the first visit and
   the return visit; where the user might hesitate or drop.
4. **Generic-look risk:** stock hero, three feature cards, generic icons. Name
   the concrete choice that makes it this product's own.
5. **Design system fit:** existing components, tokens, spacing and typography
   reused; for an admin panel, the owner's Aramin console pattern (bottom tabs,
   quick search, dark mode, notifications).
6. **Responsive and accessible:** each viewport designed on purpose; keyboard
   navigation, focus, contrast, touch targets; `dir="rtl"`, Persian fonts and
   digits for Persian UIs.
7. **Open design decisions:** everything left to the implementer's imagination,
   listed so it gets decided now.

## Principles
Specific over vague ("clean and modern" is not a decision); edge cases are user
experiences (47-character names, zero results); subtraction by default: an
element that does not earn its pixels goes.
