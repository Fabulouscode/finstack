# Ledger entry pagination: index and keyset vs OFFSET

**Query:** wallet history, i.e. the newest entries of one ledger account with the transaction reference and description. It backs `GET /v1/wallets/:id/entries` (`LedgerService.listAccountEntries`).

```sql
SELECT e.id, e.ledger_transaction_id, t.reference, t.description,
       e.direction, e.amount, e.currency, e.created_at
  FROM ledger_entries e
  JOIN ledger_transactions t ON t.id = e.ledger_transaction_id
 WHERE e.ledger_account_id = $1
   AND (e.created_at, e.id) < ($2, $3)   -- keyset cursor (omitted on page 1)
 ORDER BY e.created_at DESC, e.id DESC
 LIMIT 21;                                -- page size + 1 to detect "has more"
```

**Index:** `idx_ledger_entries_account_created_id ON ledger_entries (ledger_account_id, created_at, id)`

## Setup

PostgreSQL 17 in Docker Compose, with 200,000 ledger transactions and 400,000 entries (1 clearing account holding 200,000 entries, and 1,000 customer accounts with 200 each), inserted through the real integrity triggers and then `ANALYZE`d. The measurements are for the busiest account. Absolute timings are inflated by Docker Desktop's virtualised disk on macOS; the ratios are what matter.

## Results

| # | Scenario | Plan | Execution time |
| --- | --- | --- | --- |
| A | First page, with index | Index Scan Backward, 21 rows read | **3.9 ms** |
| B | Page 7,500 (keyset cursor), with index | Index Scan Backward from the cursor, 21 rows read | **4.1 ms** |
| C | Page 7,500 (`OFFSET 150000`), with index | Parallel Seq Scan + Hash Join + external merge sort on disk | 9,038 ms |
| D | First page, **without** index | Parallel Seq Scan of both tables + Hash Join + top-N sort | 4,558 ms |

### A. With index: first page

```
Limit (actual time=0.993..3.266 rows=21 loops=1)
  ->  Nested Loop (actual time=0.971..2.821 rows=21 loops=1)
        ->  Index Scan Backward using idx_ledger_entries_account_created_id on ledger_entries e
              (actual time=0.037..0.259 rows=21 loops=1)
              Index Cond: (ledger_account_id = '00000000-...-000000000001'::uuid)
        ->  Memoize
              ->  Index Scan using pk_ledger_transactions on ledger_transactions t (rows=1 loops=21)
Execution Time: 3.867 ms
```

### D. Without index: first page

```
Limit (actual time=4547.303..4557.443 rows=21 loops=1)
  ->  Gather Merge
        ->  Sort  (Sort Key: e.created_at DESC, e.id DESC; top-N heapsort)
              ->  Parallel Hash Join (Hash Cond: e.ledger_transaction_id = t.id)
                    ->  Parallel Seq Scan on ledger_entries e   (Rows Removed by Filter: 66667 per worker)
                    ->  Parallel Hash
                          ->  Parallel Seq Scan on ledger_transactions t
Execution Time: 4557.806 ms
```

## Why

**The composite index matches both the filter and the sort.** Within one `ledger_account_id`, index entries are already ordered by `(created_at, id)`. PostgreSQL walks the index backwards and stops after 21 rows, so no sort is needed and only 21 transaction rows are fetched by primary key. Cost depends on the page size, not on how many entries the account has.

**Without it**, PostgreSQL must read every entry (filtering out the other accounts), join all 200,000 transactions, and sort to find the newest 21. Cost grows with table size, and gets worse as the ledger grows.

**`OFFSET` defeats the index for deep pages.** To return rows 150,001–150,021, PostgreSQL still has to produce and discard the first 150,000. The planner judged a full scan plus an on-disk sort cheaper than walking 150,000 index entries, which took 9 seconds. The keyset predicate `(created_at, id) < (cursor)` is a row comparison the index can seek to directly, so page 7,500 costs the same as page 1 (B vs A). Keyset pagination is also stable under concurrent inserts: new entries never shift later pages or cause duplicates.

**`id` is in the index and the ORDER BY** to make the order total. All entries of one posting share `created_at` (PostgreSQL's `now()` is the transaction start time), so without a tiebreaker a cursor could skip or repeat rows.

**Millisecond precision.** `created_at` is `timestamptz(3)` on ledger tables. PostgreSQL's default is microseconds, but JavaScript `Date` only holds milliseconds, so a cursor built from a microsecond timestamp would be truncated and could skip entries.

## Other indexing decisions

- `idx_ledger_entries_ledger_transaction_id`: loads the entries of a transaction (replays, reversals) and serves the balance-check trigger's `WHERE ledger_transaction_id = ...`.
- `uq_wallets_user_currency (user_id, currency)`: enforces one wallet per currency, and its leading `user_id` column also serves "list my wallets", so no separate `user_id` index is needed.
- **Not added:** an index on `ledger_entries.currency` or `direction`. Neither is ever used as a filter on its own, and every extra index slows the hot insert path, which already runs three triggers per entry.

## Operational note: bulk loads

The balanced-transaction check is a deferred constraint trigger, so PostgreSQL queues one check per inserted row until `COMMIT`. Inserting several hundred thousand rows in a single transaction queues that many checks. For backfills or imports, commit in batches (5,000 transactions per batch worked well here).
