# ADR 0014: Refunds

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

A refund sends money back to the customer's card or account through the provider that collected it. It can be partial or repeated. It can be pending at the provider for days, and it can fail. For converted payments, it must also unwind an FX conversion. Money must never be refunded twice, refunded beyond the payment, or refunded from a wallet that no longer holds it.

## Decision

**Who:** admins only (`POST /v1/admin/payments/:id/refunds`, `Idempotency-Key` required). Refunds move money out of a user's wallet, so they need an operator decision.

**Lifecycle** (status on a `refund` transaction):

1. **Request, in one DB transaction.** Lock the payment row, compute the remaining refundable amount (payment minus non-failed refunds), create the refund, and **hold** the wallet amount (available → reserved). If the wallet no longer has the money, the request fails with `INSUFFICIENT_FUNDS` before any provider call. The payment lock serialises concurrent refunds, so they can't over-commit.
2. **Submit, outside any DB transaction.** Call the provider, idempotent by the refund reference (`rfd_…`).
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
