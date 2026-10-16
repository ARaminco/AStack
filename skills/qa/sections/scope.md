# Surface, isolation and trust

## 1. Select the target
Read the request, the project's CLAUDE.md/AGENTS.md, README, routes, commands
and tests. Choose **web**, **functional** (API, CLI, job, queue, webhook) or a
scoped mix. Include changed and adjacent behaviour and uncommitted files.
Clarify an ambiguous target or contract before any side effect.

## 2. Establish isolation
- Default to owned, isolated fixtures: a local or staging app, a test database,
  test accounts, synthetic data.
- Resolve where things really go before probing: `localhost` may proxy to
  production, a `.env` may point at the live database, a queue may deliver real
  mail, SMS or WhatsApp messages, a webhook may hit a client's system. Unknown
  ownership blocks the probe.
- Production access, destruction or any external mutation needs specific
  permission from the owner naming the target, the operation and the effect.
  Being asked to "QA the site" is not that permission.
- On shared servers (many live client sites on one host) never restart shared
  services, never change shared config, never load-test.

## 3. Announce the boundaries
Before the first probe, state in one short Persian message: target and
environment, surfaces, tools (browser MCP, curl, CLI), permitted writes, tier and
time box, and where evidence goes (`.astack/qa/<run>/`).

## 4. Credentials and data
- Sign-in: open the login page in the dedicated browser and let the owner type
  the password and any OTP. The profile keeps the session for later runs.
- Reference secrets only by environment variable name or `credential://` id;
  never paste values into notes, commands or screenshots.
- Mask personal data (names, phone numbers, IDs, amounts of real clients) in
  evidence; prefer test records.

## 5. Clean up
Save evidence first, then remove only what this run created (test records,
temp files, processes it started). Disclose anything left behind.
