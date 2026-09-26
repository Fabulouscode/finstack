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
| `PAYMENT_CURRENCY_ROUTES` | — | Pin currencies to providers, e.g. `USD:stripe,NGN:paystack` |
| `EMAIL_DRIVER` / `EMAIL_FROM` / `SMTP_URL` | `log` / `FinStack <no-reply@finstack.local>` / — | Notification emails: `log` prints them; `smtp` sends via `SMTP_URL` |
| `DATA_ENCRYPTION_KEY` | dev key | 32 bytes, base64 (`openssl rand -base64 32`). Encrypts stored secrets such as webhook signing secrets. **Required in production.** |
| `OUTBOUND_WEBHOOK_MAX_ATTEMPTS` / `_BACKOFF_MS` / `_TIMEOUT_MS` | `10` / `30000` / `10000` | Delivery retries (exponential), first delay, request timeout |
| `OUTBOUND_WEBHOOK_DISABLE_AFTER_FAILURES` | `20` | Disable an endpoint after this many failed deliveries in a row |
| `OUTBOUND_WEBHOOK_ALLOW_PRIVATE_URLS` | off in production | Allow endpoints on private/loopback addresses (local development) |
| `PAYMENT_SETTLEMENT_DELAY_SECONDS` | `0` | Settlement hold: payment funds stay pending this long before they can be spent or paid out |
| `MOCK_PROVIDER_WEBHOOK_SECRET` | — (required with `mock`) | HMAC secret the mock provider signs webhooks with |
| `PAYSTACK_SECRET_KEY` | — (required with `paystack`) | `sk_test_…` outside production, `sk_live_…` only in production. Also verifies webhooks. |
| `PAYSTACK_BASE_URL` | `https://api.paystack.co` | Override for testing |
| `PAYSTACK_TIMEOUT_MS` | `10000` | Paystack request timeout |
| `STRIPE_SECRET_KEY` | — (required with `stripe`) | `sk_test_…` outside production, `sk_live_…` only in production |
| `STRIPE_WEBHOOK_SECRET` | — (required with `stripe`) | Webhook endpoint signing secret (`whsec_…`) |
| `STRIPE_SUCCESS_URL` / `STRIPE_CANCEL_URL` | — (required with `stripe`) | Where Checkout returns the customer |
| `STRIPE_WEBHOOK_TOLERANCE_SECONDS` | `300` | Maximum webhook age (replay protection) |
| `STRIPE_BASE_URL` / `STRIPE_TIMEOUT_MS` | `https://api.stripe.com` / `10000` | Override for testing / request timeout |
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
| `REDIS_HOST` / `REDIS_PORT` | `localhost` / `6379` | Redis for queues (`REDIS_PORT` is also the host port Compose publishes) |
| `REDIS_PASSWORD` / `REDIS_DB` | — / `0` | Redis auth and database index |
| `QUEUE_PREFIX` | `finstack` | Namespaces queue keys in a shared Redis |
| `WORKERS_ENABLED` | `true` | Run the outbox relay and queue workers in this process |
| `OUTBOX_POLL_INTERVAL_MS` | `500` | How often the relay checks the outbox |
| `WEBHOOK_MAX_ATTEMPTS` | `8` | Webhook processing attempts before dead-lettering |
| `WEBHOOK_RETRY_BACKOFF_MS` | `2000` | First retry delay (doubles each attempt) |

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

## Organizations and API keys

Businesses are **organizations**. Members have a role (owner, admin, member, viewer) that grants permissions. Servers call the API with **API keys** scoped to one organization.

| Endpoint | Permission | Description |
| --- | --- | --- |
| `POST /v1/organizations` | signed in | Create an organization (you become the owner) |
| `GET /v1/organizations` | signed in | My organizations, with my role |
| `GET /v1/organizations/:id` | `organization:read` (API key allowed) | Organization details |
| `GET` / `POST /v1/organizations/:id/members` | `organization:read` / `members:manage` | List or add members |
| `PATCH` / `DELETE /v1/organizations/:id/members/:userId` | `members:manage` | Change role or remove (the owner is protected) |
| `POST /v1/organizations/:id/transfer-ownership` | owner | Make another member the owner |
| `POST` / `GET /v1/organizations/:id/api-keys` | `api_keys:manage` | Create (secret shown once) or list keys |
| `DELETE /v1/organizations/:id/api-keys/:keyId` | `api_keys:manage` | Revoke a key |

