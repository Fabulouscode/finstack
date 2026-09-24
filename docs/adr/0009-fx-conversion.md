# ADR 0009: FinStack converts foreign-currency payments (FX engine)

- **Status:** Accepted
- **Date:** 2026-09-24
- **Supersedes:** decision 3 of [ADR 0008](./0008-single-base-currency-wallet.md) ("the payment provider performs the conversion")

## Context

Wallets hold a single base currency (USD by default, chosen by the operator; see ADR 0008). Customers pay in other currencies, typically NGN through Paystack, which settles merchants in NGN. Relying on the provider to convert would force providers to settle in the wallet currency, which many don't. It would also leave the operator no control over the rate or margin.

## Decision

**FinStack converts payments itself**, at a rate the operator controls.

### Rates

- A pluggable `RateProvider` interface (bound to `FX_RATE_PROVIDER`). The first implementation serves **admin-set rates** (`POST /v1/fx/rates`, admin role). An external feed can implement the same interface.
- Rates are **insert-only history** in `fx_rates`. The newest row per pair wins, and every quote references the exact rate row it used.
- Stored as exact decimals (`numeric(24,10)`), exchanged in the API as **decimal strings**, and computed as **bigints scaled by 10^10**. Floating point never touches rates or amounts.
- Rates older than `FX_RATE_MAX_AGE_SECONDS` are refused (`503 FX_RATE_STALE`), so the platform never quotes on a stale rate.

### Quotes

- A quote locks the rate, the spread and both amounts for `FX_QUOTE_TTL_SECONDS` (default 15 minutes). It's created when a payment starts, so the user sees exactly what they will receive.
- Either amount can be fixed: "pay ₦X" (source) or "receive $Y" (target).
- **Rounding always favours the platform:** the credited amount is rounded **down**, and the charged amount is rounded **up** to the smallest amount that yields at least the requested target. Currency exponents are respected (JPY has 0 decimals).
- **Spread:** `FX_SPREAD_BPS` (default 100 = 1%) is taken from the credited amount and booked as FX revenue.

### Conversion

A quote is executed as **two single-currency ledger transactions in one database transaction**, through per-currency FX position accounts:

```text
NGN leg:  Dr External clearing (NGN)  ₦15,500.00 │ Cr FX position (NGN)    ₦15,500.00
USD leg:  Dr FX position (USD)            $10.00 │ Cr Wallet available         $9.90
                                                  │ Cr FX revenue (USD)         $0.10
```

- The ledger stays strictly single-currency, and each leg balances on its own. The FX position accounts represent the platform's **open FX exposure**: the NGN it holds against the USD it owes customers.
- The quote row is locked `FOR UPDATE`, so a quote is consumed **exactly once**, even under concurrent attempts. Retrying with the same conversion reference returns the original result; another reference gets `409 FX_QUOTE_ALREADY_USED`.
- Expired quotes are rejected (`FX_QUOTE_EXPIRED`). The payments module will re-quote late payments at settlement and flag them for review.

### Operator control of base currencies

`DEFAULT_WALLET_CURRENCY` sets the default and `ALLOWED_WALLET_CURRENCIES` lists what end users may choose. It defaults to just the default currency, i.e. users cannot choose. Anything else returns `422 WALLET_CURRENCY_NOT_ALLOWED`.

## Consequences

- Works with any provider's settlement currency: Paystack NGN settlement credits USD wallets.
- The operator sets the rate and earns the spread, but **carries FX risk** until it sells the currency held in its FX position accounts. Hedging and treasury operations are outside FinStack's scope. The position balances give treasury the numbers it needs.
- Admin-set rates must be kept current. The staleness limit makes a forgotten rate fail closed (no quotes) instead of converting at an outdated price.
- A new `RateProvider` (e.g. a market feed with automatic refresh) can be added without touching quoting, conversion or the ledger.
