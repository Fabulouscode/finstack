# ADR 0029: Sandbox

- **Status:** Accepted
- **Date:** 2026-09-26

## Context

Businesses integrating with a FinStack deployment need somewhere to build and test without real money:
- create payments and see them succeed or fail
- receive webhooks
- exercise payouts and their failure cases

Until now that meant running FinStack locally. The only simulation helper (`/v1/dev/mock-provider/...`) had **no ownership check**: anyone signed in could complete anyone's mock payment. That's acceptable on a laptop, but unsafe anywhere shared.

There were two ways to offer a sandbox:
1. **Test mode inside the live deployment** (Stripe-style). Every row carries a live/test flag, test keys only see test data, and every query and constraint must respect the partition.
2. **A separate sandbox deployment** of the same code (as with Paystack and Flutterwave). Separate database, separate keys, simulated providers.

## Decision

**A separate deployment** (option 2), switched on with `SANDBOX_MODE=true`. Option 1 would touch every table, query and unique index of a working system. One missed filter would mix test and live money, which is the worst class of bug for a financial system. A separate deployment isolates test and live data by construction.

### The switch

- The mock provider is allowed even with `NODE_ENV=production`. **Live provider keys are refused**, and test keys are allowed.
- API keys are `fsk_test_…`; `fsk_live_…` exists only where real money moves (`isLive` = production and not a sandbox).
- Every response carries `FinStack-Mode: sandbox`.
- Everything else is production: `DATA_ENCRYPTION_KEY`, secrets, metrics tokens, rate limits.

### Simulation API (replacing the dev helper)

- `/v1/sandbox/…` for users and `/v1/organizations/:id/sandbox/…` for organizations: fund a wallet, complete or fail a payment (optionally collecting a different amount), and complete, fail or reverse a payout.
- **Ownership is checked** through the owning services (`getOwned`), with organization permissions (`payments:create`, `payouts:create`), and API keys are allowed. Anything that isn't yours is a `404`.
- **Real pipeline:** the mock provider signs a webhook, `WebhooksService.receive` verifies and stores it, and it is processed like any provider's. Settlement also runs straight away, so the response shows the result.
- Wherever the mock provider is off, the API returns `404`.

### Test bank accounts

Payout behaviour is chosen per bank account, like card networks' test cards, so developers sharing a sandbox don't affect each other:
- account numbers ending `0001` are rejected at once
- account numbers ending `0002` stay pending until completed through the API
- all others succeed

## Consequences

- **Run a sandbox as a single instance.** The mock provider's state (checkouts, payouts) lives in process memory, so with several instances a webhook could be processed by an instance that doesn't know the payment. Persisting mock state in Redis would lift this limit.
- The sandbox needs its own database and Redis, and is deployed and upgraded like production. The same build serves both environments.
- Currency policies still apply: with Stripe enabled in a sandbox (test keys), USD goes to Stripe's test mode rather than the mock provider.