```bash
curl localhost:3000/v1/organizations/<id> -H "X-API-Key: fsk_test_..."
```

API keys are accepted **only on endpoints marked for them**. They're stored as hashes, bound to one organization, limited to their scopes, and can be revoked or set to expire. Non-members get `404` for an organization, so ids can't be probed. See [ADR 0015](./docs/adr/0015-organizations-and-api-keys.md).

### Organization wallets and payments

Organizations own money just as users do. Each wallet, payment and transaction belongs to exactly one user or one organization, and the database enforces this with a CHECK constraint. Organization wallets follow the same rules: `WALLETS_PER_OWNER`, the allowed currencies, a primary wallet, and FX conversion.

| Endpoint | Permission | Description |
| --- | --- | --- |
| `POST` / `GET /v1/organizations/:id/wallets` | `wallets:manage` / `wallets:read` | Open or list the organization's wallets |
| `GET /v1/organizations/:id/wallets/:walletId[/entries]` | `wallets:read` | Balances and ledger entries |
| `POST /v1/organizations/:id/wallets/:walletId/primary` | `wallets:manage` | Change the primary wallet |
| `POST /v1/organizations/:id/payments` | `payments:create` | Collect from a customer (`customerEmail` required, Idempotency-Key) |
| `GET /v1/organizations/:id/payments/:paymentId` · `POST …/verify` | `transactions:read` · `payments:create` | Read or verify a payment |
| `GET /v1/organizations/:id/transactions[/:transactionId]` | `transactions:read` | Payments in, refunds out |

All of these accept API keys with the matching scope. On organization routes, the Idempotency-Key is shared by the organization's members and API keys, so a retry from any of them replays the original. See [ADR 0016](./docs/adr/0016-organization-ownership.md).

```bash
curl -X POST localhost:3000/v1/organizations/<id>/payments \
  -H "X-API-Key: fsk_test_..." -H "Idempotency-Key: order-1042" \
  -H "Content-Type: application/json" \
  -d '{"amount": 250000, "currency": "NGN", "customerEmail": "customer@example.com"}'
```

### Audit logs

Sensitive and administrative actions are recorded in an **append-only** `audit_logs` table (a database trigger rejects edits and deletes). Each entry is written in the same transaction as the change and records:
- who did it (user, API key or system)
- what they did, to what, and with which details
- the request id and IP

Audited areas include members and roles, API keys, wallets, refunds, FX rates, webhook replays and refresh-token reuse.

| Endpoint | Access |
| --- | --- |
| `GET /v1/organizations/:id/audit-logs` | `audit_logs:read` (owner, admin) |
| `GET /v1/admin/audit-logs` | platform admin; filter by `organizationId`, `actorId`, `action`, `targetType`, `targetId` |

See [ADR 0017](./docs/adr/0017-audit-logs.md).

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
| `POST /v1/webhooks/:provider` | Signature | Provider callbacks (`mock`, `paystack`, `stripe`) |
| `POST /v1/dev/mock-provider/payments/:providerReference/complete` | Bearer | **Dev only:** finish a mock checkout (sends a signed webhook) |

**Flow:** the crediting rule picks the wallet (locking an FX quote if the currencies differ) → the provider returns a checkout URL → the customer pays → the provider's **signed** webhook arrives → FinStack **re-checks the payment with the provider** and compares the amount → one database transaction credits the wallet (converting if needed), posts the ledger and marks the transaction `successful`.

