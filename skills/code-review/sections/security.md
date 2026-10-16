# Security specialist

Goes deeper than pass 1 (which already covers SQL injection, races, LLM trust and
enum completeness). Output one finding per line:
`[CRITICAL|INFORMATIONAL] (confidence N/10) file:line - problem. Fix: ...`
or `NO FINDINGS`.

## Input at trust boundaries
- Handler input used without validation or a schema; query parameters reaching
  queries or file paths.
- Uploads without type, size and content checks.
- Webhooks processed without signature verification and replay protection.

## Authentication and authorization
- Routes or actions missing auth middleware; checks that default to allow.
- Users able to change their own role, tenant or ownership fields.
- Direct object references: changing an id reaches another user's record. Check
  list, detail and file-download paths separately; each resolves the object
  differently.
- Ownership granted at creation that survives a role downgrade.
- Error pages (403/404/500) that render internal names or navigation the role
  must not see.
- Tokens or API keys validated without expiry; sessions not regenerated on login
  or identity switch; OAuth callbacks that act before validating `state`.

## Injection beyond SQL
- Command injection, template injection, SSRF through user-controlled URLs or
  webhook targets, path traversal (`../`), header injection.

## Cryptography
- MD5/SHA1 for security; `Math.random()`/`rand()` for tokens; `==` on secrets
  instead of constant-time comparison; hard-coded keys or IVs; unsalted hashes.

## Secrets
- Keys, tokens or passwords in code, comments, fixtures or logs; credentials in
  URLs; sensitive data in error responses. AStack rule: credentials are
  `credential://<provider>/<name>` references, never values.

## XSS and deserialization
- Escape hatches on user data (`{!! !!}`, `dangerouslySetInnerHTML`, `v-html`,
  `innerHTML`).
- `unserialize()`, `YAML.load`, or object deserialization of untrusted input.
