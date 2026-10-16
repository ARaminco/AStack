# Web probes with the dedicated browser

The `astack-browser` MCP server is Playwright attached to the project's own
Chrome window (persistent profile, signed in once). Check it first:
`astack browser dedicated status` (start it with `start [url]` if needed).
Look-only tools run without a prompt; clicking and typing ask. The proxy also
enforces: only http/https pages, no typing into password or code fields (the
owner types those), and a click that submits, pays, sends, deletes or
publishes — and every upload or accepted dialog — stops with an approval id:
tell the owner exactly what will be submitted, wait for
`astack approval approve <id>`, then repeat the same call. A project that runs
its own Playwright server (for example `browser` on a shared port) uses that
one instead.

| Need | Tool |
| --- | --- |
| open a page | `browser_navigate` |
| read structure and element refs | `browser_snapshot` (prefer it over screenshots for reasoning) |
| evidence image | `browser_take_screenshot` with a bare `filename` (it lands in `.astack/browser/dedicated/output/`; copy it to `.astack/qa/<run>/shots/`) |
| interact | `browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_press_key`, `browser_hover` |
| wait | `browser_wait_for` (text or time) |
| errors | `browser_console_messages`, `browser_network_requests` |
| mobile | `browser_resize` (375x812, then back) |
| tabs, dialogs | `browser_tabs`, `browser_handle_dialog` |

`browser_evaluate` / `browser_run_code_unsafe` are disabled unless the project set
`browser.dedicated.allow_code: true`; do not ask to enable them for QA.

## Orient (baseline)
1. Navigate to the target; snapshot; screenshot `initial.png`.
2. Read console errors and failed requests (4xx/5xx) after load.
3. Identify the framework (`_next/` = Next.js, `livewire` / `wire:` = Livewire,
   `/admin` with Filament markup, `csrf-token` = Laravel).
4. Establish that the core flow works before probing edges.

## Per page
1. **Visual:** layout, overflow, broken images, right-to-left layout and Persian
   digits/fonts where the site is Persian or Arabic.
2. **Controls:** every button and link does what it says; same-origin links
   checked by navigating (on a live site skip logout, delete, cancel,
   unsubscribe links).
3. **Forms:** empty submit, invalid data, long text, special characters,
   Persian text, double click. On a non-local target, filling is fine;
   the final submit needs owner approval (see SKILL.md trust rules).
4. **States:** empty, loading, error, overflow; back button and refresh keep
   state; deep links work.
5. **Console and network** after each interaction: new errors are findings.
6. **Mobile:** resize and repeat the visual check for core pages.
7. **Auth boundaries:** never sign out yourself; ask the owner when the
   signed-out or another role's view matters.

## Document an issue
Interactive bug: screenshot before, the action, screenshot after; repro steps
with exact element labels. Static bug: one screenshot and a description.
Replay once from the same starting state to confirm before recording.

## Modes
Quick: home plus top 5 navigation targets, load, console, broken links.
Standard: every page in scope. Regression: run standard, then compare with the
previous run's `baseline.json` (fixed, still failing, new).