Duplicate webhooks are ignored and forged ones rejected. Verified webhooks are stored and settled **asynchronously** by a BullMQ worker, with automatic retries and exponential backoff. Events that exhaust their retries can be replayed by an admin. The wallet is credited at most once, however many webhooks and verify calls race. See [ADR 0012](./docs/adr/0012-payments-and-webhooks.md).

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

### Payment providers

| Provider | Currencies | Webhook URL | Notes |
| --- | --- | --- | --- |
| `mock` | all supported | `/v1/webhooks/mock` | Development only; refused in production |
| `paystack` | NGN, USD, GHS, ZAR, KES | `/v1/webhooks/paystack` | Set `PAYMENT_PROVIDERS=paystack` and `PAYSTACK_SECRET_KEY`. Configure the webhook URL in the Paystack dashboard. |
| `stripe` | USD, EUR, GBP, JPY, NGN, KES, ZAR (check your account) | `/v1/webhooks/stripe` | Hosted Checkout Sessions. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`. Subscribe the webhook endpoint to `checkout.session.*` events. |

**Routing by currency.** `PAYMENT_CURRENCY_ROUTES` pins currencies to providers, e.g. `USD:stripe,NGN:paystack`:

- A payment in a routed currency always uses that provider. Asking for another returns `422 PROVIDER_NOT_ALLOWED_FOR_CURRENCY`.
- Other currencies use the requested provider or `DEFAULT_PAYMENT_PROVIDER`.
- The app refuses to start if a route points to a provider that isn't enabled or can't charge that currency.

A provider is one class implementing `PaymentProvider` (`src/payment-providers/payment-provider.ts`): initialise, verify, refund, verify the webhook signature, parse the event. See `src/payment-providers/paystack/` for a complete adapter. Provider errors are classified for you by `JsonHttpClient`: timeouts, 5xx and 429 are retryable (the payment stays `pending`), and other 4xx responses are rejections.

The Paystack and Stripe adapters are tested against local fakes of each API (`test/utils/fake-paystack.ts`, `test/utils/fake-stripe.ts`). The fakes use the same endpoints, encodings, idempotency behaviour and webhook signature schemes. Stripe webhooks older than `STRIPE_WEBHOOK_TOLERANCE_SECONDS` are rejected even with a valid signature, which prevents replays.

### Settlement holds

Set `PAYMENT_SETTLEMENT_DELAY_SECONDS` and successful payments land in the wallet's **pending** balance. After the delay, a worker moves them to available (checked every minute). Until then they can't be transferred or paid out. Payments show `fundsAvailableAt` and `heldAmount`. Admins can end a hold early with `POST /v1/admin/payments/:id/release` (audited). A refund of a held payment is taken from its pending credit. See [ADR 0019](./docs/adr/0019-settlement-holds.md).

## Refunds

| Endpoint (admin) | Description |
| --- | --- |
| `POST /v1/admin/payments/:id/refunds` | Full or partial refund: `{ "amount": 775000, "reason": "..." }`. Omit `amount` for the remaining balance. Requires `Idempotency-Key`. |
| `GET /v1/admin/refunds/:id` | Refund status (`processing`, `successful`, `failed`) |
| `POST /v1/admin/refunds/:id/retry` | Re-ask the provider about a refund stuck in `processing` |

- The refund amount is **held** in the wallet first. If the user already spent it, the refund is refused with `INSUFFICIENT_FUNDS` before the provider is called.
- The total refunded can never exceed the payment, even under concurrent requests.
- **Converted payments are refunded at the original rate, margin included**: the customer gets back exactly what they paid, in proportion for partial refunds, with exact totals across several partial refunds.
- Provider refund webhooks are verified and re-checked with the provider before settling. A failed refund returns the held funds.

See [ADR 0014](./docs/adr/0014-refunds.md).

## Payouts

Withdraw from a wallet to a bank account. Users use `/v1/...`; organizations use `/v1/organizations/:id/...`, where saving destinations needs `payout_destinations:manage` and sending payouts needs `payouts:create` (which can be given to API keys).

| Endpoint | Description |
| --- | --- |
| `POST` / `GET /v1/payout-destinations` | Save a bank account (verified by the provider; only the last 4 digits are stored) or list them |
| `DELETE /v1/payout-destinations/:id` | Remove one |
| `POST /v1/payouts` | Withdraw (Idempotency-Key). Holds the funds, sends them, and settles by webhook |
| `GET /v1/payouts/:id` | Status: `processing`, then `successful`, `failed` (hold released) or `reversed` (credited back) |
| `POST /v1/admin/payouts/:id/sync` | Admin: re-check a payout with the provider |

```bash
curl -X POST localhost:3000/v1/payouts -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: withdraw-1" -H "Content-Type: application/json" \
  -d '{"destinationId": "<id>", "amount": 500000}'
