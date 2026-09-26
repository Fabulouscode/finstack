# Contributing to FinStack

Thanks for helping. FinStack is a starter kit for fintech backends, so correctness matters more than speed: every change should keep the money right.

## Getting set up

Requirements: Node.js 24.9+ (`nvm use`), npm 11+, and Docker.

```bash
npm install
cp .env.example .env
npm run infra:up          # PostgreSQL and Redis
npm run migration:run
npm run start:dev         # http://localhost:3000/docs
```

## Before you open a pull request

CI runs all of these, and so should you:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test                  # unit
npm run test:int          # integration (needs npm run infra:up)
npm run test:e2e          # end to end (needs npm run infra:up)
```

## How the code is organised

- **One module per domain** (`src/wallets`, `src/payments`, …). Modules use each other only through exported services, never through each other's tables (ADR 0003).
- **Money is an integer in minor units** (`bigint`), never a float. Every balance change is a balanced ledger posting (ADR 0007).
- **Money-moving writes happen in one database transaction.** Lock rows when order matters, and make external calls (providers, email) outside it.
- **Retries must be safe.** Use idempotency keys, unique constraints, and state checks under a row lock.
- **Schema changes go through migrations** (`npm run migration:generate -- src/database/migrations/Name`). CI fails if entities and migrations drift apart.
- **Errors** are `AppException`s with a stable `code`.

## What a good pull request has

- **Tests for the behaviour:** failure cases and concurrency where they apply. For anything involving locks, check that the test fails without the lock.
- **Docs:** a README update for user-facing changes, and a new ADR in `docs/adr/` for design decisions.
- **Business rules as configuration, not code.** FinStack is used by different businesses: provide defaults they can change, like fee rules, limit rules and currency routes.
- **Small and focused.** Separate refactors from behaviour changes.

## Reporting bugs

Open an issue with what you did, what you expected, and what happened, including the response body and `X-Request-Id`. **Security issues go through [SECURITY.md](./SECURITY.md), not public issues.**

By contributing, you agree your contributions are licensed under the [MIT License](./LICENSE).
