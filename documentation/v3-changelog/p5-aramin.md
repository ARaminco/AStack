### Aramin — the AStack console (P5)

- New `console/`: **Aramin** (آرامین), a local, installable PWA console in the
  style of a native admin app — bottom tab bar on phones, side rail on desktop, Ctrl/⌘-K
  command palette, bottom sheets, toasts, skeletons, dark/light/system theme,
  RTL Persian by default with an English switch. Zero dependencies, no build.
- `astack console start [--port] [--host] [--open]`, `astack console token [--rotate]`,
  `astack console status`; `console/service.mjs` implements the daemon service
  contract.
- Screens: home, approvals (exact action, target, values, risk, requester;
  approve/deny with a confirmation sheet, typed code for irreversible actions,
  receipt), missions (pause/resume/cancel, steps, timeline), memory (recall,
  entities, stats; `runtime.search` when present), runs (dry run first; refused
  runs with their reason), jobs/hooks/incidents (run-now for safe kinds), audit
  log (filters, paging), skills (incl. packs), board, gateway, system (daemon
  state, services), settings.
- Optional engines (runner, gateway, search, skill hub, board, sandbox, daemon)
  are feature-detected; missing ones show a "not installed" card.
- Security: loopback by default, Host-header check, owner token in
  `.astack/console/token`, HttpOnly SameSite=Strict session cookie, hashed
  session store, CSRF on every write, login rate limit, strict CSP, no external
  origins. Decisions go through `runtime.approvals` / `runtime.missions` /
  `runtime.runner` as `owner@console` and are audited.
- Live updates over Server-Sent Events (event bus + cross-process state poller)
  with Web Notifications.
- Vazirmatn variable font vendored with its OFL licence.
- Shared-file edits (append only): `bin/astack.mjs` (import, `console` command,
  one doctor line), `locales/fa.json` + `locales/en.json` (`cli.help.console`,
  `cli.console.*`, `console.*`), `upgrade-engine/manifest.json` (`console`
  managed), `.gitignore` (`.astack/console/`), `astack.config.yaml` (commented
  `console:` defaults), `package.json` (`tests/verify-console.mjs` appended to
  `npm test`, `test:console`, `console` scripts).
- Docs: `documentation/Aramin-Console.md`.