```

A payout is **never sent twice**. The provider is always asked about our reference before anything is sent again, and payouts stuck in `processing` are re-checked every few minutes. Payouts work with the mock and **Paystack Transfers** (NGN, GHS, ZAR). Stripe payouts would need Stripe Connect and aren't included. See [ADR 0018](./docs/adr/0018-payouts.md).

## Reconciliation

Every day at 02:00 UTC, FinStack compares the previous day's payments and payouts with each provider's own records (mock, Paystack and Stripe), and checks that the ledger balances. Admins can also start a run for any period of up to 31 days.

- **Late webhooks are fixed automatically** through the normal settlement paths. Examples are a payment the provider says succeeded but that is still pending here, or a payout the provider completed silently.
- **Every other difference becomes an item to resolve:** money collected but not credited, credited but not collected, amount mismatches, unknown provider records, and ledger problems. Reconciliation never moves money on its own.

| Endpoint | Description |
| --- | --- |
| `POST /v1/admin/reconciliation/runs` | Start a run: `{ "provider": "paystack", "from": "…", "to": "…" }` (omit `provider` for the ledger check) |
| `GET /v1/admin/reconciliation/runs[/:id]` | Runs with their summary (checked, issues, auto-resolved) |
| `GET /v1/admin/reconciliation/items?status=open` | The work queue |
| `POST /v1/admin/reconciliation/items/:id/resolve` | Record what was done (audited) |

See [ADR 0020](./docs/adr/0020-reconciliation.md).

## Outbound webhooks

Organizations register HTTPS endpoints and receive **signed** event callbacks. Available events: `payment.successful`, `payment.failed`, `payment.funds_available`, `refund.successful`, `refund.failed`, `payout.successful`, `payout.failed`, `payout.reversed`, or `*` for all. Deliveries retry with exponential backoff, and every attempt is logged. Failed deliveries can be redelivered, and an endpoint that keeps failing is disabled automatically. Managing endpoints requires `webhooks:manage` (owner, admin).

| Endpoint | Description |
| --- | --- |
| `POST` / `GET /v1/organizations/:id/webhook-endpoints` | Register (the signing secret is shown once) or list endpoints |
| `PATCH` / `DELETE …/webhook-endpoints/:endpointId` | Change the URL or events, disable or re-enable, delete |
| `POST …/:endpointId/rotate-secret` | New secret; the old one keeps signing during a grace period |
| `POST …/:endpointId/test` | Send a `webhook.test` event |
| `GET …/:endpointId/deliveries`, `POST …/deliveries/:deliveryId/redeliver` | Delivery log and redelivery |

**Verifying a request** (Node.js). Use the raw body, check the signature, reject stale timestamps, and dedupe on the event `id`:

```js
const crypto = require('node:crypto');

