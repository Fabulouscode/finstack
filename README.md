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

### Install and run

```bash
npm install
npm run start:dev
```

### Scripts

| Script | Description |
| --- | --- |
| `npm run start:dev` | Start in watch mode |
| `npm run build` | Compile to `dist/` |
| `npm run typecheck` | Type-check without emitting |
| `npm run lint` | Lint with ESLint (type-checked rules) |
| `npm run format` | Format with Prettier |
| `npm test` | Unit tests |
| `npm run test:e2e` | End-to-end tests |
| `npm run test:cov` | Unit tests with coverage |

## Roadmap

- [ ] **Phase 1 — Financial foundation:** config, PostgreSQL/TypeORM, Docker, auth, users, organizations, wallets, ledger, transactions, idempotency, row locking, Swagger
- [ ] **Phase 2 — Payments:** provider abstraction (Mock, Paystack, Stripe), webhooks, refunds, outbox, background jobs
- [ ] **Phase 3 — Operations:** reconciliation, audit logs, admin, notifications, observability
- [ ] **Phase 4 — Developer platform:** CLI, more providers, dashboard, sandbox

## Architecture decisions

See [`docs/adr/`](./docs/adr/).

## License

[MIT](./LICENSE)
