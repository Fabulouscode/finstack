# ADR 0007: Double-entry ledger and money representation

- **Status:** Accepted
- **Date:** 2026-09-24

## Context

The ledger is FinStack's financial source of truth. Bugs here cost money, so correctness must not depend only on every caller using the service layer correctly. The design must also make concurrent movements against one balance safe.

## Decision

### Money

- Amounts are **integers in minor units** (`bigint` in PostgreSQL and TypeScript), always stored alongside an ISO 4217 currency code from a registry of supported currencies and their exponents (`src/common/money/currency.ts`).
- The API exchanges amounts as JSON integers. Conversion happens in one place (`toApiAmount` / `toMinorUnits`), which throws instead of losing precision beyond 2^53 − 1.
- There is no floating-point arithmetic anywhere on the money path. PostgreSQL `bigint` values come back from `pg` as strings and are mapped straight to `bigint` by a column transformer.

### Model

- `ledger_accounts`: typed accounts (asset, liability, equity, revenue, expense) with a normal balance side and a cached `balance`.
- `ledger_transactions`: one balanced posting, with a unique `reference` for idempotency and optional `reversal_of_id`.
- `ledger_entries`: debit and credit lines, strictly positive amounts.
- **Wallets are views over ledger accounts.** Each wallet owns three liability accounts (available, pending, reserved). A wallet row stores no amounts.

### Enforcement: application and database

| Invariant | Application | Database (backstop) |
| --- | --- | --- |
| Debits = credits, at least 2 entries | `validatePosting()` | Deferred constraint trigger, checked at `COMMIT` |
| No overdraft | Check against **locked** balances | `CHECK (allow_negative_balance OR balance >= 0)` |
| Balance only changes via entries | Balance column is insert/update-disabled in the ORM | Balance applied by an `AFTER INSERT` trigger on entries; direct `UPDATE` rejected |
| History is immutable | No update/delete paths | `BEFORE UPDATE OR DELETE` triggers raise |
| Currency consistency | `CURRENCY_MISMATCH` | `BEFORE INSERT` trigger on entries |
| One posting per reference | Replay or conflict check | Unique index on `reference` |
| One reversal per transaction | Pre-check | Partial unique index on `reversal_of_id` |

Every database guarantee has an integration test that deliberately bypasses the service with raw SQL.

### Concurrency

Postings lock all affected accounts with `SELECT ... FOR UPDATE` **in `id` order**, then check funds against the locked balances. This serialises postings on the same account, without lost updates, and prevents deadlocks between opposing postings (A→B concurrent with B→A). Tests cover two ₦7,000 withdrawals against ₦10,000 (exactly one succeeds) and 20 opposing transfers (no deadlock). Removing the ordered locks makes the deadlock test fail.

Wallet movements additionally take `FOR SHARE` on the wallet rows in the same transaction, so a freeze and a transfer cannot interleave.

### Idempotency

Posting an already-used reference with identical content returns the original transaction (`replayed: true`). Different content returns `409 LEDGER_REFERENCE_CONFLICT`. Concurrent duplicates are resolved by the unique index, and the loser replays.

## Consequences

- A bug in application code cannot silently create money, overdraw an account or rewrite history. It fails loudly at the database.
- The cached balance makes balance reads O(1), and `findBalanceDiscrepancies()` plus `trialBalance()` verify it against the entries.
- Each entry insert runs three triggers. That's acceptable for a transactional workload; bulk imports should commit in batches (see `docs/performance/ledger-entries-pagination.md`).
- Posting to a very hot account (e.g. a single system clearing account) serialises on its row lock. If that ever becomes a bottleneck, the standard remedy is sharding the system account into N sub-accounts.
- Corrections are reversals, never edits. Auditors get a complete history by construction.
