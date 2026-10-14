## Security hardening (3.0 security review)

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
