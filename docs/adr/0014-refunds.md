# ADR 0014: Refunds

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

A refund sends money back to the customer's card or account through the provider that collected it. It can be partial or repeated. It can be pending at the provider for days, and it can fail. For converted payments, it must also unwind an FX conversion. Money must never be refunded twice, refunded beyond the payment, or refunded from a wallet that no longer holds it.

## Decision

**Who:** admins only (`POST /v1/admin/payments/:id/refunds`, `Idempotency-Key` required). Refunds move money out of a user's wallet, so they need an operator decision.

**Lifecycle** (status on a `refund` transaction):

1. **Request, in one DB transaction.** Lock the payment row, compute the remaining refundable amount (payment minus non-failed refunds), create the refund, and **hold** the wallet amount (available → reserved). If the wallet no longer has the money, the request fails with `INSUFFICIENT_FUNDS` before any provider call. The payment lock serialises concurrent refunds, so they can't over-commit.
2. **Submit, outside any DB transaction.** Call the provider with the refund reference (`rfd_…`). Never sent twice: see the amendment below.
   - `successful` → complete.
   - `pending` → wait for the webhook.
   - Rejection → fail (hold released).
   - Outage → stays `processing` with the hold kept, and an admin can retry (`POST /v1/admin/refunds/:id/retry`).
3. **Complete, in one DB transaction.** The held funds leave (reserved → external clearing), and the refund becomes `successful`. When the payment is fully refunded, its transaction becomes `reversed`. `refund.successful` goes to the outbox.
4. **Fail, in one DB transaction.** The hold is released (reserved → available), the refund becomes `failed`, and `refund.failed` goes to the outbox.

**Webhooks.** Provider refund events (Paystack `refund.processed` and `refund.failed`, Stripe `refund.*` objects) go through the signed, deduplicated webhook pipeline. As with payments, the payload is only a hint: every matching processing refund is **re-checked with the provider** (`getRefund`) before it settles.

**FX refunds: original rate, margin refunded.** For a converted payment, the refund reverses the original conversion in proportion. The customer gets back exactly what they paid, the wallet gives back the proportional credit, and the FX margin is returned. Amounts are computed **cumulatively** (difference between "refunded including this one" and "refunded before"), so any sequence of partial refunds sums exactly to the original credit, gross and margin. The wallet debit rounds up and the margin reversal rounds down, so the platform never reverses more revenue than it earned. A fully refunded conversion leaves the FX position, FX revenue and clearing accounts exactly where they started.

## Consequences

- No double refunds (idempotency key plus row lock), no refunds beyond the payment, and no refunds of money the user already spent.
- A pending refund keeps the funds reserved, so the user sees them as unavailable until the provider settles.
- Refunds stuck `processing` (outage, lost webhook) need a retry. An automatic retry and reconciliation job belongs to the reconciliation module.
- A product that wants to keep its FX margin on refunds changes one function (`reverseConversion`).

## Amendment (2026-10-01): never sent twice

The original decision assumed providers deduplicate refunds by our reference. Only Stripe does (through its `Idempotency-Key`, and only for 24 hours). Paystack and Flutterwave make a new refund on every call. If a refund request timed out after the provider had acted, a retry (admin retry or webhook) refunded the customer twice. The mock provider also deduplicated, so no test caught it.

Refunds now follow the payout rule (ADR 0018):

- **`submitted_at`** records when a refund was last sent. Existing refunds were backfilled with their creation time, since every one of them was sent then.
- **Ask before resending.** Once sent, a refund is only sent again after the provider's `findRefund` confirms it has no refund with our reference. Every adapter implements it: Stripe matches the `finstack_reference` metadata; Paystack (`merchant_note`) and Flutterwave (`comment`) list the payment's refunds and match our reference.
- **Never guess.** When a provider's list has a refund without a note, it could be ours with the note dropped, so `findRefund` reports "can't tell" and nothing is resent. The refund stays `processing` with the hold kept, visible in the admin overview, for a person to resolve.
- **One sender at a time.** A conditional update of `submitted_at` lets only one of request, retry and webhook send. A refund sent within the last 5 minutes is never resent, because the first request may still be in flight.
- **Only a rejected send fails a refund.** Errors from status checks and lookups leave it `processing`: the money may already have reached the customer, so releasing the hold could pay out twice. Before, a 4xx from a status check failed the refund.
- The mock provider no longer deduplicates, and has `lost` (made, response lost) and `unsure` (lookups can't tell) modes. Tests cover each case and a race of concurrent retries.

