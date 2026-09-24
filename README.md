# FinStack

> **The financial backend foundation for your next fintech product.**

FinStack is an open-source, production-minded **fintech backend starter kit** built with NestJS, TypeScript, PostgreSQL and TypeORM. It provides the hard financial infrastructure — wallets, a double-entry ledger, payments, webhooks, idempotency and reconciliation — so you can focus on your product.

> ⚠️ **Status: early development.** FinStack is a starter kit and learning resource, not a production financial service processing real customer funds.

## Principles

- **No floating-point money.** Amounts are integers in minor units (kobo, cents), always stored with a currency.
- **Double-entry ledger** is the source of truth. Every movement is balanced; entries are immutable.
- **Idempotency** for every retryable financial operation.
- **Transactional integrity** with PostgreSQL transactions and row-level locking.
- **Explicit state machines** for transactions, payments and refunds.

## Tech stack

NestJS · TypeScript · PostgreSQL · TypeORM · Redis · BullMQ · Docker · Swagger/OpenAPI · Jest · ESLint

## Getting started

### Prerequisites

- Node.js 24.9+ (`nvm use` reads `.nvmrc`)
- npm 11+
- Docker with Docker Compose

### Install and run

```bash
npm install
cp .env.example .env
npm run infra:up          # PostgreSQL + Redis in Docker
npm run migration:run
npm run start:dev
```

Then open the API docs at `http://localhost:3000/docs`, or check `http://localhost:3000/health/ready`.

### Everything in Docker

```bash
docker compose up --build
```

This starts PostgreSQL and Redis, runs migrations in a one-shot `migrate` container, then starts the API once migrations succeed.

`DATABASE_PORT`, `REDIS_PORT` and `PORT` in `.env` are also the host ports Compose publishes. Change them if they clash with services already running on your machine.

## Configuration

