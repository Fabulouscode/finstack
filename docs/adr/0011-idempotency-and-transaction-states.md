# ADR 0011: Idempotency and transaction states

- **Status:** Accepted
- **Date:** 2026-09-24

## Context

Clients retry: networks drop responses, users double-click, mobile apps resend on reconnect. For a money-moving API, a retry that executes twice is a double payment. The API must also expose the business lifecycle of each money movement (a transfer, later payments and refunds) with states that can't be corrupted by bugs or races.

## Decision

### Idempotency in two layers

**HTTP layer (`@Idempotent()`).** Money-moving endpoints require an `Idempotency-Key` header. Keys are scoped per user and stored in `idempotency_keys` with a SHA-256 fingerprint of method, path and canonical JSON body (key order doesn't matter).

| Situation | Response |
| --- | --- |
| First request | Executes; the response is stored |
| Retry, same key and body, completed | Stored response replayed with `Idempotent-Replayed: true` |
| Same key, different body | `422 IDEMPOTENCY_KEY_REUSED` |
| Same key while the first is still running | `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` |
| The first request failed | Key released, so a retry executes again. Safe, because failures roll back their database transaction. |
| In-progress key silent for `IDEMPOTENCY_LOCK_TIMEOUT_SECONDS` | A retry may take it over (the server probably crashed) |

The claim is an `INSERT ... ON CONFLICT DO NOTHING` on a unique `(user_id, key)` index, so of concurrent requests exactly one executes. Keys expire after `IDEMPOTENCY_KEY_TTL_HOURS`.

**Domain layer.** The HTTP layer alone has a gap: the money moves and commits, then the server crashes before the response is stored. The retry takes over the stale key and would execute again. So the domain record carries the key as well (`transactions.idempotency_key`, unique per user), and the ledger posting reference is derived from the transaction. A re-execution finds the existing transaction and returns it; racing re-executions are resolved by the unique index. The ledger's own reference uniqueness is a third backstop.

### Transactions and their states

`transactions` is the business view of a money movement: type, parties, wallets, amount, provider reference, and the ledger transaction that proves it.

```text
pending ──► processing ──► successful ──► reversed
   │             │
   │             └──► failed
   ├──► successful / failed
   └──► cancelled / expired
```

- The allowed transitions are defined once in code (`TRANSACTION_TRANSITIONS`) and **enforced again by a database trigger**. An integration test tries all 42 ordered pairs against both, so they can't drift apart.
- Transitions happen under a row lock (`SELECT ... FOR UPDATE`).
- `CHECK`: a successful or reversed transaction must reference its ledger transaction.

### Transfers

`POST /v1/transfers` is synchronous: creating the transaction, posting to the ledger and marking it successful commit in **one** database transaction. A failed transfer (insufficient funds, frozen wallet) leaves no record and moves nothing. Asynchronous flows (payments) will use `pending`/`processing` while waiting for providers.

## Consequences

- Clients can retry any money-moving call safely. They must generate a fresh key per logical operation (e.g. a UUID) and reuse it for retries.
- Failed attempts are not recorded as transactions. Audit logging of failed attempts arrives with the audit module.
- The stored response is replayed verbatim, even if the transaction's status changes later. Clients should fetch `GET /v1/transactions/:id` for the current state.
- Expired idempotency keys accumulate until the background-jobs module adds a cleanup job (`idx_idempotency_keys_expires_at` is in place for it).
