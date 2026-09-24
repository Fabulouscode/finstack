# ADR 0004: PostgreSQL and TypeORM

- **Status:** Accepted
- **Date:** 2026-09-24

## Context

The ledger is FinStack's source of truth. The data store must provide:

- ACID transactions across multiple tables.
- Row-level locking (`SELECT ... FOR UPDATE`) to serialise concurrent balance changes.
- Constraints enforced by the database (unique idempotency keys, foreign keys, `CHECK` constraints on amounts), not only by application code.
- Exact integer arithmetic for money (`bigint` minor units).
- Mature tooling for query plans (`EXPLAIN ANALYZE`) and indexing.

## Decision

- **PostgreSQL 17** is the only database.
- **TypeORM** is the ORM, per the project brief. We use it deliberately:
  - `synchronize` is always off. Every schema change is a reviewed migration.
  - One options builder (`src/database/typeorm-options.ts`) is shared by the app and the migration CLI.
  - A snake_case naming strategy keeps the schema idiomatic for raw SQL.
  - We drop to the query builder or raw SQL wherever correctness depends on exact semantics: pessimistic locks, `INSERT ... ON CONFLICT`, constraint-based idempotency.
- Integration tests run against a real PostgreSQL (`finstack_test`), never an in-memory substitute. Locking and constraint behaviour cannot be faked.

## Consequences

- Financial invariants are backed by the database, so bugs in application code fail loudly instead of corrupting balances.
- TypeORM lowers boilerplate for CRUD-style modules while still allowing precise SQL where it matters.
- TypeORM's `bigint` columns map to `string` in JavaScript, so money needs an explicit transformer to and from `bigint`. This is addressed when the first monetary column is introduced.
- Contributors need Docker (or a local PostgreSQL) to run integration and e2e tests.
