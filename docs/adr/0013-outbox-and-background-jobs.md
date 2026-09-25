# ADR 0013: Transactional outbox and background jobs

- **Status:** Accepted
- **Date:** 2026-09-24

## Context

Some work must happen *because* something was committed: settle a stored webhook, tell other parts of the system (and later, customers) that a payment succeeded. Doing that work inside the request is slow and fragile. Publishing to a queue directly from the request creates the classic dual-write problem:

- commit, then publish → the process can crash between the two: the payment is saved but the event is lost;
- publish, then commit → the commit can fail: the event describes something that never happened.

## Decision

### Transactional outbox

`OutboxService.add(manager, event)` writes an `outbox_events` row **inside the same database transaction** as the state change. The event exists if and only if the change committed.

`OutboxRelay` moves committed events to BullMQ:

- It claims a batch with `SELECT ... FOR UPDATE SKIP LOCKED`, so any number of app instances can relay at once without double-publishing concurrently. An integration test runs four relays against one outbox.
- It polls every `OUTBOX_POLL_INTERVAL_MS`, and is also *nudged* right after a commit for low latency.
- If publishing fails (e.g. Redis is down), the event stays `pending` with exponential backoff (`available_at`).
- The BullMQ job id is the outbox event id, so a re-published event is deduplicated while the job is retained.
- **Delivery is at-least-once.** Consumers are idempotent and key on `eventId`.

Events emitted today: `payment.successful`, `payment.failed`, `transfer.completed`, and the internal command `webhook.received`.

### Queues (BullMQ on Redis)

| Queue | Work | Retry policy |
| --- | --- | --- |
| `webhooks` | Settle stored provider webhooks | `WEBHOOK_MAX_ATTEMPTS` (8) with exponential backoff from `WEBHOOK_RETRY_BACKOFF_MS` (2 s) |
| `domain-events` | Fan events out to `DomainEventHandler`s (logging today; notifications and merchant webhooks later) | 5 attempts, exponential |
| `maintenance` | Hourly cleanup via a BullMQ job scheduler (runs once per interval across all instances) | Next run |

**Webhooks go through the outbox too.** The stored webhook event and its `webhook.received` command commit together, so a verified webhook is never lost, even if Redis is down when it arrives.

**Dead letters.** When a webhook's retries are exhausted, its `webhook_events` row stays `failed` with `attempts` and `last_error`. Admins list these (`GET /v1/admin/webhook-events?status=failed`) and replay them (`POST /v1/admin/webhook-events/:id/replay`). Settlement is idempotent, so a replay can never double-credit.

**Observability.** `/health/ready` checks Redis alongside PostgreSQL, and `GET /v1/admin/queues` reports waiting, active, delayed, failed and completed counts per queue.

**Deployment.** `WORKERS_ENABLED` controls whether an instance runs the relay and workers, so an operator can split API and worker processes. Processors are registered with `autorun: false` and started only when enabled.

### Housekeeping

The `maintenance` job deletes expired idempotency keys, refresh tokens expired or revoked more than 30 days ago, and published outbox events older than 7 days.

### Synchronous vs asynchronous (updated)

| Operation | Mode | Why |
| --- | --- | --- |
| Transfers, ledger postings, wallet changes | Sync, one DB transaction | The caller needs the result, and money must move atomically |
| Payment initialisation, verify endpoint | Sync | The client is waiting for a checkout URL or the result |
| Webhook signature check, storage, dedupe | Sync | Must reject forgeries and acknowledge the provider quickly |
| Webhook settlement | **Async** (`webhooks` queue) | Independent of the provider's HTTP timeout; our own retries and backoff; replayable |
| Reacting to events (logs, notifications) | **Async** (`domain-events` queue) | Must never slow down or fail a money movement |
| Cleanup | **Async**, scheduled | Nobody is waiting for it |

## Consequences

- No dual-write inconsistencies: events and state commit together.
- Webhook settlement has a delay (poll interval plus queue latency, typically well under a second locally). Clients that need an immediate answer call `POST /v1/payments/:id/verify`.
- Redis becomes a dependency for background work, but not for accepting money-moving requests: requests commit to PostgreSQL, and the outbox drains once Redis is back.
- The relay publishes while holding row locks on outbox rows only (never on financial rows), keeping its transaction short.
