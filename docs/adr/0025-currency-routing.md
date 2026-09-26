# ADR 0025: Currency routing

- **Status:** Accepted (amended 2026-09-26)
- **Date:** 2026-09-26

## Context

Several providers can charge the same currency: Paystack and Stripe can both charge USD and NGN, for example. Which one should process a payment depends on each business's fees, contracts, settlement accounts and card acceptance. Most integrators never pass a `provider`, so FinStack's automatic choice *is* the product for them.

The first version enforced a single business's rule in code: USD through Stripe only. That was wrong for a starter kit. Other businesses use other providers (Flutterwave, their bank's gateway) or have better contracts elsewhere.

## Decision

**FinStack suggests; businesses decide.** A payment's provider is chosen in this order:

1. **Operator route** (`PAYMENT_CURRENCY_ROUTES`, e.g. `USD:paystack`). This is a rule: the currency always uses that provider, and a client asking for another gets `422 PROVIDER_NOT_ALLOWED_FOR_CURRENCY`. Any currency can be routed to any enabled provider that can charge it. The app refuses to start otherwise.
2. **Client's choice:** the `provider` field sent by the business's backend (never the end customer).
3. **FinStack's suggestion** (`PROVIDER_PREFERENCES`): local African currencies (NGN, GHS, KES, ZAR) → Paystack; international ones (USD, EUR, GBP, JPY) → Stripe. It applies only when that provider is enabled and can charge the currency.
4. **The default provider** (`DEFAULT_PAYMENT_PROVIDER`).

The chosen provider must be able to charge the currency, or the request fails (`422 CURRENCY_NOT_SUPPORTED_BY_PROVIDER`) before anything is created.

Examples:
- **Paystack and Stripe enabled, no routes:** NGN → Paystack, EUR → Stripe, USD → Stripe.
- **Stripe only:** NGN → Stripe.
- **Paystack only:** USD → Paystack; EUR is refused.
- **`PAYMENT_CURRENCY_ROUTES=USD:paystack`:** USD always goes through Paystack.

Payouts follow their own capability (ADR 0018), trying the route, then the suggestion, then the default, then any capable provider.

## Consequences

- A business that needs a currency on one provider only (as the original USD-through-Stripe requirement did) sets `PAYMENT_CURRENCY_ROUTES`, for example `USD:stripe`. That's configuration, not code.
- Currency isn't the customer's location. A foreign card paying an NGN invoice goes to Paystack by default. Businesses that care can route differently.
- Adding a provider to the suggestions is a one-line change to `PROVIDER_PREFERENCES`.