function verify(header, rawBody, secret, toleranceSeconds = 300) {
  const pairs = header.split(',').map((part) => part.split('='));
  const t = Number(pairs.find(([key]) => key === 't')?.[1]);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return pairs
    .filter(([key]) => key === 'v1')
    .some(([, hex]) => {
      const given = Buffer.from(hex, 'hex');
      return given.length === expected.length && crypto.timingSafeEqual(given, expected);
    });
}
```

Signing secrets are stored encrypted (`DATA_ENCRYPTION_KEY`), and URLs that point at private or internal addresses are refused in production. See [ADR 0021](./docs/adr/0021-outbound-webhooks.md).

## Email notifications

Users are emailed about their money: payments received (including when held funds become available), refunds sent, withdrawals sent, failed or returned, and transfers sent and received. For organizations, failed or returned payouts go to their owners and admins; everything else reaches organizations through webhooks. Each email is sent **once**, even if its event is processed twice.

- `EMAIL_DRIVER=log` (default) logs emails instead of sending them.
- `EMAIL_DRIVER=smtp` with `SMTP_URL=smtps://user:pass@smtp.example.com:465` sends through any SMTP service (SES, Postmark, SendGrid, Mailgun). Set the sender with `EMAIL_FROM`.

See [ADR 0022](./docs/adr/0022-email-notifications.md).

## Admin tooling

Platform admins (`role = admin`) can find accounts, see their money, and act. Every action requires a `reason` and is audited.

| Endpoint | Description |
| --- | --- |
| `GET /v1/admin/overview` | Users and organizations by status, what's owed to wallet holders per currency, and what needs attention (stuck payouts/refunds, open reconciliation items, failed webhooks) |
| `GET /v1/admin/users?email=&status=`, `GET …/users/:id` | Search users; a user with their wallets and organizations |
| `POST /v1/admin/users/:id/suspend` · `/reactivate` | Suspension takes effect immediately (even for issued tokens) and ends all sessions |
| `GET /v1/admin/organizations?name=&status=`, `GET …/organizations/:id` | Search organizations; members and wallets |
| `POST /v1/admin/organizations/:id/suspend` · `/reactivate` | Read-only for members; API keys stop working |
| `GET /v1/admin/wallets/:id`, `POST …/freeze` · `/unfreeze` | A wallet with its owner; freezing stops money leaving it |

Other admin endpoints live with their features: refunds, payment releases, payouts, reconciliation, webhook events, FX rates and audit logs. See [ADR 0023](./docs/adr/0023-admin-tooling.md).

## Events and background jobs

Money movements record domain events (`payment.successful`, `payment.failed`, `refund.successful`, `refund.failed`, `transfer.completed`) in a **transactional outbox**: the same database transaction as the change itself, so an event exists if and only if the money moved. A relay publishes them to **BullMQ** (Redis), and workers handle them at least once.

| Queue | Purpose |
| --- | --- |
| `webhooks` | Settles stored webhooks; retries with exponential backoff, then dead-letters |
| `domain-events` | Delivers events to handlers (`src/events/`); add yours to `DOMAIN_EVENT_HANDLERS` |
| `maintenance` | Hourly cleanup of expired idempotency keys, old refresh tokens and published outbox rows |

| Endpoint (admin) | Description |
| --- | --- |
| `GET /v1/admin/webhook-events?status=failed` | Dead-lettered webhook events |
| `POST /v1/admin/webhook-events/:id/replay` | Replay one (settlement is idempotent) |
| `GET /v1/admin/queues` | Queue depths and failure counts |

Set `WORKERS_ENABLED=false` on API-only instances to run workers separately. See [ADR 0013](./docs/adr/0013-outbox-and-background-jobs.md).

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
| `GET /health/ready` | Readiness: PostgreSQL and Redis are reachable. Returns `503` otherwise. |

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
  - [x] Organizations, role-based permissions, API keys
  - [x] Organization-owned wallets, payments and transactions
- [ ] **Phase 2 — Payments** (done: provider abstraction, mock, Paystack and Stripe providers, currency routing, payments with FX, signed webhooks, outbox, BullMQ workers, refunds): provider abstraction (Mock, Paystack, Stripe), webhooks, refunds, outbox, background jobs
- [ ] **Phase 3 — Operations** (done: audit logs, payouts, settlement holds, reconciliation, outbound webhooks, email notifications, admin tooling): observability
- [ ] **Phase 4 — Developer platform:** CLI, more providers, dashboard, sandbox

## Architecture decisions

See [`docs/adr/`](./docs/adr/).

## License

[MIT](./LICENSE)
