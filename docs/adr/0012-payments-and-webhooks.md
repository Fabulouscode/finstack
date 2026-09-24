# ADR 0012: Payments, provider adapters and webhooks

- **Status:** Accepted
- **Date:** 2026-09-24

## Context

Incoming payments cross a trust boundary twice: FinStack asks a provider to charge a customer, and the provider later tells FinStack what happened through webhooks. Networks fail, providers retry, webhooks arrive twice, late or in the wrong order, and anyone can POST to a public webhook URL. None of that may create or duplicate money.

## Decision

### Provider abstraction

Payment logic depends only on the `PaymentProvider` interface (`initializePayment`, `verifyPayment`, `refundPayment`, `verifyWebhookSignature`, `parseWebhookEvent`). Adapters are registered in `PaymentProvidersService`. The first adapter is an in-memory **mock provider** with real HMAC-SHA256-signed webhooks. It's refused in production by config validation. Paystack and Stripe adapters implement the same interface.

### Initialisation

1. The crediting rule ([ADR 0010](./0010-flexible-wallet-model.md)) picks the wallet. If the currencies differ, an FX quote is locked now ([ADR 0009](./0009-fx-conversion.md)) and shown to the customer.
2. A `pending` transaction and a `payments` row commit first.
3. The provider is called **outside any database transaction**, so no locks are held during network I/O.
   - A definite rejection marks the transaction `failed` (`PROVIDER_REJECTED`).
   - An outage or timeout leaves it `pending` and returns `503`. The client retries with the same Idempotency-Key, and the provider is re-initialised with the same reference, which providers treat idempotently.

### Webhooks

| Step | Guarantee |
| --- | --- |
| Signature verified over the **raw bytes** (`rawBody: true`) | Unsigned or tampered requests are rejected (`401`) and nothing is stored |
| Event stored with a unique `(provider, event_id)` | Duplicate deliveries are acknowledged (`duplicate: true`) without reprocessing |
| **The payload is not trusted**: the payment's state is fetched from the provider with `verifyPayment` | A forged or replayed "success" can't credit anyone. The provider is the authority. |
| Amount and currency compared with the payment record | A mismatch fails the payment (`AMOUNT_MISMATCH`) and is flagged for reconciliation. A guessed amount is never credited. |
| Processing errors recorded on the event, and the provider still gets `200` | FinStack owns retries. It doesn't depend on provider redelivery policies. |

### Settlement

`PaymentSettlementService.settle()` is shared by the webhook path and `POST /v1/payments/:id/verify`. In **one database transaction** it:

1. Locks the transaction row (`FOR UPDATE`). Concurrent settlements of one payment queue up; later ones see `successful` and do nothing.
2. Credits the wallet: directly, or through the two-leg FX conversion at the locked quote. A quote that expired before the customer paid is **re-quoted** at the current rate, and the transaction is flagged with `lateFxRequote`.
3. Moves the transaction to `successful` with its ledger transaction id.

The ledger reference `payment:<transaction reference>` is a further idempotency backstop.

### Synchronous vs asynchronous

| Operation | Mode | Why |
| --- | --- | --- |
| Initialise payment | Synchronous | The client needs the checkout URL now |
| Verify endpoint | Synchronous | The client is waiting for the result after checkout |
| Webhook: verify signature, store event | Synchronous | Must reject forgeries and dedupe before acknowledging |
| Webhook: settle | Synchronous for now; moves to a BullMQ worker with retries and backoff | Should not depend on the provider's HTTP timeout, and needs retries independent of the provider |

## Consequences

- The full first vertical slice (user → wallet → payment → signed webhook → provider verification → FX conversion → ledger → wallet → transaction history) is covered by one e2e test, with separate tests for duplicate webhooks, forged signatures, declines, amount mismatches, races between webhook and verify, provider outages at checkout and at verification, late FX, and frozen wallets.
- Money received but not credited (amount mismatch, success after cancellation) is logged and left for the reconciliation module rather than handled automatically.
- The mock provider's state is in memory: fine for development and tests, and the reason it is disabled in production.
