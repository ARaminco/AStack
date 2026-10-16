# Changelog

All notable changes to AStack Enterprise. Versions follow the core manifest
(`core/manifest.json`), which is what `astack upgrade` compares.

## 3.5.0 — Practices from gstack

Five deep practice skills replace the thin generic development packs. Procedures, checklists and decision rules are condensed from [gstack](https://github.com/garrytan/gstack) (MIT, © 2026 Garry Tan, commit 47d639a) and fitted to AStack's trust rules, tools and language policy; see `NOTICE` and `documentation/Practice-Skills.md`.

- Lazy sections: each skill is a short `SKILL.md` skeleton (about 3 KB) plus `sections/manifest.json` and section files that the skeleton opens only when that step is reached, so a small task loads a fraction of the procedure.
- New `code-review`: two-pass pre-merge review; specialists (security, performance, data migration, API contract, testing, red team, simplification) load only when the diff triggers them; gate integrity flags weakened, skipped or deleted tests, raised timeouts and lowered thresholds and always asks the owner; fix-first auto-fixes the mechanical and asks once for the rest; a suppressions list; findings by severity with file:line and confidence; Laravel 12 / Livewire 3 / Filament and Next.js 16 items. `security-review`, `laravel-review`, `node-review` and `filament-review` now point to it as the entry point.
- New `investigate`: no fix without a confirmed root cause, reproduce first, edits kept inside the module under investigation, stop and report after 3 failed hypotheses or fixes; recipes for flaky tests, races and test polluters. `bug-hunter` points to it.
- New `qa`: exploratory QA that picks the surface first (web, API, CLI, job, webhook), drives the project's dedicated browser through the `browser` MCP tools, writes an evidence note per probe, works inside a time box, writes a regression test that fails before every fix, and reports with an issue taxonomy and health score. It never submits, pays, sends or deletes on a live site without owner approval, uses test accounts, and leaves passwords to the owner.
- New `plan-review`: scope challenge (expand, selective, hold, reduce), engineering lock-in (architecture, data flow, edge cases, error map, test matrix, rollout) and a seven-dimension design score, decided with six decision principles and one final owner gate. `feature-planner` points to it.
- New `ship` (text only, no engine code): tests on merged code, `code-review`, docs drift, version and CHANGELOG, bisectable commits, a stop for owner approval before push and deploy (L4), and a deploy section that follows the production-safety rule: only the app's own resources, backup, `nginx -t` before reload, probes before and after, automatic rollback, never `pm2 restart all` or `pm2 kill`.
- New `qa` and `ship` follow the 3.4.0 browser rules: commit clicks wait for an owner approval, the owner types passwords. `deployment-review` points to `ship`.
- **Guard** (`bin/astack-guard.mjs`, adapted from gstack's careful/freeze hooks; see `documentation/Guard.md`): a PreToolUse hook that `astack interop sync` installs for Claude Code (Bash, PowerShell, Edit, Write, MultiEdit, NotebookEdit). Commands are parsed, not pattern-matched — quotes, chains, heredocs, `sudo`/`env` prefixes and wrappers (`bash -c`, `ssh host "…"`, `eval`, `docker exec`, `kubectl exec`, `powershell -Command`, `cmd /c`, `xargs`) are unwrapped and every inner command is judged by its program and arguments, so `ssh srv "rm -rf /"` is refused while `echo 'never pm2 restart all'` passes. An agent granting an approval is refused (the owner approves from the console, the gateway or their own terminal); turning the guard off and editing `.claude/settings*.json` or `.astack/guard/` ask. A review found quoting and wrapper bypasses, catastrophic variants that only asked, secrets in the log and false positives; the 111-case table in `tests/guard-cases.mjs` covers every one. It refuses catastrophic commands — recursive deletes of a root, home or system folder, force-push to main/master/production, `pm2 restart|reload|stop|delete all` and `pm2 kill` (owner production rule), disk formatting — and asks before destructive ones: recursive deletes outside build folders (`node_modules`, `dist`, `.next`, `vendor` … pass), `git reset --hard`, `git clean -f`, force-push, `DROP`/`TRUNCATE`/`DELETE` without `WHERE`, `migrate:fresh`/`db:wipe`, Docker prunes, service stops, firewall flushes, `crontab -r`, and an agent granting an approval (`astack approval approve|decide`). `astack guard freeze <dir>` bounds edits to one folder and fails closed. Shell patterns are matched outside quotes; decisions are logged (secrets redacted) in `.astack/guard/events.jsonl`. `astack guard status|on|off|freeze|unfreeze|check|log`; `guard.enabled: false` removes the hook. Codex has no PreToolUse hook yet; there the contract's trust rules apply as before.
- **Context bill** (`astack context bill [--budget N]`, idea from gstack's context-bill): the always-on cost of a session before the first question — contract and instructions, session-start brief, MCP tool definitions (the browser server measures its own list), skill listings — itemised against `context.always_on_budget` (default 15000); exit code 1 when over.
- Migration `2026.11-ignore-guard-state` keeps `.astack/guard/` out of git.
- New suite `tests/verify-practices.mjs` (guard verdicts, freeze, hook protocol, wiring, bill).
- New root `NOTICE` with the gstack MIT notice and the list of adapted files.

## 3.4.0 — Every project has its own browser

The owner's "dedicated browser" pattern becomes part of AStack: one real Chrome window per project, with its own persistent profile and a stable port, driven by Playwright MCP from Claude Code and Codex and by AStack's own flows. See `documentation/Dedicated-Browser.md`.

- New `browser-engine/dedicated.mjs`: the project's browser — profile under `.astack/browser/dedicated/profile`, a debugging port derived from the project path (9410–9599) listening on 127.0.0.1 only, detached so it outlives the session, reused when running. It is ours only when the port answers, the profile is locked and the browser process AStack started is alive; anything else on the port is skipped.
- New `bin/astack-browser-mcp.mjs`: the `astack-browser` MCP server. It runs the pinned `@playwright/mcp@0.0.83` attached over CDP to the project's window (working folder = the browser's output folder), answers `initialize` and `tools/list` at once and opens the window on the first tool call.
- New `browser-engine/browser-policy.mjs`, enforced by the proxy on every call in every permission mode (bypass included): only http/https/about addresses (no `javascript:`, `data:`, `file:`); a `filename` is a bare name inside the output folder; no code run in the page (`browser_evaluate`, `browser_run_code_unsafe` hidden and refused unless `browser.dedicated.allow_code`); no typing into password, PIN or one-time-code fields (the owner types those); and a commit click, Enter, form fill or selection (submit, pay, send, delete, publish, ثبت, پرداخت, ارسال, حذف …), every upload and every accepted dialog stops with an owner approval (`browser.commit`), one receipt per exact call. Tool results start with a note that page content is untrusted data; batches are refused; responses are matched only when they are responses.
- Calls are logged in `.astack/browser/dedicated/calls.jsonl`: tool, origin and path, element, refusals and approval ids — never typed text or query strings.
- Wiring: `astack setup` / `astack update` add `astack-browser` to `.mcp.json` and the managed block of `.codex/config.toml`, enable it in Claude Code and allow only the tools that look (snapshot, screenshot, console, network, wait, navigate, resize). A project that already runs its own Playwright MCP server, under any name and in either runtime, keeps it and gets no second browser; AStack's enable and allow entries are removed whenever it does not manage the browser. `browser.dedicated.enabled: false` removes AStack's server.
- Migration `2026.10-browser-dedicated-config` adds the `browser.dedicated` block to existing `astack.config.yaml` files, so the setting is visible and can be turned off.
- Setup fetches the pinned Playwright MCP package ahead of the first session (optional stage `browser`; `--no-browser` skips it).
- `astack browser dedicated status|start [url]|stop`; `astack browser run … --profile dedicated` runs a flow in a new tab of the same signed-in window (`openTab` in `cdp-client.mjs`).
- Contract (Browser Protocol) describes the project's own browser and its approval flow; configuration `browser.dedicated` (enabled, profile, port, headless, window, caps, args, binary, allow_code); `ASTACK_BROWSER_HEADLESS=1` hides the window.
- The active-memory guard: a "without approval" phrase overrides a gate such as "after review".
- New suite `tests/verify-dedicated-browser.mjs`; `ASTACK_E2E_BROWSER=1` also drives a real Chrome through Playwright MCP, including the refused `javascript:` address, the refused file write and the one-time approval of a payment click.

### Review fixes before release
An independent review of the first cut found two blockers — a `javascript:` address ran code in the signed-in page, and the look-only screenshot/snapshot tools could overwrite project files such as CLAUDE.md — plus Codex and Claude Code ending up on different browsers, invalid Codex TOML with some owner shapes, auto-allows carrying over to an owner's server, no technical stop on commit clicks in bypass mode, and query strings in the log. All are fixed as described above, each with a test.

A re-check then showed that Claude Code's MCP `roots` made Playwright use the project as its working folder again. The proxy now removes `roots` from `initialize` (and drops roots notifications) and rewrites every `filename` to an absolute path in the output folder. The commit gate reads the page's own text for the targeted element from the latest snapshot, so a misleading description of a "Pay now" button does not pass; coordinate clicks always need approval, and the default capabilities are `pdf` only (no coordinate tools). The e2e test now declares roots, writes a screenshot named CLAUDE.md, and clicks a disguised pay button on a real page.

A focused bypass test then showed that Playwright MCP 0.0.83 names the element `target`, so the page-text check never ran, and that selectors, keys, drops, password fields and approval replay got past the gate. The gate was rebuilt: acting tools accept only refs seen in a snapshot of the current page (no selectors); the page is probed over CDP in an isolated world (password and one-time-code fields, POST-form submit buttons, the focused element); only navigation keys and single characters pass without approval; typed text with a line break, drops with files or data, and POST-form submits are commits; approvals are bound to the page and the element's real text, used up only when the action ran, and cannot be granted from an agent's shell (no terminal). A test asserts the tool schema's parameter names, and the e2e test replays every attack on a local page and checks that the page received only the one approved commit. Remaining limits are documented in `documentation/Dedicated-Browser.md`.

## 3.3.0 — Living memory and right-sized teams

Inspired by Letta (agent-managed memory) and CrewAI / Agency Swarm (delegation and team design). Additive: no stored record changes shape, no migration rewrites data, and every 3.2.0 memory file is read as it is.

### Active memory (Letta-style blocks)
- New `memory-engine/blocks.mjs`: small, named, size-limited blocks that are always in context — `owner/…`, `project:<id>/…`, `case:<id>/…`, `agent:<id>/persona|goals`. Stored append-only in `.astack/memory/blocks/blocks.jsonl`; every edit is a new version (`history`, `restore`), retiring a block is a tombstone.
- Agents edit their own memory: `astack memory block set|append|replace|remove|history|restore` and the MCP tool `astack_memory_block` (list, show, history, set, append, replace; no remove over MCP). An append that would overflow moves the oldest lines into long-term memory, bound to the block's project or case, so nothing is lost.
- Guards: secret shapes (assigned passwords and keys, cards, IBANs, long account numbers, provider tokens, JWTs) and instruction-like text are refused; read-only blocks change only from the CLI with `--force`; a torn line is skipped.
- `astack memory active` / MCP `astack_memory_active` render the blocks of one engagement inside a token budget and name what was left out. The context router adds an "active memory" section (budget `activeMemory`, default 1200) and the session-start brief shows the owner's blocks.

### Task-scoped recall
- `recall({ scope })`: under a case scope a record bound to a different case is left out, under a project scope a record bound to a different project; everything else — including every unbound record that 3.2.0 or the markdown import wrote — stays recallable, and records bound to the scope rank higher. Records of another case or project never enter the context.
- `astack memory search --case <id> | --scope project:<id>,case:<id>`, `astack memory remember --case <id> --entities a,b`, and the same `case` / `scope` / `entities` inputs on the MCP tools.
- The context router scopes recall automatically when a request resolves to a project or a Case node in the knowledge graph.

### Automatic management
- `astack memory reflect [--scope …] [--dry-run]` / MCP `astack_memory_reflect`: the deterministic memory-manager pass (Letta's sleep-time agent). It ranks the records that matter most for the owner, each project and each case (importance, proven use, decisions and preferences) into a managed `<scope>/key-facts` block; superseded, forgotten or expired records leave on the next pass and their replacements take their place. It never changes the long-term store and never overwrites a block edited by hand. The nightly `memory-consolidate` job runs it after consolidation.

### Persona and goal continuity
- Every agent gets `agent:<id>/persona` (role, team, standing rules) and `agent:<id>/goals` (current mission) when it is created; a new brief updates the goals and keeps the persona and whatever the agent added to it.

### Right-sized teams (CrewAI / Agency Swarm)
- The team planner is capability first: it reads the capabilities a request needs (architecture, implementation, testing, security, data, operations, content) and its scale (small, medium, large), then folds them into the fewest seats. Small work is one specialist; large work gets separate heads only where separation matters (design, build, test, security); the architect leads instead of an extra manager.
- Specialists come from the 219-role catalog (`roles/enterprise-roles.json`, now used by the planner), including Persian spellings (لاراول → the Laravel engineer); everyday words such as "go live" never pick a specialist.
- Each seat carries what it covers and its expected output; reviewers that are needed only sometimes are on-demand seats with a trigger (`TeamPlanner.escalate` brings one in); `form()` creates agents only for always-active seats. Plans state the process (solo, sequential, hierarchical), the delegation and handoff flows (always through the lead and the Chief of Staff) and the team cost next to the solo cost. `astack ask "<request>" --team` prints all of it.
- The intent engine reads "fix", "add", «رفع کن», «اضافه کن» and «طراحی کن» as building work, and in software work treats "online payment", "login page" or "the site" as features of the product, not as a payment to make or a portal to visit.

### Review fixes before release
An independent review found one blocker and five should-fix items; each has a regression test in `tests/verify-memory-crew.mjs`.
- **Old memory under a scope (blocker).** Scoped recall dropped unbound records (what `import-legacy` writes from `memory/cases/*.md`) and project-tagged case facts. A scope now excludes only conflicting bindings, as described above.
- **Real payments keep L4.** Only feature noun phrases ("online payment", "payment gateway", "login page", «درگاه پرداخت», «صفحه ورود») are set aside in software work; "pay the invoice" is still a payment.
- **MCP options are single tokens.** Every optional value travels as `--flag=value` and free text after `--`, so a value can never become an option; facet, project, domain, case, agent, numbers and dates are validated; `supersede` ids are checked.
- **Agents never write `owner/` or `system/` blocks** over MCP, and `--force` on a read-only block is refused in unattended runs and over MCP. The instruction guard collapses whitespace and refuses role prefixes and "always … / … without approval" next to an irreversible action (English and Persian), while statements such as "never pay without approval" or "after owner approval" stay.
- **Reflection** leaves a key-facts block the owner retired alone; **agent seeding** never overwrites goals someone else wrote; no caller can pose as the reflect pass or the agent engine.
- Also: outside software "fix / add / اصلاح کن" is a draft, not a build; limits below 100 become 100; empty values are refused; line endings are normalised; lines evicted from agent blocks go to the semantic facet; restoring a removed read-only block needs `--force`; the case id is no longer listed twice in a scope; a backup survives an unreadable block file.
- The interop and online-skill tests expect the single-token option form.

### Tests
- New suite `tests/verify-memory-crew.mjs` (also `npm run test:memory`), including a check that a 3.2.0 memory store is read and left byte-for-byte unchanged by the new layer.

## 3.2.0 — Online skill search

- `astack skill online search "<query>"`: when no local skill fits, search the public skill registries — skills.sh, SkillsMP, ClawHub and GitHub (the official `anthropics/skills` index, plus `gh search code` for `SKILL.md` when `gh` is installed and allowlisted) — in parallel. Results are normalised, de-duplicated across registries (same GitHub repository and folder), ranked by text relevance plus log-popularity and cached for `cache_minutes`; a failing registry is reported on its own line, never fatal.
- `astack skill online show <source>:<id>` previews a result: fetched into a temporary folder, scanned, printed and deleted.
- `astack skill online get <source>:<id> [--pack online] [--dry-run]` imports a result through the existing importer and scanner into `skill-packs/online/`. Blocked skills are refused before anything is written (exit code 2); high-risk ones are imported flagged and never selected automatically. The origin (registry, URL pinned to the commit, commit or ClawHub version, licence, `sha256` of `SKILL.md`, fetch date) is kept in `ORIGINS.json`, on each catalog entry and in `PACK.md`.
- GitHub folders are fetched with a shallow, sparse, blob-less clone (`fetchGitFolder` in `skill-hub/sources.mjs`); ClawHub archives with a defensive ZIP reader (no new dependency). Every URL passes `automationPolicy.allowHost` and git/gh pass `allowInvocation`; a refusal prints the exact `astack schedule policy …` command. Searches, imports and refusals are audited.
- New MCP tools `astack_skill_online_search`, `astack_skill_online_show` and `astack_skill_online_get` (show and get accept only ids from a prior search).
- The contract's "Auxiliary Skill Packs" section gains the search order: own and built-in skills → installed packs → only then online; preview with `show`, import with `get`, read the scan, and tell the owner in one line which external skill was fetched and from where.
- Optional `skills.online` configuration section (enabled, sources, limit, cache_minutes, pack, timeout_ms, skillsmp_key, redirect_hosts, endpoints). New suite `tests/verify-skill-online.mjs`.

### Security hardening before release

Fixes from the security review of online skill search; each has a regression test in `tests/verify-skill-online.mjs` that reproduces the attack.

- **No planted git metadata.** The ZIP reader refuses any segment that is `.git` or `git~1` after lower-casing and dropping trailing dots and spaces (`.GIT/config` with `core.fsmonitor` was accepted before), plus `.gitmodules`, `.gitattributes` and `.lfsconfig`. The scanner's file list and the importer drop every `.git*` name in any case and `.lfsconfig`, for git and ZIP sources.
- **git filters and hooks never run.** Every skill-hub git process (online fetch, `skill pack import`, update check) runs without inherited `GIT_*` variables, with `GIT_CONFIG_NOSYSTEM`, an empty `GIT_CONFIG_GLOBAL`, `GIT_LFS_SKIP_SMUDGE`, no prompts, an empty hooks folder, `core.fsmonitor=false`, an emptied LFS filter driver and no global attributes file. A globally installed git-lfs can no longer contact the endpoint a repository's `.lfsconfig` names (an SSRF around `allowHost`); the test proves it against a real local repository and listener.
- **MCP option injection.** The MCP layer validates the online tools' inputs (`pack: "--fromSearch=false"`, `id: "--x"` and queries starting with `-` are refused) and passes free values after `--`; `parseArgs` honours `--` as the end of options (no change without it).
- **Credentials stay with the registry.** Redirects never downgrade from https, never leave the requested host unless it is listed in the new `skills.online.redirect_hosts` (and then without `Authorization`, cookies or API keys, so the SkillsMP key is never forwarded), and must not resolve to a private, loopback or link-local address.
- **Agent imports wait for the owner.** An online import has status `review` and is never auto-selected until the owner runs the new `astack skill online approve <pack>/<id>` (CLI only; refused over MCP and in unattended runs). Agents may still fetch on demand and use a skill for the current task by naming it. An approval is bound to a hash of the skill's files. `get`, `show` and `search` are audited with their requester.
- **Fetched text is data.** `show` of a blocked skill returns findings only; otherwise the text loses C0/C1 control characters and is wrapped in untrusted-content markers with a random per-call tag (CLI and MCP). Names, descriptions and versions lose control characters in `catalog.json`, `ORIGINS.json` and `PACK.md`, and PACK.md escapes Markdown link syntax.
- **No owner data in queries.** Queries are scrubbed with the strict redactor before they are sent, cached or audited; the contract asks for generic task words only (never names, client, case or company data).
- **Also:** ZIP entries with `:`, reserved characters, trailing dots or spaces, Windows device names, and duplicate or case-colliding names are skipped; `gh search code` gets its terms after `--` (and the docs note that `allow-command gh` opens every gh subcommand); a ClawHub GitHub handoff is fetched at the vetted commit by SHA, and the moderation lookup fails closed (`suspicious` refused too); `ls-tree -z` with every entry re-checked, and glob characters refused in sparse paths; at most 400 files and 20 MB per skill; work folders under `os.tmpdir()`, removed in `finally`; a per-pack lock so concurrent gets never lose a skill.

## 3.1.5

The console service test now enables the console explicitly, so the update pipeline's `--test` run passes in installs whose owner turned the console off (`console.enabled: false`).

## 3.1.4 — Skill packs at hand for every runtime

- The shared contract gains "Auxiliary Skill Packs": pack skills (for example the Hermes pack) are a searchable list that Claude Code, Codex and unattended runs consult only when a task needs a specialised procedure their own skills do not cover.
- New MCP tools `astack_skill_pack_search` and `astack_skill_pack_show` on the `astack` server, so both runtimes search and load pack skills the same way.

## 3.1.3 — Your own panel name, and an internet listener without an authenticator

- `console.brand` (`name`, `name_fa`, `icons`): an install shows its own name and icons for the panel in the shell, the app manifest and every UI string. Aramin stays the base name. The build hash includes the brand so installed apps refresh.
- `console.remote.totp: false`: an owner decision to drop the authenticator code on the internet listener. Cloudflare Access stays required; sign-in is by password and step-up (irreversible approvals, runs) asks for the password again. Default stays `true`.
- Session `stepUp` is now `"totp"`, `"password"` or `false` (was a boolean); the app switches the step-up field accordingly.

## 3.1.2

Under the daemon, the console and skill-hub services received only their (usually empty) `daemon.<service>` block and ignored the owner's `console:` and `skills.packs` sections, so the internet listener (`console.remote`) never started. The owner's section is now the base and daemon keys override it.

## 3.1.1 — Internet exposure hardening

Security review fixes for Aramin before its internet listener goes live
behind a Cloudflare Tunnel and Access. Nothing changes for a console that
stays on loopback, except where noted.

### Internet listener (7718)

- Refuses to start without `console.remote.access.team` and `aud` (the
  reason is in the log and in `astack console status`). New
  `console.remote.access.emails`: an allowlist checked against the Access
  JWT's `email` claim, without case; the Access identity is written into
  login audit records.
- Real runs (`POST /api/runs` with `dryRun: false`) and `jobs/:id/run` need
  the new `console.remote.runner: true` (default off: 403) and a fresh TOTP
  step-up code; dry-run previews still work.
- With conversations closed there, their `claude.tool` approvals are hidden
  from the approvals list, detail, counts, home, search, notifications and the
  SSE stream; approving one is 403, denying one is allowed.
- Generic error text for every 4xx/5xx (no internal messages); malformed `%`
  escapes in paths and cookies are a 400 (on both listeners).
- A successful step-up is audited (`console-step-up`).

### Local listener (7717)

- Refuses any request with `CF-Connecting-IP`, `CF-Ray`,
  `Cf-Access-Jwt-Assertion`, `Forwarded`, `X-Real-IP` or `X-Forwarded-*`
  headers (403, generic message), and the public host name even when
  `console.host` is not loopback.

### Sign-in

- Password sessions carry the user's credential version; `astack console user
  set|remove|totp` change it and also end that user's sessions, so a stale
  session is refused. Token sessions are unaffected; `console token --rotate`
  still ends every session (a running console now notices the change).
- `astack console token` and `user set|remove|totp` refuse to run when
  `ASTACK_UNATTENDED` is set.
- Lockout counters persist in `.astack/console/lockouts.json` (hashed keys,
  expiry).
- scrypt N=2^17 for new and changed password hashes; older hashes still verify
  and are rehashed at the next successful sign-in.
- TOTP secrets are kept with Windows DPAPI (`vault:windows`) on Windows;
  existing plaintext secrets move there at the next sign-in or `user totp`.
  Other platforms keep them in `users.json`. The secret is printed only at
  enrolment.

### Conversations

- The Claude Code child now runs with `ASTACK_UNATTENDED=1`; the console server
  still decides every permission request.
- Every turn denies `Read`/`Edit` on `**/.astack/console/**`,
  `**/.astack/vault/**` and `**/.astack/gateway/**` (anchored at the
  filesystem root and relative to the project), `Edit(//**/.astack/**)`, and
  `Bash`/`PowerShell` commands touching those folders or running
  `astack console`. Rule syntax checked against Claude Code 2.1.x (only
  `Read(path)`/`Edit(path)` rules are consulted for files).

### Redaction

- `redactSecretsStrict` also masks bare base32 secrets (16+ characters of
  A-Z2-7, in one run or groups of four) when a label such as secret, totp,
  otp, 2fa, mfa, authenticator, seed or key comes just before them.

### Docs

- The cloudflared snippet now uses `originRequest.access` (`required`,
  `teamName`, `audTag`), no `httpHostHeader`, ingress to
  `http://127.0.0.1:7718` and a 404 catch-all; an exposure checklist was added.

## 3.1.0 — Conversations and password login

Aramin gains a first tab for Claude Code sessions and a sign-in that can face
the internet.

### Conversations (گفت‌وگوها)

- Lists the Claude Code sessions of `console.chats.projects` (default: this
  workspace) from `~/.claude/projects/<slug>/*.jsonl`, grouped by project,
  newest first, with title, last activity, message count, branch and
  sub-agents; search and paging.
- Opens a session as a chat: safe markdown (escaped first, code blocks with a
  copy button, tables, per-block text direction), tool calls as one-line chips
  with a redacted preview, thinking and injected tags hidden, the last turns
  first with "earlier messages". Everything sent to the browser is
  strict-redacted.
- Continues a session (`claude -p --resume`) or starts one
  (`--session-id <uuid>`) in its project folder, with the prompt on stdin,
  `--output-format stream-json --verbose --include-partial-messages`, live
  streaming over the console's SSE channel, cost and duration per turn,
  today's total, a lock per session, a Stop button that ends the process tree
  and an optional `console.chats.daily_budget_usd`.
- Tool permissions go through `--permission-prompt-tool
  mcp__astack__permission_prompt`: a new tool on the astack MCP server that
  creates a `claude.tool` approval, notifies the console and the gateway,
  waits (10 minutes, then deny) and answers Claude Code's allow/deny contract.
  The owner decides on an inline card in the chat, through the same approvals
  engine. `Read,Grep,Glob` are pre-allowed by default; `bypassPermissions` is
  refused; the runner's mandatory `.astack/**` and `astack approval` denies
  always apply.

### Sign-in

- `astack console user set|list|remove|totp`: usernames with scrypt-hashed
  passwords (N = 2^15, a salt per user) and optional RFC 6238 TOTP (key and
  `otpauth://` URI printed, no QR library).
- `console.auth: token | password | both` (default `both` once a user
  exists); the sign-in screen adapts. Lockout per address and per username
  (5 failures → 15 minutes), uniform errors, every attempt audited without the
  secret, optional idle timeout (`console.session_idle`), "Sign out
  everywhere" in Settings. Token sign-in and one-time tickets keep working;
  a ticket is accepted only from this computer.

### Internet exposure

- `console.remote`: a second listener (loopback, default port 7718) for a
  tunnel. It answers only its public host name (port 7717 keeps refusing it),
  trusts `CF-Connecting-IP`, accepts username + password + mandatory TOTP only
  (no token, no ticket), refuses to start until a user has TOTP, caps sessions
  at 12 hours with `Secure; HttpOnly; SameSite=Strict` `__Host-` cookies,
  checks `Origin: https://<hostname>` and CSRF, asks for a fresh TOTP code
  before irreversible approvals, can verify Cloudflare Access assertions
  (RS256 JWT against the team's certs, `aud`/`iss`/`exp`), and keeps
  conversations closed (`remote.chat: false`).
- SSE keep-alives every 20 seconds; `astack console status` and the daemon
  service report both listeners.

### Compatibility

Additive: token sign-in, `console open`, every existing endpoint and test
behave as before. New state lives in `.astack/console/` (`users.json`,
`chats/ledger.jsonl`). New suite: `tests/verify-console-chats.mjs`.

## 3.0.0 — Always on, in your pocket, and Aramin

AStack 3.0 adds an unattended runner and one background daemon, a two-way owner
gateway (WhatsApp through wapi, a linked-device bridge or the Cloud API, and
Telegram) with approvals by message and local Persian voice notes, full-text and
semantic recall over memory, past sessions and reports, a skill hub with a
security scanner (shipping the Hermes Agent skills as a separate auxiliary pack),
the **Aramin** console, a durable multi-agent board, a Docker sandbox, OS vault
backends and an A2A endpoint.

### Highlights

- **Works while you are away.** `astack run` executes an objective or a mission
  unattended through Claude Code headless, `codex exec` or a local Ollama
  model, within a daily and a per-run budget; anything irreversible still stops
  for your approval.
- **One background process.** `astack daemon start` keeps the runner queue,
  scheduled jobs, webhooks, the gateway, search reindexing, the board and the
  console running; `astack daemon install-service` starts it at logon on
  Windows, macOS and Linux.
- **AStack in your pocket.** Command it from Telegram or WhatsApp, receive its
  reports, and approve with «بفرست» / "approve" (or decline with «نه» /
  "deny"); several owner accounts per channel; Persian voice notes transcribed
  locally.
- **Aramin, the console.** A local, installable app for approvals, missions,
  memory, runs, jobs, audit, skills and the board, Persian by default;
  `astack console open` opens it already signed in.
- **Smarter recall.** `astack search` finds things across memory, past Claude
  Code and Codex sessions, reports, skills and missions, Persian-aware, with
  optional semantic ranking through Ollama, and builds an owner profile.
- **Skill hub.** Import `SKILL.md` skills into scanned auxiliary packs that rank
  below AStack's own; ships the Hermes Agent pack (211 MIT skills), with
  high-risk skills never auto-selected and two blocked outright.
- **Board, sandbox, vault, A2A.** A multi-agent board with retries and a
  reviewer lane, Docker-isolated commands, OS vault backends for credentials,
  and an Agent-to-Agent endpoint that only plans unless you allow more.
- **Hardened for unattended work.** Authority ceilings enforced in the tools,
  approval forgery blocked, strict approval-by-message rules, redaction of
  every new output (Persian credential words included).
- **Purely additive.** Every 2.5.1 command, file and test works unchanged;
  `astack update` brings 3.0 and every new engine stays off until you turn it on.

It is strictly additive: every 2.5.1 command, file format and test keeps working
unchanged (the original suites run unmodified, apart from a CRLF-tolerant regex
in the interop alias test and excluding third-party `skill-packs/` from the
leftover-marker check). Every new engine is off or read-only until configured.
Build contract: `documentation/V3-Plan.md`.

### P1 — Runner and daemon (always-on AStack)

- **Runner** (`runner-engine/`, `runtime.runner`): unattended execution of the
  hosted work order through Claude Code headless, `codex exec`, a local Ollama
  model or a mock engine; `auto` routes cheap background work to the local
  model and real tasks to Claude Code. Missions run through the mission engine
  and stop at the same approval points; free-form runs turn
  `APPROVAL-REQUEST:` lines into owner approvals and resume after the
  decision. Daily budget, per-run budget and concurrency guards; every run is
  recorded in `.astack/runner/runs.jsonl` and the audit log.
- **CLI**: `astack run "<objective>" [--engine] [--model] [--budget] [--dry-run] [--mission] [--queue]`,
  `astack runner list|show|resume|status|drain|engines|enable-signal-runs`.
- **Queue bridges**: scheduler job kind `agent` (`--objective`, `--engine`,
  `--ceiling`, `--mode`), signal reaction `run-agent` (off until
  `astack runner enable-signal-runs`).
- **Daemon** (`daemon-engine/`): `astack daemon start [--foreground]|stop|status|logs`
  supervises `runner-engine`, `scheduler-engine` and `signal-engine` services
  (and later packages' `service.mjs`) with crash restart and backoff.
- **OS service**: `astack daemon install-service|uninstall-service|service-status [--dry-run]`
  for Windows Task Scheduler, macOS launchd and Linux systemd --user.
- `buildWorkOrder()` extracted from the hosted runtime adapter so the hosted
  and unattended paths share one work order (output unchanged).
- Doctor prints runner and daemon lines. New docs: `documentation/Runner-and-Daemon.md`.

#### Gateway (P2) — the assistant in your pocket

- New `gateway-engine/` exposed as `runtime.gateway` (`notify()`, `status()`, `bind(runtime)`): the owner commands AStack from WhatsApp and Telegram, receives reports, and approves irreversible steps by message.
- Channels: `whatsapp-wapi` (self-hosted wapi REST, polling), `whatsapp-bridge` (own Baileys linked-device bridge installed on demand into `.astack/gateway/bridge/` by `astack gateway whatsapp setup`, paired with `astack gateway whatsapp pair`), `whatsapp-cloud` (Meta Cloud API with signed webhook and verify-token handshake), `telegram` (Bot API long polling) and a `cli` loopback.
- Owner allowlist per channel with several accounts per owner; strangers and non-allowlisted groups are ignored and audited; outbound only to owners and allowlisted groups.
- Inbound text becomes `runtime.runner.execute({ objective, source: "gateway:<channel>" })`, or a plan-only brief without a runner; runner `refused` and `dry-run` results are explained.
- Approvals by message: prompts with exact values and a short code to every owner account; «بفرست» / «ارسال کن» / «تایید» / "approve" and «نه» / «رد» / "deny" by quote or code; ambiguous replies ask; a second account on a decided request gets «قبلاً تصمیم گرفته شد»; decisions go through `runtime.approvals` as `owner@<channel>` and resume the run or mission.
- Commands `/status`, `/pending`, `/runs`, `/stop`, `/help`; Persian replies, Latin digits, no bidi isolates, no tables, split long output, per-channel rate limit with outbox.
- Local Persian voice notes with faster-whisper (`gateway-engine/scripts/transcribe.py`, `large-v3-turbo`, CUDA → CPU), gated by the automation policy; `astack gateway voice setup|test`.
- CLI `astack gateway status|test|send|poll|serve|owners|owner|voice|whatsapp`; daemon service `gateway-engine/service.mjs`; doctor line `Gateway:`.
- Bridge safety ported from Hermes Agent (MIT): owner-message gate, LID ↔ phone aliases, outbound id tracking, reconnect backoff, ownership by identity.
- Tests: `tests/verify-gateway.mjs` (loopback pipeline plus fake wapi, Telegram, Graph API and bridge servers).

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

### Skill hub (P4)

- New `skill-hub/` engine (`runtime.skillHub`): imports agentskills.io / Anthropic
  `SKILL.md` skills from a local folder, a git URL or a GitHub `owner/repo/path`
  into auxiliary packs under the new managed directory `skill-packs/`.
- Static security scanner (`skill-hub/scanner.mjs`): prompt injection, hidden
  text, pipe-to-shell, credential access, exfiltration, destructive commands,
  obfuscation and binaries, with `file:line` findings and a `low | medium | high |
  blocked` risk per skill. Scripts are never executed; a skill with scripts
  requires review.
- Skill catalog integration (append-only): pack skills carry
  `source: "pack:<pack>"`, rank below built-in and learned skills
  (`skills.packs.weight`, default 0.6), blocked skills are never selectable, and
  `skills.packs.enabled: false` restores the previous output byte for byte.
- `astack ask` lists catalog skills with auxiliary pack skills below built-ins
  while packs are enabled.
- New commands: `astack skill pack list|search|show|import|scan|remove|updates`,
  `astack skill catalog --packs`, `astack skill curate [--apply]`.
- Skill curator: usage, last use, success rate, cross-source duplicates and
  keep / refine / retire recommendations; changes only with `--apply`, never
  touches built-in skills, never deletes files.
- `skill-hub/service.mjs` for the daemon: optional update check of git-sourced
  packs (check only).
- New auxiliary pack `skill-packs/hermes/`: 211 skills from NousResearch/hermes-agent
  (MIT), with `PACK.md`, `SCAN.md`, `LICENSE` and `compat: hermes-runtime` labels.
- Doctor prints a `Skill packs:` line. New test suite `tests/verify-skillhub.mjs`.

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

### P6 — Board, sandbox, vault, A2A

**Added**
- `board-engine/`: durable multi-agent kanban (`runtime.board`, `astack board create|list|show|add|run [--once]|steer|retry|cancel`). Cards with agent/team assignees, dependencies, retries with exponential backoff, structured per-attempt handoffs and transcripts, parallel fan-out (`board.max_parallel`), an independent reviewer lane (`--review`), live steering, approval waits, crash recovery and a per-board lock. Executes through `runtime.runner.execute`; without a runner cards are `blocked: runner not installed`. Emits `board.card.*` events and notifies `runtime.gateway` when a card fails. Daemon service in `board-engine/service.mjs`.
- `sandbox-engine/`: Docker-isolated execution (`runtime.sandbox.exec`, `astack sandbox status|images|require|exec -- <command>`): no network, read-only root, all capabilities dropped, no-new-privileges, pids/memory/CPU limits, read-only mounts with secret stores hidden. The automation policy remains the gate; every run is audited.
- Automation policy: optional `sandbox.required_for` patterns route matching shell-tool commands and `command` jobs into the sandbox (fail closed). Unset, nothing changes.
- Vault backends for the secret broker: `vault:windows` (DPAPI), `vault:macos` (`security`), `vault:linux` (`secret-tool`), `vault:bitwarden` (`bw`, read only), `vault:1password` (`op`, read only). `astack secret vault status|set|test|remove`; values via stdin or a hidden prompt only.
- Exfiltration guard `trust-engine/redaction.mjs` (`redactResolvedSecrets`, `redactResolvedDeep`): resolved secret values are scrubbed from audit records, board transcripts, sandbox output and A2A responses.
- A2A endpoint `interop-engine/a2a-server.mjs` (`runtime.a2a`, `astack a2a serve|card|status`): agent card, `message/send`, `tasks/get`, `tasks/cancel` over JSON-RPC with bearer auth (`credential://a2a/token`), loopback by default, inbound tasks treated as untrusted under a capped authority ceiling; plan-only through the chief of staff when no runner is installed.
- `tests/verify-board.mjs` appended to `npm test`; `documentation/Board-Sandbox-Vault.md`.

#### Security hardening (3.0 security review)

Mandatory before the owner gateway is enabled. Nothing here changes a 2.5.1
command, file format or test; the six 2.5.1 suites run unmodified.

- **Ceiling enforced in the tools.** Runner runs at L0–L2, and every run that
  is not the owner's own request, get Claude `Read`/`Grep`/`Glob` with
  `dontAsk` and codex `read-only`, whatever the configuration says. Wider
  configured tools apply only at L3+ for `cli`, `console` and `gateway:*`;
  `a2a` and `signal:*` are always read-only (`toolScopeFor`).
- **Approval forgery blocked.** Mandatory Claude denies (`Write`/`Edit` on
  `.astack/**`, any `astack approval`, any Bash touching `.astack`) that a
  custom deny list cannot drop; `ASTACK_UNATTENDED=1` in every runner child,
  under which the approval engine, `astack approval approve|reject|deny` and
  `astack browser resume` refuse to decide. The approval file format is
  unchanged.
- **Gateway approvals.** Groups need a quote or the code; in a private chat a
  bare word counts only for a prompt delivered to that chat, before the reply,
  within `gateway.approval_window_minutes` (default 30); forwarded messages are
  never decisions (Telegram, Baileys, wapi, Cloud API); every prompt names the
  run's source.
- **A2A.** Injection-shaped requests are rejected; plan only unless
  `a2a.execute: true`; artifacts redacted; no automatic pack skills and no
  past sessions for A2A and signal runs.
- **No domain escalation for outsiders.** A2A and signal runs are capped at
  the owner's default level; the signal engine passes only
  `hook.defaults.domain` to the runner.
- **Redaction of new outputs.** Runner records, prompts and outputs, gateway
  messages and A2A artifacts pass `redactSecretsStrict` (new export in
  `lib/text.mjs`; `redactSecrets` is unchanged) and the resolved-secret guard.
  Token shapes now live in `lib/redact.mjs`, shared with search. The header of
  `trust-engine/redaction.mjs` states its real coverage and limits.
- **Sandbox.** Every `.astack/`, `.ssh/`, `.claude/`, `.env*` and `.git/config`
  is hidden at any depth; env values travel in a temporary env file; image and
  user come only from configuration; the routed sandbox mounts only workspace
  folders. The filesystem tool also refuses `.astack/gateway|search|a2a|console`.
- **Search redaction.** Persian and short credential keywords (رمز، پسورد،
  گذرواژه، کلمه عبور، کد تایید، کد ورود، توکن, pass, pwd, pin, otp, 2fa, cvv),
  card numbers and IBANs.
- **Inbound fence.** A random fence per run; fence markers in the input are
  removed; injection patterns extended (Persian too), append only.
- **Smaller items.** Codex bypass arguments refused and Claude permission modes
  allowlisted; DPAPI through the absolute PowerShell path; Baileys installed
  with `--ignore-scripts` and `/send-media` limited to the bridge outbox/media
  folders; gateway and signal listeners need `allow_remote` for a non-loopback
  host, keep a bounded rate-limit map and answer 500 without detail;
  `.gitignore` ignores `.astack/` as a whole; Hermes `godmode` and
  `obliteratus` blocked through the new `skill-packs/<pack>/OVERRIDES.json`,
  kept across re-imports; pack skills labelled third-party in work orders.

Follow-up, not done here: signing approval records with a DPAPI-protected key.
It would have to verify unsigned 2.5.1 records too, so it only adds value once
every writer signs; the ASTACK_UNATTENDED gate and the mandatory `.astack/**`
denies close the forgery path for runner children in the meantime. A process
that runs as the owner outside the runner can still append to
`.astack/approvals/requests.jsonl` directly.

#### 3.0.0 fixes after review

- **Gateway and console commands.** `astack gateway …` no longer falls through
  into the console command (a missing `return` from merging the two
  packages).
- **Context index.** The context engine ignores the third-party `skill-packs/`
  folder, so pack text never enters the workspace map or context search.
- **Skill search stays built-in.** `astack skill search` returns built-in and
  learned skills only, exactly as in 2.5.1, unless `--packs` is given; the
  catalog resolves a `<pack>/<id>` only while packs are enabled.
- **Agent job payload.** `--objective`, `--mission`, `--engine`, `--ceiling` and
  `--mode` are stored only for scheduler jobs of kind `agent`; other job kinds
  keep their 2.5.1 payload.
- **Migration `2026.8-ignore-v3-state`.** An existing `.gitignore` that does not
  ignore `.astack/` as a whole learns the 3.0 state folders (gateway, runner,
  daemon, search, board, sandbox, vault, a2a, skill-hub, console), so the
  search index of past sessions or a WhatsApp session can never be committed.
- **Gateway test in installed projects.** The gateway suite reads the
  documented `gateway:` block only in the core repository; an installed
  project's own `astack.config.yaml` no longer fails `astack update --test`.
- **Vault and Windows PowerShell.** `astack secret vault set` strips the UTF-8
  byte-order mark that Windows PowerShell puts in front of piped input; a
  Telegram token stored that way had been one character long (Telegram
  answered 404). Store such a token again after updating.
- **High-risk pack skills are never auto-selected.** Skills with scan status
  `review` (such as curl-pipe installers) stay listed but are found only by an
  explicit raw search or `show`; `skills.packs.auto_select_review: true`
  restores the old ranking.

#### `astack console open`

- New `astack console open`: while the console runs (inside the daemon or
  `astack console start`), it opens the browser already signed in. It issues a
  one-time ticket shared across processes through
  `.astack/console/tickets.json`, which stores only the ticket's SHA-256 hash
  and expiry; the ticket travels in the URL fragment and is good for one login
  within a minute. Without a running console it says so and exits with an
  error. `astack console start --open` keeps its in-process ticket.
- Docs: "How to sign in" now opens `documentation/Aramin-Console.md`.

## 2.5.1

The merge stage skips seed files and preserved data listed in `upgrade.keep`
(`astack.config.yaml`, `CLAUDE.md`, `README.md`, `memory`, `knowledge-packs`,
…): the configuration gains new sections on apply and the rest belongs to the
owner, so a text merge of them could only do harm.

## 2.5.0 — Customised installs update safely, memory comes back whole

Written while updating a law firm's heavily customised 2.0 fork.

### Added

**Three-way merge of protected paths** — a new `merge` stage in the update
pipeline. Paths in `upgrade.keep` used to be frozen, so a release that changed
the engine around them broke the install. They are now merged against the
release the project last received (`.astack/upstream-base/`, refreshed after
each verified update): owner-only changes stay, upstream-only changes arrive,
both go through `git merge-file` (JSON leaf by leaf), and a real conflict keeps
the owner's version and is reported. New upstream code and `manifest.required`
files arrive inside protected paths; new curated content does not. Rollback
undoes the merge.

**Markdown memory import** — `memory/` scopes and any folder in
`memory.import_paths` are imported into the shared store one section per record,
at every session start (both runtimes), in setup and with
`astack memory import-legacy`. Changed sections supersede, removed ones retire,
credential-like files are never read, AStack's own template files are skipped.

**`interop.project_root`** — for a core embedded in a subfolder: the contract,
`CLAUDE.md` import, MCP server, hooks and Claude Code memory import target the
folder the runtimes are actually opened in.

**`cli.aliases`** — owner command names in `astack.config.yaml` (for example
`matter: project`), which survive updates where an edit to `bin/astack.mjs`
did not.

## 2.4.1

A rollback now restores the project completely. The pipeline snapshots the
files the setup stage writes outside the core (`AGENTS.md`, `CLAUDE.md`,
`.mcp.json`, `.claude/settings.json`, `.codex/*`, `.gitignore`, `graphify-out`)
before setup and puts them back — or removes them — when verification fails.
Found updating a heavily customised 2.0 fork whose protected engines are
incompatible with 2.4: the core was restored, but its `CLAUDE.md` kept an
import of an `AGENTS.md` that the rollback had removed.

## 2.4.0 — The update pipeline

"Update AStack" is now one defined pipeline that always takes the new core from
the AStack git repository.

### Added

**`astack update`** (alias `upgrade`; `setup --update` runs it too):
preflight → fetch → plan → apply → setup → verify → record. Fetch resolves the
newest release tag from the repository (`--version` pins one, `--channel main`
follows the branch) into the canonical clone at `~/.astack/core`. Plan shows
versions, file counts, the CHANGELOG titles in between and uncommitted managed
files; `--check` stops there. Apply backs everything up; setup runs with the
new code; verify runs doctor and Claude Code/Codex parity (`--test` adds the
suites) and **rolls back automatically** on failure. Each run is recorded in
`.astack/update-history.jsonl` and in the shared journal, which both runtimes
see at their next session start. `update history` and `update rollback`
complete it; a lock prevents concurrent updates.

**Safety** — the AStack source repository itself refuses the pipeline (it would
overwrite work in progress with a release) and updates with `git pull`.

**Triggers** — the shared contract and the global `astack-setup` skill map
"update AStack", «آپدیت کن» and similar requests to the pipeline, run from the
canonical core so it works for projects on any older version.
`installer/update.sh` and `update.ps1` do the same from a shell.

### Changed

The canonical clone is refreshed with fetch + detached checkout, which works
on a branch or a release; the installers and the skill use the same commands.

## 2.3.1

The global `astack-setup` skill now states that a bare "نصب شو", "راه‌اندازی شو",
"install" or "set up" means AStack setup and must run without a clarifying
question. Verified with real runs: Codex and Claude Code each installed AStack
into a plain project from that single phrase.

## 2.3.0 — One command to install and set up

"Install and set up" is now one idempotent command for any project — empty,
existing, or running an old core — and a request in plain words to either
runtime is enough.

### Added

**`astack setup`** (also `install`/`init`, and run automatically after
`astack upgrade`): installs or upgrades the core, runs data migrations in a
new process with the new code (no separate `init` after an upgrade any more),
wires Claude Code and Codex, trusts the project in Codex, installs Graphify with
its git hooks and builds the code graph, builds the context index and installs
the global skill. A failing optional step is reported without stopping the
rest. `--target <dir>` sets up another project from this core; `--update`
refreshes the canonical core at `~/.astack/core` first.

**Embedding into existing projects** — a fresh install into a non-empty
directory keeps the project's own `README.md`, `package.json`, `Dockerfile`
and CI workflows, records `.astack/install.json` so later upgrades keep doing
so, and fills stock knowledge packs and plugins only where nothing exists.

**Global `astack-setup` skill** for Claude Code (`~/.claude/skills`) and Codex
(`~/.agents/skills`): saying "install", "set up", "نصب شو" or "راه‌اندازی شو"
in any project runs the setup, with or without AStack already there.

### Changed

**The contract is a managed block.** It ships as `system/agent-contract.md` and
lives in `AGENTS.md` between markers, refreshed on every setup and upgrade, so
contract changes reach installs while project rules outside the block are kept.
An unmarked `AGENTS.md` exactly as 2.2.0 shipped it is replaced, not
duplicated. The installers (`installer/install.sh`, `install.ps1`) bootstrap
any project through the canonical core.

## 2.2.0 — Claude Code and Codex in parity, Graphify under budget

Claude Code and Codex become two hands of the same operator: one operating
contract, one memory, one journal, one tool surface. Work started in one runtime
continues in the other without re-explaining anything. Additive; 2.1 installs
are wired by a migration.

### Added

**Shared contract** — `AGENTS.md` is the runtime-neutral operating guide. Codex
loads it natively; `CLAUDE.md` imports it with `@AGENTS.md` and keeps only the
Claude Code specifics, so both runtimes read byte-identical rules.
`astack interop status` proves both resolve to the same contract hash.

**Interop engine** (`interop-engine/`) — `astack interop sync` generates or
merges the wiring for both runtimes (`.mcp.json` and `.claude/settings.json`
for Claude Code, `.codex/config.toml` and `.codex/hooks.json` for Codex). Owner
entries are kept, malformed files are reported and never overwritten, and a
second run changes nothing. `--trust-codex` trusts the project in
`~/.codex/config.toml` with a backup.

**astack MCP server** — `astack mcp serve`, a dependency-free stdio MCP server
both runtimes launch. Sixteen tools (standup, memory search/remember/supersede/
entity, context map/search, ask, skill catalog, handoff, journal, interop
status, and four code graph tools) run the CLI with an argument vector, so results are identical in both
runtimes and records keep the calling runtime as provenance.

**Session hooks and journal** — a session-start hook gives either runtime the
same context: contract hash, the latest handoffs and session ends from both
runtimes, owner capsule, open work and a memory brief. Session ends and
structured handoffs (`astack interop handoff`) go to
`.astack/interop/journal.jsonl`; handoffs are also episodic memory.

**Claude Code memory import** — Claude Code auto-memory is imported into the
shared store at every Claude Code session start; a changed file supersedes its
earlier record, so Codex recalls what Claude Code learned.

**Codex runtime adapter** — `codex` is a hosted runtime writing the same work
order format as `claude-code`; the model router prefers the runtime hosting
the current session on a tie.

**Graphify, driven by AStack** — `astack graphify setup|upgrade|build|status|
query|explain|path|affected|benchmark` installs Graphify (`graphifyy`) as an
isolated tool, installs its git hooks and builds a local, AST-only code graph.
The guidance lives once in `AGENTS.md` instead of Graphify's per-runtime,
machine-specific installers. Every answer is capped by `graphify.query_budget`
(hard cap `graphify.max_budget`), metered in
`.astack/context/graphify-usage.jsonl`, and flagged when the graph is stale;
`status` reports tokens served and savings against Graphify's benchmark
(25.5x fewer tokens per query on this repository).

**Migration `2026.7-runtime-interop`** and the `verify-interop` suite (six
suites in `npm test`).

## 2.1.0 — The autonomy layer

AStack becomes a persistent organization: it remembers its owner across
conversations, forms the smallest expert team a request needs, executes through
real tools, stops before anything irreversible, verifies the result, audits it
and learns from it. Everything in 2.0 keeps working; this release is additive.

### Added

**Memory OS** — twelve temporal facets (identity, semantic, episodic, project,
entity, relationship, procedural, decision, preference, working, calibration,
lesson) stored as append only JSONL with provenance, confidence, importance and
a validity window. Facts are replaced with `supersede`, never overwritten, so
history stays answerable with `--asOf`. Ranked recall combines lexical
relevance, per facet recency decay, confidence and usage. Nightly
consolidation merges duplicates, decays stale weights and compacts.

**Knowledge graph** — a temporal graph of people, companies, projects, cases,
documents, accounts, portals and the rest, with exclusive relationships that
supersede rather than erase. `astack graph neighbours <id> --asOf <date>`
answers who held a role last quarter.

**Context engine** — an incremental workspace index (symbols, imports, document
outlines, data keys, per file terms) plus domain lenses that extract the records
which make the map work outside software: case numbers, parties, hearings,
statutes, invoices, IBANs, account codes, fiscal periods, tax ids. Documents
that share a record are linked exactly the way source files are linked by an
import. Ranking is a personalized PageRank over that graph; rendering fits a
token budget at three levels of detail and always declares what it omitted.
Precision is preserved: the map is an index with line anchors and
`astack context expand <path>` returns a file's full structure.

**Context router** — one minimal package per request: owner capsule, memory
brief, resolved entities, project state, workspace map, matching skills and the
tool catalog, each inside its own budget.

**Learning engine** — work is recorded as episodes, repetition is mined into
patterns with a canonical procedure and guardrails drawn from failures, and a
qualifying pattern is forged into a real skill package with its evidence.
Forged skills start as drafts and are promoted, retired or rolled back on
recorded outcomes.

**Skills** — ten operational packs: speech to text, advanced OCR, image design,
document intelligence, web operator, structured data extraction, legal case
brief, financial close, tax filing, contract review. A single catalog covers
built in and learned skills with progressive disclosure.

**Internal browser** — a real Chromium profile driven over the DevTools
protocol with no automation dependency. Persistent profiles mean the owner
signs in once and later runs are already authenticated. Flows declare the
authority of every step, stop before anything that commits, capture the state
as evidence and return a resumable checkpoint. Evidence is hash chained and
verifiable. Page text is treated as untrusted data.

**Scheduler** — durable background jobs on intervals or cron: web service
checks with status, latency and body assertions, agent dispatch, context
refresh, skill mining, memory consolidation, project digests, hook processing,
browser tasks. Failures retry with backoff, repeated failures open an incident
that can escalate to an agent, and recovery closes it. A supervisor loop keeps
it running.

**Inbound signals** — one webhook URL to register in any external tool,
verified by token or HMAC signature with a timestamp window, replay protection,
size cap and rate limit. Payloads are normalized, classified into a domain,
sanitized as untrusted content and matched against owner defined rules whose
reactions are policy checked.

**Missions** — durable, resumable units of work with approval checkpoints, dry
run and replay. A mission survives a restart and continues from the step it
stopped at.

**Trust layer** — authority levels L0 to L5 with per domain, tool and site
ceilings and denials; approval requests that state exactly what will happen,
producing single use receipts; an append only audit trail with secret
redaction; and a secret broker where callers only ever see
`credential://provider/name`.

**Tool registry** — sixteen tools with manifests declaring capabilities, risk,
permissions, credentials and dry run support, a token bounded catalog, capability
search, and one invocation path where authority, policy and audit always apply.

**Runtime abstraction and model router** — a provider independent runtime
interface with Claude Code, generic CLI and mock adapters, structured handoffs
instead of transcripts, and routing by task class, risk, context size and
recorded performance. No commercial model name is hard coded.

**Chief of Staff** — intent analysis, entity resolution, risk assessment and
just in time team formation that starts at one agent and makes every extra seat
earn itself, with the estimated token cost shown before the team is formed.

**CLI** — `ask`, `standup`, `owner`, `context`, `memory`, `graph`, `learn`,
`skill`, `mission`, `schedule`, `signal`, `browser`, `authority`, `approval`,
`audit`, `secret`, `tool`, `runtime`, all localized.

**Documentation** — thirteen new pages including an honest feature status table
separating what is implemented from what is adapter-ready or future.

**Tests** — two new deterministic suites (intelligence, autonomy) covering
memory, temporal supersede, graph history, indexing, budgets, retrieval
precision, the learning lifecycle, authority, approvals, audit redaction,
credential handling, tool gating, runtimes, missions with approval and restart,
scheduler retries and incidents, webhook verification and hostile payloads,
browser planning and evidence, the owner scenarios and the upgrade migrations.
A separate opt in suite drives a real browser end to end.

### Changed

- `ConfigurationEngine` parses the configuration file instead of string matching
  it; `requireSections` is unchanged.
- `MemoryEngine` keeps its markdown scopes and API, and now mirrors structured
  writes into the owner facing scope when one is given.
- The orchestrator reports what the autonomy layer is holding: matching skills,
  pending approvals, active missions, due jobs, open incidents.
- The domain registry learned more Persian vocabulary for accounting, legal,
  finance, tax, HR and operations.
- `astack doctor` reports memory facets, skills, tools, runtimes, jobs, hooks,
  missions, the browser driver and the authority default.

### Upgrade notes

`astack upgrade` replaces managed engine files after a backup and appends the new
configuration sections without touching owner values. Five idempotent data
migrations create the structured memory store, seed the owner capsule, install
the default authority policy, create `skills/learned` and import existing
decisions into the decision facet.

Coming from 2.0, run `astack init` once after the upgrade to apply them: an
install upgrades itself with its own command, so a 2.0 install runs 2.0 code,
which predates migrations. `astack doctor` reports whatever is still pending.
From 2.1 onward `astack upgrade` runs them itself.

`.astack/`, `memory/`, `plugins/`, `knowledge-packs/`, `skills/learned/` and any
path under `upgrade.keep` are never touched.

After upgrading:

```bash
astack init                # applies any pending data migrations
astack context build
astack schedule defaults
astack owner set --name "<you>"
astack authority show
```

### Not included

Email, messaging, database, SSH and document tools ship as manifests with no
live adapter; they refuse honestly rather than fabricating a result. The
computer operator (desktop control) exists as an interface only. The CLI runtime
adapter needs a configured command before it can run. Browser sessions need Node 22
or newer for the global WebSocket; the rest of AStack runs on Node 20. Storage is JSON and JSONL;
the storage surfaces are narrow so another backend can replace them later.

## 2.0.0

Generalized AStack into a multi-domain operating system: ten engagement
domains, thirty-three departments, a role catalog, team assembly from domain
blueprints, agents with scheduled missions and work orders, a leadership layer,
the delivery engine, and the upgrade engine with managed, seed and preserved
paths.
