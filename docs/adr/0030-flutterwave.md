# ADR 0030: Flutterwave provider

- **Status:** Accepted
- **Date:** 2026-10-01

## Context

Flutterwave is widely used across Africa, and many businesses already have a Flutterwave contract instead of, or as well as, Paystack. A third provider also tests the provider abstraction (ADR 0012): it should fit without changing payment, refund, payout or reconciliation logic.

Flutterwave differs from Paystack and Stripe in three ways that matter for money:
1. **Amounts are in major units.** Flutterwave takes and returns `1500.50` NGN, where FinStack, Paystack and Stripe use `150050` kobo.
2. **Webhooks carry a shared secret, not a signature.** The dashboard's "secret hash" is sent verbatim in the `verif-hash` header. There is no HMAC over the body.
3. **Refunds and transfers are keyed by Flutterwave's numeric ids**, and refund webhooks carry neither an event name nor any of our references.

## Decision

**One adapter, `FlutterwaveProvider`, behind the existing `PaymentProvider` interface.** No payment, refund, payout or reconciliation code changed.

### Amounts

Every amount crosses the boundary through `common/money/major-units.ts`:
- **Outgoing:** minor units are formatted as an exact decimal string using the currency's exponent (`CURRENCIES`), then sent as a JSON number. Amounts too large to survive as a double are refused.
- **Incoming:** the provider's number or string is parsed as a decimal, never multiplied as a float. A value with more decimals than the currency allows (beyond trailing zeros) is **refused, not rounded**.

The verified amount is Flutterwave's `amount` (what was asked for), not `charged_amount`, which can include fees passed on to the customer. A one-kobo difference fails the payment with `AMOUNT_MISMATCH`, as with every provider.

### Payments

- Hosted checkout (Flutterwave Standard): `POST /payments` with our transaction reference as `tx_ref`.
- The provider reference **is** our reference. Payments are verified with `GET /transactions/verify_by_reference?tx_ref=`, and the returned `tx_ref` must match.
- `redirect_url` is the payment's `callbackUrl`, or else `FLUTTERWAVE_REDIRECT_URL`.

### Webhooks

- `verif-hash` is compared with `FLUTTERWAVE_WEBHOOK_SECRET_HASH` in constant time. Both values are hashed to fixed-length SHA-256 digests first, so neither the secret nor its length leaks through timing.
- `charge.completed` becomes a payment event and `transfer.completed` a payout event. As always, the payload only says **which** record to check. FinStack asks Flutterwave for the real state before moving money.
- Event ids combine the event, Flutterwave's id and the status, because a transaction can be reported again when its status changes.
- **Refund webhooks are stored but not acted on** (`unhandled_event_type`). They have no event name and reference only Flutterwave's ids. Refunds are confirmed by asking Flutterwave instead: at creation, and through the admin retry endpoint.

### Refunds

`POST /transactions/{id}/refund` needs Flutterwave's numeric id, so the transaction is looked up by our reference first. `completed` and its channel variants (`completed-mpgs`, …) mean Flutterwave has accepted and committed the refund, which FinStack records as successful. `processing` and `pending-*` are not final.

### Payouts

- **Nigerian bank accounts (NGN) only.** Other payout currencies need extra, country-specific fields.
- Accounts are resolved (`POST /accounts/resolve`), so the stored name is the bank's. They are then saved as Flutterwave **beneficiaries**, the equivalent of Paystack recipients. FinStack stores the beneficiary id and the last four digits, never the full account number.
- Transfers use our payout reference as the transfer `reference`.
- **Never sent twice:** before any resend, `GET /transfers?reference=` asks whether Flutterwave already has the transfer, and the result is matched exactly by reference rather than trusting the filter.

### Routing

Flutterwave is **never suggested** over Paystack and Stripe (`PROVIDER_PREFERENCES` is unchanged). It is used when the operator routes a currency to it, the client asks for it, or it is the default, which keeps business choices in configuration (ADR 0025).

### Reconciliation

Transactions and transfers are listed by day. Flutterwave filters whole days in its own timezone, so a day either side is fetched and the exact half-open range is applied in FinStack. Records in currencies FinStack doesn't support are skipped, since FinStack cannot have created them.

## Consequences

- Flutterwave is a configuration choice: `PAYMENT_PROVIDERS=flutterwave` plus three settings. Test keys are refused in production and live keys outside it, as for the other providers.
- The adapter is built from Flutterwave's documentation and tested against a local fake of its API (`test/utils/fake-flutterwave.ts`).
- **Tested against a real Flutterwave test account (2026-10-01):**
  - A ₦2,500.50 card payment was credited as exactly `250050` kobo. Flutterwave reports the amount as the float `2500.5`, and the conversion was exact.
  - Reconciliation against Flutterwave's transaction list found no issues.
  - Account resolution and beneficiaries worked. **Saving the same account twice is refused** ("Beneficiary already added to your account"), so a customer who removed a bank account could not add it back. Fixed: the existing beneficiary is found and reused.
  - **Initialising the same `tx_ref` again returns a new checkout link**, not an error. This is safe: after a timeout, FinStack hands out only the link from its successful retry.
  - The transfer `reference` filter returned exactly the transfer. A transfer that failed at Flutterwave ("Insufficient funds in customer balance") was marked failed with that reason, and the hold was returned.
  - **Bank codes differ between providers** (OPay is `100004` on Flutterwave and `999992` on Paystack). A payout destination's `bankCode` must come from the chosen provider's bank list.
- **Not yet confirmed:**
  - Refunds. Flutterwave's test environment answered every refund with "Some error occured" (or a 502), and nothing was refunded. FinStack failed the refunds cleanly and returned the funds. Whether the refund `amount` is in major units, as everywhere else in the API, still needs a successful refund.
  - Webhooks. None were delivered during the test; the dashboard's webhook settings need checking.
- **Known gap, shared with Paystack:** neither API takes an idempotency key for refunds. If a refund request times out, FinStack cannot tell whether it was received, and a later retry sends it again. Stripe is protected by its `Idempotency-Key` header. Closing this needs a lookup of existing refunds before a retry. It is tracked separately and applies to both adapters.
