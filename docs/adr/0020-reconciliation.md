# ADR 0020: Reconciliation

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

FinStack's ledger is internally consistent by construction (ADR 0007). The outside world is not bound by our invariants, though:
- webhooks get lost
- a provider records a charge we never heard about
- a payment we credited is later marked failed
- a transfer changes state silently

Without regular comparison, these differences surface only when a customer complains, or in the month-end books.

## Decision

### Runs

- A **run** compares one provider's records with ours for a period (half-open `[from, to)`). A run without a provider checks the **ledger** instead:
  - every account's cached balance must equal the sum of its entries
  - debits must equal credits in every currency
- **Daily:** at 02:00 UTC the maintenance queue runs the ledger check and one run per reconcilable provider, for the previous UTC day. Scheduled runs are unique per check and period (partial unique indexes), so several instances can't duplicate them.
- **On demand:** `POST /v1/admin/reconciliation/runs` (at most 31 days, not in the future). It is processed by the worker; poll the run for the result.
- A provider error (outage, too many pages) **fails the run** with the reason, rather than producing a partial comparison that looks clean.

### Provider capability

`PaymentProvider.reconciliation`:
- `listPayments(range)` for mock, Paystack (`/transaction`) and Stripe (Checkout Sessions).
- `listPayouts(range)` for mock and Paystack (`/transfer`).

Lists are paginated to completion. More than 200 pages is refused, and the period should be shortened.

### Matching

Matching runs in both directions, and boundaries get a second look before anything is flagged:
- **Theirs to ours:** by the provider reference (payments) or our reference (payouts). A record outside our time window is looked up directly.
- **Ours to theirs:** a credited payment or a sent payout that is missing from the provider's list is asked about individually (`verifyPayment`, `payouts.find`) before it's flagged.

### What counts as a difference

| Issue | Meaning |
| --- | --- |
| `missing_in_finstack` | The provider collected money (or has a transfer) we have no record of |
| `not_credited` | The provider collected it; we never credited it |
| `credited_without_payment` | We credited it; the provider didn't collect it |
| `amount_mismatch` | Amounts or currencies differ |
| `status_mismatch` | A payout's state differs from the provider's |
| `balance_discrepancy`, `trial_balance_mismatch` | The ledger check failed |
| `late_settlement` | Auto-resolved: see below |

Refunds don't count as differences. A refunded payment was still collected.

### Fixing

- **Only late webhooks are fixed automatically, through the normal paths.** A pending payment the provider says succeeded is settled (`PaymentSettlementService.settle`, which re-verifies). A payout whose state moved on is synced (`PayoutsService.sync`). These are recorded as `auto_resolved` items, so they stay visible.
- **Everything else becomes an `open` item.** A person investigates, fixes the money deliberately (for example with a refund or a manual adjustment), and resolves the item with a note (`POST …/items/:id/resolve`, audited). Reconciliation never moves money on its own judgement.
- Each run writes a `reconciliation.completed` outbox event with the open-issue counts, as a hook for alerting.

## Consequences

- Provider fees and settlement reports (what actually reached the bank account) are not compared yet. That's the next level: matching payouts from provider to bank against external clearing.
- A run that crashes mid-way stays `running`. Start a new manual run for the same period. The checks are read-only apart from the idempotent auto-fixes.
