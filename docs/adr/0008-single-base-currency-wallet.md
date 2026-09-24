# ADR 0008: One base-currency wallet per user; providers convert foreign payments

- **Status:** Accepted, decision 3 superseded by [ADR 0009](./0009-fx-conversion.md) (FinStack converts)
- **Date:** 2026-09-24
- **Amends:** the wallet model in [ADR 0007](./0007-ledger-and-money.md) (one wallet per user and currency)

## Context

Customers may pay in many currencies, but most products built on FinStack (merchant accounts, remittance, marketplaces) want each user to hold a single balance in a stable base currency rather than a wallet per currency. The initial implementation allowed one wallet per user **and currency**.

Holding one balance while accepting several payment currencies requires a currency conversion somewhere. Conversion brings exchange-rate sourcing, rate locking between checkout and settlement, rounding between currencies with different exponents, and FX risk.

## Decision

1. **Each user has exactly one wallet**, enforced by a unique index on `wallets.user_id`.
2. **The base currency is chosen at creation and never changes.** It defaults to `DEFAULT_WALLET_CURRENCY` (**USD**), and a user may pick another supported currency when opening the wallet.
3. **The payment provider performs the conversion.** For a foreign-currency payment, the provider charges the customer in the *presentment* currency and settles to us in the *settlement* currency. Payments will record both amounts, and the ledger credits the **settled amount** to the wallet. FinStack takes no rate source and no FX risk.
4. **The ledger is unchanged.** Every ledger transaction stays single-currency.

## Consequences

- Simpler product model and API: `POST /v1/wallets` (optional `currency`) and `GET /v1/wallets/me`.
- **The provider's settlement currency must match the wallet's base currency.** A Stripe USD account settles USD directly. Paystack settles most Nigerian merchants in NGN (USD settlement must be enabled on the account). Until an FX module exists, a payment whose settlement currency differs from the wallet currency is rejected with `CURRENCY_MISMATCH`, never converted implicitly.
- Wallet-to-wallet transfers require both wallets to share a base currency.
- **Future FX module:** if FinStack must convert itself (e.g. NGN settlement into USD wallets), it will post two single-currency legs atomically through per-currency FX position accounts, with a locked quote (rate, expiry, rounding rule) recorded in an `fx_conversions` table. The ledger already supports this without schema changes.
- Projects that need several wallets per user can drop the `uq_wallets_user_id` index in favour of `(user_id, currency)`. Nothing else in the ledger depends on it.
