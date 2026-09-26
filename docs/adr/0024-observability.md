# ADR 0024: Observability

- **Status:** Accepted
- **Date:** 2026-09-26

## Context

Running a payment system means answering questions quickly:
- Is it up?
- Is it slow, and where?
- Are payments succeeding?
- Is anything backing up?
- What happened to *this* request?

Without that, problems are found by customers.

## Decision

### Logs

- A single application logger (`AppLogger`) with two formats:
  - **`json`** (the production default): one object per line with `time`, `level`, `context`, `message`, and, within a request, `requestId`, `traceId` and `actor` (`user:<id>` or `api_key:<id>`). Error stacks are kept.
  - **`pretty`** (the development default): Nest's console output.
  - `LOG_LEVEL` is one of `debug`, `info`, `warn` or `error`.
- One **access-log line** per request: method, route template, status and duration. Health probes and metrics scrapes are skipped. 5xx responses are logged at `error`.
- Startup logs are buffered until the logger is ready, so every line has the same format.

### Metrics (Prometheus)

`GET /metrics` is unversioned and unthrottled. It exposes:

| Metric | Labels |
| --- | --- |
| `finstack_http_requests_total`, `finstack_http_request_duration_seconds` | method, **route template** (`/v1/payments/:paymentId`), status |
| `finstack_domain_events_total` | type: payment, refund, payout and transfer outcomes, … |
| `finstack_provider_webhooks_total` | provider, resulting status |
| `finstack_webhook_delivery_attempts_total` | outcome (succeeded, retry, failed, skipped) |
| `finstack_queue_jobs` | queue, state (read at scrape time) |
| `finstack_outbox_pending_events` | the outbox backlog (read at scrape time) |
| `finstack_process_*`, `finstack_nodejs_*` | Node.js process defaults |

- Labels only take bounded values, never ids or amounts, so the number of time series stays small.
- Each app instance has its **own registry**, so several instances can run in one process (tests).
- **Protected by default.** `METRICS_TOKEN` requires `Authorization: Bearer <token>`. In production, `/metrics` stays off until a token is set, because unprotected metrics reveal traffic and business volumes. `METRICS_ENABLED=false` turns it off everywhere.

### Tracing hooks

- A valid W3C `traceparent` header is honoured: its trace id is used in every log line of the request. Otherwise a new one is started. That joins FinStack's logs to the caller's traces.
- Full distributed tracing needs no code changes: run with OpenTelemetry's auto-instrumentation (see the README). It traces HTTP, PostgreSQL, Redis and BullMQ.

## Consequences

- Domain-event counts are counts of *processed* events. A retried job counts again. They're meant for rates and alerts, not accounting (the ledger and reconciliation do that).
- Alert rules and dashboards depend on the deployment, and aren't shipped yet. The README suggests starting points.
