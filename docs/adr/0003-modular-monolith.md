# ADR 0003: Modular monolith

- **Status:** Accepted
- **Date:** 2026-09-24

## Context

FinStack covers many domains: auth, wallets, ledger, payments, webhooks, reconciliation and more. They could ship as separate services from day one, or as one deployable with internal boundaries.

Financial operations need strong consistency. Posting a payment updates the transaction, the ledger entries, the wallet balance and the outbox in a single atomic step. Across services this requires distributed transactions or sagas, which add failure modes (partial commits, compensations, message ordering) before the product has any users.

## Decision

Build FinStack as a **single NestJS application organised as a modular monolith**:

- One Nest module per domain (`wallets/`, `ledger/`, `payments/`, ...), each owning its entities, services and controllers.
- Modules interact only through exported services, never by reaching into another module's repositories or tables. In practice:
  - **Data access.** Each service uses TypeORM's built-in repository for its own entities (`@InjectRepository`), or the `EntityManager` of a database transaction. There are no separate repository classes: the service *is* the module's data-access boundary, and money flows need an explicit transaction handle that a repository layer would only pass through.
  - **Reading, locking and writing another module's rows** goes through that module's service, for example `TransactionsService.lockWithin(manager, id)`, `PaymentsService.getById(id)` or `WalletsService.getWallet(id)`. Methods ending in `Within(manager, …)` take part in the caller's database transaction.
  - **Filtering by another module's state** in a query uses a condition that module provides, such as `TransactionsService.statusIn(column, statuses)`. Its table stays its own business.
  - **Types and enums** of other modules' entities (for example `UserRole`, or the `User` a service returns) may be imported freely.
  - **Cleanup:** each module deletes its own expired rows. Maintenance only decides when, and how long to keep them.
- One PostgreSQL database. Cross-module financial operations use a single database transaction.
- Asynchronous work (notifications, webhook retries, reconciliation) goes through BullMQ workers inside the same codebase.

## Consequences

- Money-moving operations stay ACID without distributed coordination.
- One deployable, one database and one test suite keep local development and CI simple.
- Clear module boundaries keep extraction possible later: a module with a narrow exported API and its own tables can become a service when scale or team structure demands it.
- Boundaries are enforced by convention and review, not by the network, so discipline is required. The shared database is the main coupling point to watch.
