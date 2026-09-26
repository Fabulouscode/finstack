# ADR 0021: Outbound webhooks

- **Status:** Accepted
- **Date:** 2026-09-26

## Context

Businesses building on FinStack need to learn about events in their own systems, for example to fulfil an order when `payment.successful` arrives. Polling is wasteful and slow. The industry norm, used by Stripe, Paystack and GitHub, is signed HTTP callbacks to URLs the customer registers.

Outbound calls carry specific risks:
- receivers go down
- events can arrive twice
- forged requests can be sent to the receiver
- a customer-supplied URL can point at our own network (server-side request forgery, SSRF)

## Decision

### Model

- **Endpoints** (`webhook_endpoints`) belong to an organization. Each has:
  - a URL
  - subscribed event types (`*` for all, including future ones)
  - an enabled flag
  - a signing secret
- **Deliveries** (`webhook_deliveries`) are one per endpoint and event. A unique `(endpoint, event)` makes fan-out idempotent even though domain events are delivered at least once. Each delivery stores the exact body, the attempt count, and the last response status or error.

### Flow

1. Domain events leave through the outbox (ADR 0013). `OutboundWebhooksEventHandler` creates deliveries for the enabled endpoints of the event's organization (`data.organizationId`) that subscribe to its type.
2. A dedicated `outbound-webhooks` queue sends them (concurrency 10), with exponential backoff: `OUTBOUND_WEBHOOK_MAX_ATTEMPTS` attempts (default 10), starting at `OUTBOUND_WEBHOOK_BACKOFF_MS` (default 30s, doubling up to about 4 hours).
3. Any 2xx response is success. Redirects are not followed. The timeout is `OUTBOUND_WEBHOOK_TIMEOUT_MS`.
4. A delivery that runs out of attempts is `failed`, and can be redelivered with the same event id. An endpoint whose deliveries fail `OUTBOUND_WEBHOOK_DISABLE_AFTER_FAILURES` times in a row (default 20) is disabled, with the reason recorded. Re-enabling it resets the counter.

### Request

```
POST <url>
Content-Type: application/json
FinStack-Signature: t=1790424269,v1=5f2b…[,v1=…]
FinStack-Event-Id: <event id>
FinStack-Event-Type: payment.successful
FinStack-Delivery-Id: <delivery id>

{"id":"<event id>","type":"payment.successful","createdAt":"…","data":{…}}
```

- The signature is HMAC-SHA256 of `<t>.<raw body>` with the endpoint secret (`whsec_…`). Receivers verify it with a constant-time comparison, reject timestamps older than a few minutes (which blocks replays), and dedupe on the event `id`.
- **Rotation.** A new secret is issued, and the old one keeps signing alongside it for a grace period (up to 7 days). During that period there are two `v1` values, so receivers can switch without dropping events.

### Secrets

The signing secret must be read back to sign, so it can't be hashed like API keys. It is stored **encrypted** with AES-256-GCM (`SecretBox`) under `DATA_ENCRYPTION_KEY`. That key is required in production; development falls back to a public key with a warning. The secret is shown only when it is created or rotated.

### SSRF protection

URLs must be `https` in production, contain no credentials, and resolve only to public addresses. Loopback, private, link-local (including cloud metadata at `169.254.169.254`), unique-local and multicast addresses are refused. The check runs when the URL is saved and **again before each delivery**, because DNS can change. Private URLs are allowed outside production, for local development (`OUTBOUND_WEBHOOK_ALLOW_PRIVATE_URLS`).

### Access

`webhooks:manage` (owner and admin) covers registering, updating, deleting, rotating, test pings (`webhook.test`), and delivery logs and redelivery. Changes are audited.

## Consequences

- Receivers must be idempotent (at-least-once delivery), and events may arrive out of order: they should re-read state when order matters.
- DNS rebinding between the check and the connection is still theoretically possible. Pinning the resolved address per request would close that gap and is a later hardening step.
- User-facing notifications (email) are a separate channel on the same domain events.
