# ADR 0016: Organizations own money (wallets, payments, transactions)

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

ADR 0015 added organizations, roles and API keys, but money could still only belong to users. A B2B product built on FinStack, such as a merchant collecting payments, needs the balance to belong to the business, with members and servers acting on it according to their permissions.

## Decision

### One owner concept

- A record is owned by **a user or an organization**. The code models this as `Owner = { kind: 'user' | 'organization', id }` (`src/common/owner`). A bare string still means a user id, so user-centric code reads the same as before.
- `wallets`, `transactions`, `payments` and `idempotency_keys` have both `user_id` and `organization_id`, with **`CHECK (num_nonnulls(user_id, organization_id) = 1)`**, so exactly one owner is always set, enforced by the database.
- Uniqueness rules are **per owner**: one partial unique index for each owner column (for example `uq_wallets_user_currency` and `uq_wallets_org_currency`). Organization wallets follow the same rules as user wallets: `WALLETS_PER_OWNER`, `ALLOWED_WALLET_CURRENCIES`, exactly one primary wallet, and the crediting rule with FX conversion.
- Organization rows use `ON DELETE RESTRICT`, as users do, so the money trail can't disappear. The exception is idempotency keys, which are disposable and use `CASCADE`.

We considered two alternatives:
- **A separate "owners" table.** It adds a join everywhere and loses the direct foreign keys.
- **A polymorphic `owner_type` and `owner_id`.** It gives no foreign key, so the database can't guarantee the owner exists.

Two nullable foreign keys plus a CHECK keep both referential integrity and the invariant, at the cost of one extra column per table.

### API

| Endpoint | Permission |
| --- | --- |
| `POST /v1/organizations/:id/wallets` · `POST …/wallets/:walletId/primary` | `wallets:manage` |
| `GET /v1/organizations/:id/wallets[/:walletId[/entries]]` | `wallets:read` |
| `POST /v1/organizations/:id/payments` (Idempotency-Key) · `POST …/payments/:paymentId/verify` | `payments:create` |
| `GET /v1/organizations/:id/payments/:paymentId` · `GET …/transactions[/:transactionId]` | `transactions:read` |

- All of these accept **API keys** with the matching scope, and follow ADR 0015's access rules: non-members and other organizations' keys get `404`, and suspended organizations are read-only.
- **Organization payments are collections.** The payer is a customer, not a member, so `customerEmail` is required and is passed to the provider's checkout. It is stored on the payment (`payments.customer_email`). For user top-ups it is the user's own email.
- **Idempotency keys on organization routes are scoped to the organization.** Its members and API keys share one key space, so a retry from a server after a dashboard attempt, or the reverse, replays the original instead of charging twice. A member's personal routes keep their own key space.
- Refunds of organization payments (admin-only, ADR 0014) debit the organization's wallet, and the refund transaction belongs to the organization. Outbox events include `organizationId` next to `userId`.

### Out of scope for now

- FX quotes stay user-scoped. Conversions between an organization's own wallets are not exposed yet.
- Organization transfers and payouts are future work (Phase 3).

## Consequences

- Owner-agnostic services (`WalletsService`, `PaymentsService`, `TransactionsService.findByIdempotencyKey`) serve both products, with one implementation of the money rules.
- Code that reads `userId` from these rows must handle `null`, because the row may be organization-owned.
- The migration backfills `customer_email` from users for existing payments. Reverting it requires deleting organization-owned rows first.
