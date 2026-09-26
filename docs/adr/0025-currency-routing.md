# ADR 0025: Currency routing, and USD through Stripe only

- **Status:** Accepted
- **Date:** 2026-09-26

## Context

Several providers can charge the same currency: Paystack and Stripe can both charge USD, for example. Which one processes a currency is a business decision. It depends on fees, settlement accounts, card acceptance and compliance, so it shouldn't depend on which provider a client asks for.

FinStack's decision is that **USD is processed through Stripe only**.

## Decision

- **Routes.** `PAYMENT_CURRENCY_ROUTES` (for example `NGN:paystack`) pins currencies to providers. A payment in a routed currency always uses that provider, and asking for another returns `422 PROVIDER_NOT_ALLOWED_FOR_CURRENCY`. Unrouted currencies use the requested or default provider. The app refuses to start with a route to a provider that isn't enabled or can't charge the currency.
- **Policy for USD, enforced in code (`CURRENCY_PROVIDER_POLICY`)** rather than left to configuration:
  - The Paystack adapter doesn't offer USD. Paystack can never charge USD through FinStack, whatever the configuration.
  - When Stripe is enabled, USD is routed to Stripe automatically, with no setting needed.
  - A route sending USD to any other real provider is refused at startup.
  - The mock provider (development only, refused in production) may still charge USD, so local development works without Stripe keys.
  - Without Stripe, USD payments are refused (`422 CURRENCY_NOT_SUPPORTED_BY_PROVIDER`). A USD wallet can still receive converted payments in other currencies, such as NGN through Paystack converted at a locked quote (ADR 0009).
- **Payouts** follow their own capability (ADR 0018). Paystack pays out NGN, GHS and ZAR only.

## Consequences

- Changing a currency's provider is a code change to `CURRENCY_PROVIDER_POLICY` for a business rule, or a configuration change for anything else.
- Reconciliation compares each provider only with the payments routed to it, so policies don't affect it.
