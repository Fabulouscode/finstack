# ADR 0010: Flexible wallet model (single or multiple wallets per owner)

- **Status:** Accepted
- **Date:** 2026-09-24
- **Supersedes:** [ADR 0008](./0008-single-base-currency-wallet.md) (one wallet per user, hard-wired)

## Context

ADR 0008 fixed the product model to one base-currency wallet per user. FinStack is a starter kit used by very different products:

- **Merchant and savings products** often want one balance in a stable currency, with incoming foreign payments converted into it.
- **Remittance and multi-currency account products** (the Wise, Grey or Chipper model) want a balance per currency, with conversion as an explicit user action.
- **Single-market products** may want local-currency wallets and no conversion at all.

Hard-wiring one of these would force adopters to rework the core.

## Decision

1. **Uniqueness:** at most one wallet per owner and currency (`uq_wallets_user_currency`).
2. **Primary wallet:** each owner has at most one primary wallet (`is_primary` with a partial unique index, `uq_wallets_user_primary`). The first wallet is primary; the owner can switch it (`POST /v1/wallets/:id/primary`).
3. **Operator setting `WALLETS_PER_OWNER`:**
   - `single` (default): one wallet per owner. Every wallet is created primary, so the partial unique index alone guarantees one wallet per owner, even under concurrent requests in different currencies.
   - `multiple`: one wallet per currency in `ALLOWED_WALLET_CURRENCIES`. When the first wallets are created concurrently, exactly one wins the primary slot; the others are created non-primary.
4. **One crediting rule for incoming money** (`resolveCreditTarget`): credit the owner's wallet in the settlement currency if one exists; otherwise credit the **primary** wallet after an FX conversion (ADR 0009). Both modes use the same rule and the same code path.
5. **User-initiated conversion** between one's own wallets (`convertBetweenWallets`) uses the same FX quotes and two-leg postings as payments.

**Deferred: organization ownership.** Wallets currently belong to users. The organizations module will add a nullable `organization_id` next to `user_id`, with a `CHECK (num_nonnulls(user_id, organization_id) = 1)` and equivalent unique indexes, rather than a polymorphic owner reference the database can't enforce.

## Consequences

| Product | Configuration |
| --- | --- |
| One USD balance, foreign payments converted | `WALLETS_PER_OWNER=single`, `DEFAULT_WALLET_CURRENCY=USD` (the defaults) |
| NGN-only, no FX | `single`, `DEFAULT_WALLET_CURRENCY=NGN`; configure no FX rates, so conversions fail closed |
| Multi-currency accounts | `multiple`, `ALLOWED_WALLET_CURRENCIES=USD,NGN,GBP` |

- All invariants are enforced by unique indexes, not only by application checks, and concurrency tests cover both modes.
- Switching an existing deployment from `multiple` back to `single` is an operational decision: users may already hold several wallets. The setting only affects new wallets.
