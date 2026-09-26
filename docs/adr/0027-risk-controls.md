# ADR 0027: Risk controls: velocity limits and payout cooling-off

- **Status:** Accepted
- **Date:** 2026-09-26

## Context

Two risks dominate a wallet product's losses:
- **Fast outflows from a compromised account.** An attacker who takes over an account moves as much as possible, as fast as possible, usually to a bank account they have just added.
- **Unbounded exposure while trust is being established** (new users, unverified merchants), which regulators also require limits on.

Both are matters of policy. They differ per business, per customer tier and over time.

## Decision

### Velocity limits

- **Limit rules** (`limit_rules`), like fee rules (ADR 0026):
  - per operation (`payment`, `payout`, `transfer`) and currency
  - either the platform default or an organization's own
  - never edited: a new rule supersedes the old one, audited with what it replaced
  
  A rule has optional caps: **per transaction**, **per rolling 24 hours** (amount and count) and **per rolling 30 days**. An empty cap means unlimited.
- **Usage** counts the owner's transactions of that type and currency in the window, excluding failed, cancelled and expired ones. In-flight payments and payouts count, so they can't be used to go over the limit. The transactions module computes it (ADR 0003).
- **Enforced inside the database transaction** that creates the payment, payout or transfer, after a per-owner, per-operation advisory lock (`pg_advisory_xact_lock`). Concurrent requests queue, and each sees the others' committed usage, so they can't exceed a limit *together*. A test fires six parallel transfers at a limit that allows three, and it fails if the lock is removed.
- **Errors say what happened:** `LIMIT_EXCEEDED` with the limit and what's left, for example "(USD 10.00 left)".
- **Visibility:** users (`GET /v1/limits`) and organizations (`GET /v1/organizations/:id/limits`) see their limits, what they've used and what remains.

### Cooling-off for new payout accounts

- `PAYOUT_DESTINATION_COOLDOWN_MINUTES` (default 0, recommended 1440 in production). A newly added bank account can't receive payouts until the period ends. The unlock time is stored on the account (`payouts_available_at`) when it's added, so config changes don't unlock or lock existing accounts.
- **The owner is told at once:** a `payout_destination.added` event emails the user, or the organization's owners and admins. They can remove an account they didn't add, and change their password, before any money can reach it.

## Consequences

- Payment limits are checked when the payment starts. A payment already paid is always credited, because money received can't be refused after the fact.
- Tiers ("verified users get higher limits") map to organization rules today. Per-user tiers would add a `user_id` scope or a tier reference to rules.
- The advisory lock serialises one owner's operations of one kind while a limit applies. That's negligible for people, but a very high-volume merchant with daily limits would queue. Such merchants usually get an organization rule without daily caps.