Configuration is read from environment variables (and `.env` in development), validated at startup and exposed to the code as typed namespaces. If any variable is missing or invalid, the app refuses to boot and lists every problem.

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test` or `production` |
| `PORT` | `3000` | HTTP port (1–65535) |
| `SWAGGER_ENABLED` | `true` outside production | Serve API docs at `/docs` |
| `CORS_ORIGINS` | empty (CORS off) | Comma-separated browser origins, or `*` |
| `TRUST_PROXY_HOPS` | `0` | Reverse proxies in front of the app, so the real client IP is used |
| `RATE_LIMIT_TTL_SECONDS` | `60` | Rate-limit window |
| `RATE_LIMIT_MAX` | `100` | Requests allowed per client per window |
| `AUTH_RATE_LIMIT_MAX` | `10` | Stricter per-endpoint limit for login, register and refresh |
| `JWT_ACCESS_SECRET` | — (required) | HMAC key for access tokens, min 32 chars (`openssl rand -base64 48`). The `.env.example` placeholder is refused in production. |
| `JWT_ACCESS_TTL_SECONDS` | `900` | Access token lifetime (60–86400) |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | Refresh token lifetime (1–365) |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `finstack` / `finstack-api` | Pinned `iss` / `aud` claims |
| `WALLETS_PER_OWNER` | `single` | `single`: one wallet per user; `multiple`: one per allowed currency |
| `DEFAULT_WALLET_CURRENCY` | `USD` | Currency of the first (primary) wallet when none is given |
| `ALLOWED_WALLET_CURRENCIES` | the default only | Comma-separated currencies users may open wallets in |
| `IDEMPOTENCY_KEY_TTL_HOURS` | `24` | How long responses are kept for replay |
| `IDEMPOTENCY_LOCK_TIMEOUT_SECONDS` | `60` | After this, an in-progress key may be taken over by a retry |
| `PAYMENT_PROVIDERS` | `mock` | Enabled providers, comma-separated. `mock` is refused in production. |
| `DEFAULT_PAYMENT_PROVIDER` | first enabled | Provider used when a request doesn't name one |
| `MOCK_PROVIDER_WEBHOOK_SECRET` | — (required with `mock`) | HMAC secret the mock provider signs webhooks with |
| `FX_SPREAD_BPS` | `100` | Platform margin on conversions (100 = 1%) |
| `FX_QUOTE_TTL_SECONDS` | `900` | How long a quote stays valid |
| `FX_RATE_MAX_AGE_SECONDS` | `86400` | Refuse to quote on rates older than this |
| `DATABASE_HOST` | `localhost` | PostgreSQL host |
| `DATABASE_PORT` | `5432` | PostgreSQL port |
| `DATABASE_USER` | — (required) | PostgreSQL user |
| `DATABASE_PASSWORD` | — (required) | PostgreSQL password |
| `DATABASE_NAME` | — (required) | Database name |
| `DATABASE_SSL` | `false` | Use TLS and verify the server certificate |
| `DATABASE_LOGGING` | `false` | Log SQL queries |
| `DATABASE_POOL_MAX` | `10` | Maximum pool connections (1–100) |
| `REDIS_PORT` | `6379` | Redis host port published by Compose |

Each namespace lives in `src/config/<name>.config.ts` and declares its own validated schema. To use one in a provider:

```ts
constructor(
  @Inject(appConfig.KEY)
  private readonly config: ConfigType<typeof appConfig>,
) {}
```

### Scripts

| Script | Description |
| --- | --- |
| `npm run start:dev` | Start in watch mode |
| `npm run infra:up` / `infra:down` | Start / stop PostgreSQL and Redis |
| `npm run migration:run` | Apply pending migrations |
| `npm run migration:revert` | Revert the last migration |
| `npm run migration:show` | List migrations and their status |
| `npm run migration:generate -- src/database/migrations/<Name>` | Generate a migration from entity changes |
| `npm run migration:create -- src/database/migrations/<Name>` | Create an empty migration |
| `npm run build` | Compile to `dist/` |
| `npm run typecheck` | Type-check without emitting |
| `npm run lint` | Lint with ESLint (type-checked rules) |
| `npm run format` | Format with Prettier |
| `npm test` | Unit tests |
| `npm run test:int` | Integration tests (real PostgreSQL) |
| `npm run test:e2e` | End-to-end tests (real PostgreSQL) |
| `npm run test:cov` | Unit tests with coverage |

## Database and migrations

- `synchronize` is always off. Every schema change is a migration in `src/database/migrations/`.
- Tables and columns use snake_case (`ledgerAccountId` → `ledger_account_id`).
- The migration CLI runs against the compiled `dist/` output, so the `migration:*` scripts build first.

## HTTP conventions

- **Versioning:** feature routes live under `/v1/...`. Health probes are unversioned (`/health/*`).
- **Errors:** [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457), `application/problem+json`, with a stable `code` to branch on:

  ```json
  {
    "type": "about:blank",
    "title": "Bad Request",
    "status": 400,
    "detail": "Request validation failed",
    "instance": "/v1/transfers",
    "code": "VALIDATION_ERROR",
    "requestId": "b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    "errors": [{ "field": "amount", "messages": ["amount must be an integer number"] }]
  }
  ```

  Throw `AppException(code, detail, status)` (from `src/common/http/app.exception.ts`) for domain errors. Any other error becomes a generic `500` and is logged with its request ID.
- **Validation:** unknown fields are rejected, and types are never converted implicitly. Use `@Type(() => Number)` where conversion is intended.
- **Request IDs:** send `X-Request-Id` or one is generated. It's echoed in the response and in error bodies. Read it anywhere with `RequestContext.requestId()`.
- **Security:** Helmet headers on every response, CORS off unless configured, and rate limiting per client IP (health probes are exempt).

## Authentication

| Endpoint | Auth | Description |
| --- | --- | --- |
| `POST /v1/auth/register` | Public | Create an account; returns user + tokens |
| `POST /v1/auth/login` | Public | Email + password → tokens |
| `POST /v1/auth/refresh` | Public | Refresh token → new token pair (rotation) |
| `POST /v1/auth/logout` | Public | Revoke the session the refresh token belongs to |
| `POST /v1/auth/logout-all` | Bearer | Revoke every session of the current user |
| `GET /v1/users/me` | Bearer | Current user |

```bash
# Register
curl -X POST localhost:3000/v1/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"ada@example.com","password":"correct-horse-battery-staple","firstName":"Ada","lastName":"Lovelace"}'

# Call an authenticated endpoint
curl localhost:3000/v1/users/me -H "Authorization: Bearer <accessToken>"
```

- **Access tokens** are JWTs valid for 15 minutes. **Refresh tokens** are single-use: each refresh returns a new one, and reusing an old one ends the whole session. Don't refresh concurrently with the same token.
- Every route requires a Bearer token by default. Mark public routes with `@Public()`, restrict by platform role with `@Roles(UserRole.Admin)`, and read the caller with `@CurrentUser()`.
- Details and trade-offs: [ADR 0006](./docs/adr/0006-authentication-and-sessions.md).

## Wallets and ledger

Every amount is an **integer in minor units** (cents, kobo) plus an ISO 4217 currency: `15000` USD is $150.00. Supported currencies are listed in `src/common/money/currency.ts`.

**The operator chooses the wallet model** ([ADR 0010](./docs/adr/0010-flexible-wallet-model.md)):

| Product | Configuration |
| --- | --- |
| One USD balance; foreign payments converted into it | `WALLETS_PER_OWNER=single`, `DEFAULT_WALLET_CURRENCY=USD` (defaults) |
| Local currency only, no FX | `single`, `DEFAULT_WALLET_CURRENCY=NGN`, and no FX rates configured |
| Multi-currency accounts | `WALLETS_PER_OWNER=multiple`, `ALLOWED_WALLET_CURRENCIES=USD,NGN,GBP` |

Each user has at most one wallet per currency, and one **primary** wallet. **Crediting rule:** incoming money goes to the wallet in its currency if there is one; otherwise it is converted ([FX](#fx-currency-conversion)) into the primary wallet.

| Endpoint | Description |
| --- | --- |
| `POST /v1/wallets` | Open a wallet: `{}` for the default currency, or `{ "currency": "NGN" }` |
| `GET /v1/wallets` | My wallets, primary first |
| `GET /v1/wallets/primary` | My primary wallet |
| `GET /v1/wallets/:id` | A wallet with `available`, `pending` and `reserved` balances (own wallets only) |
| `POST /v1/wallets/:id/primary` | Make a wallet primary |
| `GET /v1/wallets/:id/entries?limit=20&cursor=...` | Ledger history, newest first, cursor-paginated |

**How it works:**

- A wallet stores no amounts. Each balance (available, pending, reserved) is an account in a **double-entry ledger**, and every change is a balanced posting (`LedgerService.post`).
- `WalletsService` provides `deposit`, `withdraw`, `transfer`, `reserve` and `release`. Each takes a `reference` and is idempotent: retrying with the same reference never moves money twice. HTTP endpoints for moving money arrive with the idempotency module.
- The database enforces the rules even if application code is bypassed: balanced transactions, no overdrafts, immutable history, and balances that change only through entries. See [ADR 0007](./docs/adr/0007-ledger-and-money.md).
- Concurrent operations on one balance are serialised with row locks taken in a consistent order. Two simultaneous ₦7,000 withdrawals from a ₦10,000 wallet: exactly one succeeds.
- `resolveCreditTarget` applies the crediting rule; `depositWithConversion` credits a wallet from a foreign-currency payment using an FX quote; `convertBetweenWallets` converts between a user's own wallets.
- Query performance: [ledger entry pagination](./docs/performance/ledger-entries-pagination.md) (keyset vs OFFSET, with `EXPLAIN ANALYZE`).

## Transfers and idempotency

| Endpoint | Description |
| --- | --- |
| `POST /v1/transfers` | Send money to another user: `{ "recipientEmail": "bob@example.com", "amount": 2500, "currency": "USD" }`. Requires `Idempotency-Key`. |
| `GET /v1/transactions` | My transactions, both directions, newest first, cursor-paginated |
| `GET /v1/transactions/:id` | One transaction (visible to both parties) |

```bash
curl -X POST localhost:3000/v1/transfers \
  -H "Authorization: Bearer <accessToken>" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' \
  -d '{"recipientEmail":"bob@example.com","amount":2500}'
```

**Idempotency.** Every money-moving endpoint requires an `Idempotency-Key` header. Generate one per operation and reuse it when retrying:

- Same key and body: the original response is returned (`Idempotent-Replayed: true`) and nothing executes twice.
- Same key, different body: `422 IDEMPOTENCY_KEY_REUSED`.
- Still running: `409 IDEMPOTENCY_REQUEST_IN_PROGRESS`, so retry shortly.
- Failed request: the key is released and a retry runs again.

Transactions move through explicit states (`pending → processing → successful → reversed`, or `failed`, `cancelled`, `expired`). Invalid transitions are rejected by the code **and** by a database trigger. See [ADR 0011](./docs/adr/0011-idempotency-and-transaction-states.md).

## Payments and webhooks

| Endpoint | Auth | Description |
| --- | --- | --- |
| `POST /v1/payments` | Bearer + `Idempotency-Key` | Start a payment: `{ "amount": 1550000, "currency": "NGN" }` → hosted checkout URL |
| `GET /v1/payments/:id` | Bearer | Payment status (and the FX conversion, if any) |
| `POST /v1/payments/:id/verify` | Bearer | Ask the provider and settle (e.g. after the customer returns from checkout) |
| `POST /v1/webhooks/:provider` | Signature | Provider callbacks |
| `POST /v1/dev/mock-provider/payments/:providerReference/complete` | Bearer | **Dev only:** finish a mock checkout (sends a signed webhook) |

**Flow:** the crediting rule picks the wallet (locking an FX quote if the currencies differ) → the provider returns a checkout URL → the customer pays → the provider's **signed** webhook arrives → FinStack **re-checks the payment with the provider** and compares the amount → one database transaction credits the wallet (converting if needed), posts the ledger and marks the transaction `successful`.

Duplicate webhooks are ignored, forged ones rejected, and a failure while processing is recorded on the event for retry. The wallet is credited at most once, however many webhooks and verify calls race. See [ADR 0012](./docs/adr/0012-payments-and-webhooks.md).

Try it locally with the mock provider:

```bash
# 1. Start a payment (NGN into a USD wallet converts at the locked quote)
curl -X POST localhost:3000/v1/payments -H "Authorization: Bearer <token>" \
  -H "Idempotency-Key: $(uuidgen)" -H 'Content-Type: application/json' \
  -d '{"amount":1550000,"currency":"NGN"}'

# 2. "Pay" at the mock checkout (sends a signed webhook through the real pipeline)
curl -X POST localhost:3000/v1/dev/mock-provider/payments/<providerReference>/complete \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' -d '{"outcome":"successful"}'
```

## FX (currency conversion)

| Endpoint | Auth | Description |
| --- | --- | --- |
| `GET /v1/fx/rates` | Bearer | Newest rate of each pair |
| `POST /v1/fx/rates` | Admin | Set a rate: `{ "base": "USD", "quote": "NGN", "rate": "1550.25" }` (decimal string) |
| `POST /v1/fx/quotes` | Bearer | Lock a conversion: `{ "sourceCurrency": "NGN", "targetCurrency": "USD", "sourceAmount": 1550000 }` or `targetAmount` |
| `GET /v1/fx/quotes/:id` | Bearer | One of my quotes |

Example at USD/NGN 1550 with a 1% spread: paying ₦15,500.00 credits **$9.90**. The $0.10 is booked as FX revenue, and both currency legs post to the ledger atomically. Credited amounts round down, charged amounts round up, and quotes are refused when the rate is older than `FX_RATE_MAX_AGE_SECONDS`.

> **Before enabling FX in production:** converting customer funds and holding foreign-currency balances can be regulated activity (for example, Central Bank of Nigeria rules on FX and domiciliary balances). Make sure your business is authorised. FX is off in practice until you configure rates: without a rate, conversions are refused.
>
> **Treasury risk:** the `system:fx-position:*` ledger accounts show your open exposure (e.g. NGN held against USD owed to customers). FinStack records it; it does not hedge or sell it for you.

To make a user an admin (until an admin module exists):

```sql
UPDATE users SET role = 'admin' WHERE email = 'you@example.com';
```

Then sign in again so the new access token carries the role.

## API documentation (Swagger)

| URL | Content |
| --- | --- |
| `/docs` | Swagger UI |
| `/docs-json` | OpenAPI 3 document (JSON), importable into Postman or Insomnia |
| `/docs-yaml` | OpenAPI 3 document (YAML) |

Docs are enabled by default everywhere except production. Set `SWAGGER_ENABLED` to override.

Every endpoint must document:

- `@ApiTags` and `@ApiOperation` (summary and description).
- Request and response DTOs with `@ApiProperty({ description, example })` on every field.
- Auth requirements: `@ApiBearerAuth(ACCESS_TOKEN_SCHEME)` or `@ApiSecurity(API_KEY_SCHEME)` from `src/docs/swagger.ts`.
- Every error it can return, with `@ApiProblemResponse(status, 'CODE: description')` and `@ApiValidationProblemResponse()` from `src/docs/api-problem-response.decorator.ts`.

Decorators are written explicitly; the Nest CLI Swagger plugin is not used. The plugin only runs during `nest build`, so tests (via `ts-jest`) would see a different document than production.

## Health checks

| Endpoint | Purpose |
| --- | --- |
| `GET /health/live` | Liveness: the process is running. No dependency checks. |
| `GET /health/ready` | Readiness: dependencies (PostgreSQL) are reachable. Returns `503` otherwise. |

## Testing

| Layer | Location | Runs against |
| --- | --- | --- |
| Unit | `src/**/*.spec.ts` | Nothing external |
| Integration | `test/integration/*.int-spec.ts` | Real PostgreSQL (`finstack_test`) |
| E2E | `test/*.e2e-spec.ts` | The full Nest app plus real PostgreSQL |

Integration and e2e tests need `npm run infra:up`. They always use the `finstack_test` database, which Compose creates on first start, so development data is never touched.

## Roadmap

- [ ] **Phase 1 — Financial foundation**
  - [x] Config, PostgreSQL/TypeORM, Docker, HTTP foundation, Swagger
  - [x] Users and authentication (JWT, rotating refresh tokens, roles)
  - [x] Double-entry ledger and wallets (single or multi-currency, primary wallet)
  - [x] FX: admin-set rates, locked quotes, two-leg conversion with spread
  - [x] Transactions (state machine), idempotency keys, transfers
  - [ ] Organizations, permissions, API keys
- [ ] **Phase 2 — Payments** (done: provider abstraction, mock provider, payments with FX, signed webhooks; next: outbox, BullMQ, Paystack, Stripe, refunds): provider abstraction (Mock, Paystack, Stripe), webhooks, refunds, outbox, background jobs
- [ ] **Phase 3 — Operations:** reconciliation, audit logs, admin, notifications, observability
- [ ] **Phase 4 — Developer platform:** CLI, more providers, dashboard, sandbox

## Architecture decisions

See [`docs/adr/`](./docs/adr/).

## License

[MIT](./LICENSE)
