# ADR 0022: Email notifications

- **Status:** Accepted
- **Date:** 2026-09-26

## Context

People expect to hear about their money without opening the app: a payment received, a withdrawal sent or failed, a transfer. Organizations already get every event through signed webhooks (ADR 0021). Their people still need to know when something goes wrong with a payout.

## Decision

- **Driven by domain events.** `NotificationsEventHandler` subscribes to `payment.successful`, `refund.successful`, `payout.*` and `transfer.completed`. `notificationRules()` maps each event to emails in one place:

| Event | Email |
| --- | --- |
| `payment.successful` (user wallet) | "Payment received", including when held funds become available |
| `refund.successful` (user wallet) | "Refund sent" |
| `payout.successful` / `failed` / `reversed` | To the user; `failed`/`reversed` of an organization go to its owners and admins |
| `transfer.completed` | "You sent" to the sender, "You received" to the recipient |

  Other organization events (their payments and refunds) are left to webhooks, to avoid flooding inboxes.
- **Sent once.** An `email_notifications` row, unique per event, template and recipient, is written before sending and marked `sent` afterwards. A redelivered event finds it sent and skips it. A send failure is recorded and thrown, so the domain-event job retries it. A crash exactly between "sent" and "marked" can repeat one email. That's the accepted cost of not using distributed transactions with an SMTP server.
- **Transports.**
  - `EMAIL_DRIVER=log` (the default) logs emails and keeps recent ones in memory, which tests use as an inbox.
  - `EMAIL_DRIVER=smtp` sends through any SMTP service via `SMTP_URL` (nodemailer). Production with the log driver starts, but logs a warning.
- **Content.**
  - Plain, short messages with the amount, the reference and what happens next.
  - Rendered as both text and HTML, with every value HTML-escaped.
  - No links or account details, to reduce phishing surface.
  - Suspended users aren't emailed.

## Consequences

- Transactional emails can't be turned off by users. Marketing-style preferences are out of scope.
- New templates are a rule, not new infrastructure. Other channels, such as SMS or push, can reuse the rules with another transport.
- Localisation, branded templates and per-organization sender identities are later steps.
