# API contract specialist

Output format as in `security.md`.

## Breaking changes
- Fields removed or retyped in responses; new required parameters on existing
  endpoints; changed methods or status codes; renamed paths without an alias;
  a public endpoint that now requires auth (or the reverse).

## Versioning
- Breaking change without a version bump; mixed versioning styles; deprecations
  without a sunset date or migration note.

## Errors
- New endpoints with a different error shape than existing ones; 200 for
  errors, 500 for validation; stack traces or SQL in error bodies.

## Limits and pagination
- New endpoints missing rate limits their siblings have; pagination style or
  default page size changed without notice; no next-page indicator.

## Consumers
- Mobile or third-party clients that cannot update at once; webhook payloads
  changed without telling subscribers; SDKs that now need a release.

## Documentation
- OpenAPI/Swagger, README examples or Postman collections that no longer match.
