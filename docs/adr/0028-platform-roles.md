# ADR 0028: Platform roles and permissions

- **Status:** Accepted
- **Date:** 2026-09-26

## Context

A single `admin` role gave every operator every power: the support agent answering a ticket could also change fees, and the finance analyst could suspend users. Least privilege, and segregation of duties between people who stop risk and people who move or price money, is expected by auditors and regulators, and it limits the damage from one compromised staff account.

## Decision

- **Platform permissions** (`PlatformPermission`) name each staff capability, for example `users:read`, `users:manage`, `wallets:manage`, `fees:manage`, `refunds:manage` and `roles:manage`. Every admin endpoint declares the one it needs with `@RequirePermission()`, and `RolesGuard` enforces it. This mirrors organization permissions (ADR 0015).
- **Roles are fixed bundles** (`PLATFORM_ROLE_PERMISSIONS`):

| Role | Purpose | Permissions |
| --- | --- | --- |
| `support` | Answer customers | Read-only: overview, users, organizations, wallets, payouts, audit log |
| `risk` | Stop bad actors | Support's + suspend users/organizations, freeze wallets, limits, payouts |
| `finance` | Move and price money | Support's + refunds, early releases, reconciliation, provider webhooks, FX rates, fees, payouts |
| `admin` | Run the platform | Everything, including `roles:manage` |

- **Role changes** (`POST /v1/admin/users/:id/role`, `roles:manage`) require a reason, are audited (from, to, reason), and take effect immediately, because the auth guard reads the account's current role (ADR 0023).
- **No lockout, no escalation:**
  - Nobody can change their own role or suspend themselves.
  - Acting on staff (suspending or reactivating a non-customer) needs `roles:manage`, so a risk analyst can suspend customers but not the admins above them.
  - The last active admin can't be demoted or suspended. Both paths take the same advisory lock and re-count admins, so two admins acting on each other at once can't both succeed. A test fires this race, and it fails without the lock.
- **Denials name the missing permission**: `403 FORBIDDEN`, "This requires the "fees:manage" platform permission".

## Consequences

- Changing what a role can do is a code change (reviewed and versioned), not a database edit. Custom roles per deployment would store bundles in the database. That's deliberately not done yet: fixed roles are easier to reason about and audit.
- Staff are also ordinary users. They can hold wallets and belong to organizations with their normal access.

## Amendment (2026-10-01): reading payments and refunds

`payments:read` and `refunds:read` were added and given to every staff role (through `support`), for the new admin lists (`GET /v1/admin/payments`, `/refunds`, `/payouts`) and for reading a single payment or refund. Before, payments and refunds were visible only with the `manage` permissions that finance holds. Support staff, who answer customers' "where is my money?", couldn't see them. Making a refund still needs `refunds:manage`.

