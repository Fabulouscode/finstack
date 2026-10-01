# Changelog

All notable changes to FinStack. The format follows [Keep a Changelog](https://keepachangelog.com/), and versions follow [Semantic Versioning](https://semver.org/). Until 1.0, minor versions may include breaking changes, listed under **Changed**.

## [Unreleased]

### Added
- Deployment guide (`docs/deployment.md`): any Docker host, production configuration, provider webhooks and a go-live checklist.
- Render Blueprint (`render.yaml`) and a "Deploy to Render" button that creates a sandbox deployment.
- Flutterwave provider: hosted checkout, verified webhooks (`verif-hash`), refunds, payouts to Nigerian bank accounts through saved beneficiaries, and reconciliation of transactions and transfers. Amounts are converted exactly between FinStack's minor units and Flutterwave's major units. See ADR 0030.

## [0.1.1] - 2026-10-01

Fixes found by testing FinStack end to end against real Paystack and Stripe test accounts: payments, webhooks, partial refunds, payouts and reconciliation.

### Fixed
- Paystack reconciliation no longer flags a settled payment as `credited_without_payment` while a refund is in progress. Paystack reports such transactions as `reversal-pending`, which is now read as collected.
- Verified provider events that FinStack doesn't act on (such as Paystack's `refund.pending`) are recorded as `unhandled_event_type`, not the misleading `no_matching_payment`.
- Refund webhooks that arrive after the refund has already settled (Stripe settles test refunds immediately, then sends `refund.created` and `refund.updated`) are recorded as `refund_already_final`, not `no_matching_refund`.
- A flaky API-key test that could fail when the random secret contained `_`.

## [0.1.0] - 2026-09-26

The first release: a complete fintech backend foundation. Decisions are recorded in `docs/adr/` (ADRs 0001–0029).

### Financial foundation
- Users and authentication: argon2id passwords, short-lived JWTs, rotating refresh tokens with reuse detection. Suspensions and role changes apply immediately.
- Organizations with role-based permissions; API keys (hashed, scoped, revocable).
- Double-entry ledger enforced by the database (immutability, balanced transactions, no negative balances).
- Wallets: single or multi-currency, owned by users or organizations.
- FX conversion with admin-set rates, locked quotes and a configurable spread.
- Transfers with idempotency keys and an explicit transaction state machine.

### Payments
- Provider abstraction with mock, Paystack and Stripe adapters.
- Currency routing: operator routes, then client choice, then suggestions (local → Paystack, international → Stripe), then the default.
- Payments with FX, verified webhooks, transactional outbox and BullMQ workers.
- Refunds (full and partial, reversing FX at the original rate), settlement holds, and payouts to bank accounts that are never sent twice.

### Operations
- Append-only audit logs; daily reconciliation against providers and the ledger.
- Signed outbound webhooks to organizations (encrypted secrets, SSRF protection with DNS pinning).
- Email notifications (log or SMTP).
- Admin tooling with staff roles (support, risk, finance, admin).
- Observability: JSON logs with request and trace ids, Prometheus metrics, traceparent support.

### Risk controls
- Fee rules per operation, currency and organization.
- Velocity limits, enforced atomically under concurrency.
- Cooling-off period and owner alerts for new payout bank accounts.

### Developer platform
- Sandbox deployments (`SANDBOX_MODE`) with an owner-checked simulation API and test bank accounts.
- CI: format, lint, type-check, build, unit, integration and end-to-end tests, and a schema drift check.

[0.1.1]: https://github.com/Fabulouscode/finstack/releases/tag/v0.1.1
[0.1.0]: https://github.com/Fabulouscode/finstack/releases/tag/v0.1.0
