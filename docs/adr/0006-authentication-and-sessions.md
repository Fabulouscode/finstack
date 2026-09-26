# ADR 0006: Authentication and sessions

- **Status:** Accepted
- **Date:** 2026-09-24

## Context

FinStack needs user authentication that is safe by default for a financial product. Stolen credentials or tokens must have limited value, and revocation must be possible. The implementation should stay small enough that a reader can audit it in one sitting.

## Decision

**Passwords** are hashed with **argon2id** (`@node-rs/argon2`: prebuilt binaries, no install scripts) using m=19 MiB, t=2, p=1, the OWASP minimum. Passwords must be 12–128 characters, with no composition rules (NIST SP 800-63B). The upper bound prevents hashing-cost abuse.

**Login does not reveal which emails exist.** Unknown email and wrong password return the same `401 INVALID_CREDENTIALS`, and an unknown email still pays for one argon2 verification so timing is equal. Suspension is disclosed only after a correct password.

**Access tokens** are short-lived JWTs (HS256, 15 minutes by default):

- Claims are `sub`, `role`, `iss`, `aud`, `iat` and `exp`. No email or other personal data.
- The algorithm, issuer and audience are pinned on verification (this rejects `alg: none` and cross-service tokens).
- They are stateless: they stay valid until expiry after logout or suspension. The short lifetime bounds that window.

**Refresh tokens** are opaque 256-bit random strings:

- Only their SHA-256 hash is stored. A fast hash is enough for 256-bit random values and keeps lookup O(1).
- Each use **rotates** the token. Tokens from one login share a `family_id`.
- **Reuse detection:** presenting an already-rotated token revokes the whole family, following the OAuth 2.0 Security BCP. A thief and the victim can't both keep a session.
- Rotation locks the token row (`SELECT ... FOR UPDATE`), so concurrent refreshes are serialised and a session can never fork. An integration test proves this, and it fails if the lock is removed.
- Consequence: clients must not refresh concurrently with the same token (e.g. multiple tabs). A concurrent attempt is indistinguishable from theft and ends the session.

**Authorisation is secure by default:**

- `JwtAuthGuard` is global. Every route requires a token unless marked `@Public()`, so forgetting a decorator fails closed.
- `RolesGuard` enforces `@Roles()` for platform roles (`user`, `admin`). Organisation-level roles and permissions come with the organizations module.

**Credential endpoints** (register, login, refresh) get an additional stricter rate limit (`AUTH_RATE_LIMIT_MAX` per window, per endpoint and IP).

**Deliberately not used:** Passport. A guard of about 40 lines plus `@nestjs/jwt` is easier to audit than a strategy framework for a single scheme.

## Consequences

- Stolen access tokens expire quickly. Stolen refresh tokens are detected on the victim's next refresh.
- ~~Instant revocation of access tokens would need a denylist or per-request user lookup.~~ **Updated by ADR 0023:** the guard now loads the account on every request (one primary-key lookup). Suspensions and role changes apply at once, and the role comes from the account, not the token.
- Only a token that was already *rotated* coming back counts as reuse (it has `replacedById`). Tokens ended by logout or by an admin are just invalid, so they don't raise false security alarms.
- Registration returns `409` for a taken email, which reveals that the email exists. This is common and accepted here; high-risk products can switch to email-verification-based sign-up.
- Expired and revoked refresh-token rows are removed by the maintenance cleanup after 30 days.
