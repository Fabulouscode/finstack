# ADR 0019: Settlement holds

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

A card payment reported as successful can still be taken back: a chargeback, a fraud reversal, or a provider settlement that never arrives. If the money is spendable at once, it can be transferred or paid out before that happens, and the platform absorbs the loss. Most payment platforms therefore keep incoming funds **pending** for a while before they become available.

## Decision

- **`PAYMENT_SETTLEMENT_DELAY_SECONDS`** (default `0`, meaning immediate, as before). When it is set:
  - A successful payment credits the wallet's **pending** balance (a ledger account every wallet already has), converted if needed. The same database transaction records on the payment `pending_amount` (wallet currency) and `funds_available_at`.
  - Pending money is not spendable. Transfers, payouts and conversions draw only on available.
- **Release.** A maintenance job runs every minute and moves each due payment's `pending_amount` from pending to available. It posts a ledger entry with the reference `settlement:<paymentId>`, sets `pending_amount` to 0, and writes a `payment.funds_available` outbox event. The job locks the payment row, so it's idempotent and safe to run concurrently.
- **Early release.** `POST /v1/admin/payments/:id/release`, for example for a trusted merchant. Audited as `payment.released_early`.
- **Refunds during a hold.** They are funded from that payment's pending credit first (`reserveSplitWithin`), then from available, and the refund records how much came from pending.
  - If the refund fails while the hold lasts, that part goes back to pending and the payment's `pending_amount` grows back.
  - If the hold has already ended, it all goes to available.
  
  This keeps two rules true: refunds never take someone else's available money when the payment's own credit is still there, and a failed refund can't turn held money into spendable money early.
- API: payments show `fundsAvailableAt` and `heldAmount`. Wallet balances already show `pending`.

## Consequences

- There is one global delay. Per-merchant or risk-based delays, such as shorter holds for trusted organizations, are a natural extension: the delay is decided in one place, at crediting time.
- Chargebacks themselves (debiting a wallet after a dispute) are a separate feature. Holds reduce the exposure but don't handle disputes.
