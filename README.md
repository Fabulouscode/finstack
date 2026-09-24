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
- Every non-2xx response it can return (`@ApiBadRequestResponse`, `@ApiConflictResponse`, ...).

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

- [ ] **Phase 1 — Financial foundation:** config, PostgreSQL/TypeORM, Docker, auth, users, organizations, wallets, ledger, transactions, idempotency, row locking, Swagger
- [ ] **Phase 2 — Payments:** provider abstraction (Mock, Paystack, Stripe), webhooks, refunds, outbox, background jobs
- [ ] **Phase 3 — Operations:** reconciliation, audit logs, admin, notifications, observability
- [ ] **Phase 4 — Developer platform:** CLI, more providers, dashboard, sandbox

## Architecture decisions

See [`docs/adr/`](./docs/adr/).

## License

[MIT](./LICENSE)
