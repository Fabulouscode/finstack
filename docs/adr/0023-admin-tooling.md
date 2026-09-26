# ADR 0023: Admin tooling

- **Status:** Accepted
- **Date:** 2026-09-26

## Context

Operators must be able to act on risk and support cases:
- find a user or business
- see their money
- stop a compromised account
- freeze a wallet under investigation
- see at a glance what needs attention

Until now these were service methods with no API, or required SQL. Direct SQL bypasses the rules and leaves no audit trail.

## Decision

- **An `admin` module** (platform `admin` role only) with users, organizations, wallets and an overview. It is a leaf module: it only calls other modules' services (ADR 0003), so admin actions obey the same rules as the rest of the API.
- **Actions**, each audited with a required `reason` in the same database transaction:

| Action | Effect |
| --- | --- |
| Suspend user | Every request refused at once (`ACCOUNT_SUSPENDED`), all sessions revoked; can't suspend yourself |
| Suspend organization | Read-only for members, API keys stop working |
| Freeze wallet | No money can leave it; held funds can still be released; closed wallets can't change |

  Each has a reverse (reactivate, unfreeze). No-op changes return `409`, so a double click isn't mistaken for a second action.
- **Immediate effect.** The auth guard now loads the account on each request (a single primary-key lookup). A suspended user's still-valid access token stops working at once, and a removed admin role is enforced at once. This supersedes the deferral in ADR 0006.
- **Search and detail.** Users by email fragment and status; organizations by name and status; keyset pagination; LIKE wildcards in the input are escaped. Detail views show a user's wallets and organizations, an organization's members and wallets, and a wallet's owner.
- **Overview** (`GET /v1/admin/overview`). It shows:
  - users and organizations by status
  - what is owed to wallet holders per currency (available, pending, reserved)
  - what needs attention: payouts and refunds still processing (with the oldest), open reconciliation items, failed provider webhooks, failed outbound deliveries in the last 24 hours, and disabled webhook endpoints
  
  Each figure comes from the module that owns it. Wallet totals are summed by the ledger over account ids that the wallets module selects.

## Consequences

- One extra indexed query per authenticated request. If that ever matters, a short-lived cache (seconds) keeps most of the benefit.
- Finer-grained admin roles (support vs. risk vs. finance) aren't modelled yet: `admin` can do everything. Splitting it is the natural next step when teams grow.
- Admin actions change state only. Correcting money (manual ledger adjustments) remains a deliberate, separate capability.
