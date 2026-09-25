# ADR 0018: Payouts

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

Money could come into FinStack (payments) but not leave it. Any wallet product needs withdrawals to a bank account: users cashing out, and merchants settling their collections. Payouts are the riskiest flow in the system. The money really leaves, a provider response can be lost in transit, and a bank can return a transfer days later.

## Decision

### Destinations

- A **payout destination** is a bank account saved with the provider (for example a Paystack transfer recipient). FinStack stores:
  - the provider's recipient reference
  - the bank code and name
  - the account holder name
  - the **last four digits** of the account number
  
  The full account number stays with the provider.
- Nigerian accounts are **name-checked** (NUBAN resolve) before they are saved. The stored name is the bank's, not whatever was typed in.
- Destinations belong to a user or an organization (ADR 0016). Removing one is a soft delete, because past payouts still reference it. One active destination is allowed per owner and provider account.

### Flow

The flow follows refunds (ADR 0014):

1. **Hold.** In one database transaction:
   - the wallet is locked and must be active
   - available moves to reserved (this fails with `INSUFFICIENT_FUNDS` if the balance is short)
   - a `withdrawal` transaction is recorded as `processing`
   - the `payouts` row and an audit entry are written
2. **Submit** to the provider, outside any database transaction, with our reference `pyt_…` as the provider's idempotent transfer reference.
3. **Settle** based on the result:
   - `successful`: reserved moves to external clearing.
   - `failed`: the hold is released.
   - `reversed` after success: clearing moves back to available, and the transaction becomes `reversed`.
   
   Each step writes an outbox event (`payout.successful`, `payout.failed`, `payout.reversed`).

### Never paying twice

A lost response ("did the bank send it?") is the dangerous case.
- **Before sending again, always ask the provider** about our reference (`find`). Only a payout the provider has never seen is sent again.
- **Only one sender.** The first submission is claimed atomically (`submitted_at`), so a request, a webhook and the sweep can't all send at once. A claim that the provider still doesn't know about after 5 minutes counts as never arrived (for example, the process died before sending), and may be sent again. The provider also dedupes by reference.
- A rejection before anything was sent fails the payout and releases the hold. A rejection on a later attempt leaves the payout `processing`, because the first attempt might have gone through.

### Finding out

- **Webhooks** (`transfer.success`, `transfer.failed`, `transfer.reversed`) are only hints. The payout is always re-checked with the provider.
- **A sweep** runs on the maintenance queue every 5 minutes. It re-checks payouts that have been `processing` for over 10 minutes, which covers lost webhooks and provider outages.
- **Admins** can force a re-check: `POST /v1/admin/payouts/:id/sync`.

### Providers

`PaymentProvider` gets an optional `payouts` capability (`createRecipient`, `initiate`, `find`):
- **Mock:** supports every mode, including a "lost response" mode used by the tests.
- **Paystack:** Transfers for NGN, GHS and ZAR. Turn off transfer OTP in the Paystack dashboard for API payouts.
- **Stripe:** not supported. Paying out to arbitrary bank accounts requires Stripe Connect (connected accounts, onboarding, KYC), which is a product decision beyond a starter kit.

The provider is chosen in this order: the one requested, the currency's route, the default, then any enabled provider that can pay out in the currency.

### Permissions

- `payout_destinations:manage` covers saving and removing bank accounts. Owner and admin have it; it can't be given to API keys.
- `payouts:create` covers sending payouts and listing destinations. Owner and admin have it, and it can be given to API keys.

Keeping these separate means a leaked API key can move money only to accounts a human has already approved.

## Consequences

- There are no payout fees, limits or approval workflows yet. They are natural next steps: a fee engine, velocity limits, and a cooling-off period for new destinations.
- Payouts are made in the wallet's currency. Cross-currency payouts would combine this flow with FX (ADR 0009).
- External clearing now carries payout outflows, which reconciliation against provider settlement reports will check.
