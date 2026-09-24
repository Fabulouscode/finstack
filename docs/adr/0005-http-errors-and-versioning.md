# ADR 0005: HTTP error format, validation and versioning

- **Status:** Accepted
- **Date:** 2026-09-24

## Context

Clients of a financial API must handle failures precisely. "Insufficient funds" and "wallet frozen" need different handling in the UI, and support staff must be able to trace a failed call to server logs. Error shapes that vary between endpoints, or that leak internal messages (SQL errors, hostnames), are both a usability and a security problem.

## Decision

**Errors follow RFC 9457 (Problem Details)**, served as `application/problem+json`:

```json
{
  "type": "about:blank",
  "title": "Unprocessable Entity",
  "status": 422,
  "detail": "Available balance is too low",
  "instance": "/v1/transfers",
  "code": "INSUFFICIENT_FUNDS",
  "requestId": "b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
}
```

- `code` is a stable, machine-readable identifier. Clients branch on it, never on `detail`.
- Validation failures add `errors: [{ field, messages }]` with dotted paths for nested fields.
- Domain errors extend `AppException(code, detail, status)`.
- Anything not deliberately client-facing becomes a generic `500 INTERNAL_ERROR`, and the full error is logged server-side with the request ID.
- Health probes keep Terminus' native body so standard tooling can read which dependency is down.

**Validation is strict.** Unknown properties are rejected (`forbidNonWhitelisted`), not silently dropped. **Implicit type conversion is off**, so `"100"` is never coerced to `100` for a money field. Submitted values are never echoed in error payloads.

**Every request has an ID.** A well-formed inbound `X-Request-Id` is reused; otherwise a UUID is generated. The ID is returned in the response header and error bodies, and is available anywhere through `RequestContext` (AsyncLocalStorage).

**Feature routes are URI-versioned** (`/v1/...`). Health probes are version-neutral (`/health/*`) because orchestrators need stable URLs.

## Consequences

- One error shape across the API simplifies client SDKs and makes Swagger docs uniform.
- Stable error codes decouple client behaviour from human-readable wording, which can then change freely.
- Strict validation can reject requests that lenient APIs would accept. That is intended for money-moving endpoints.
- Malformed JSON is reported as `400 BAD_REQUEST`, because Nest converts body-parser syntax errors before they reach the filter.
- Rate limiting currently uses in-memory storage, which is per instance. It moves to Redis when the queue infrastructure lands, so limits hold across replicas.
