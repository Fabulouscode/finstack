# ADR 0031: `finstack listen`

- **Status:** Accepted
- **Date:** 2026-10-01

## Context

While developing, a payment completes at the provider but its webhook can't reach `localhost`, so FinStack never learns of it. Testing against real Paystack, Stripe and Flutterwave accounts meant, every session:

1. starting a tunnel
2. copying its new address
3. pasting it into each provider's dashboard
4. registering a Stripe endpoint and copying its secret

Free tunnels get a new address on every start, so steps 2 to 4 repeat each time. Stripe's own CLI avoids this with a relay that Stripe hosts. FinStack has no hosted service, and shouldn't need one.

## Decision

**Poll and deliver.** `finstack listen` runs next to FinStack. It reads `.env`, asks each enabled provider's API (with the test key) for records that finished, and posts each one to `/v1/webhooks/:provider`, signed as the provider signs webhooks:

| Provider | Source | Signed with |
|---|---|---|
| Stripe | Stripe's real events (`GET /v1/events`), delivered unchanged | `t=…,v1=` HMAC-SHA256 with the local `STRIPE_WEBHOOK_SECRET` (any value works locally; no endpoint needs to exist) |
| Paystack | Transactions and transfers, rebuilt as `charge.*` and `transfer.*` webhooks | HMAC-SHA512 with the secret key, as Paystack does |
| Flutterwave | Transactions and transfers, rebuilt as v3 `charge.completed` and `transfer.completed` webhooks | The dashboard's secret hash in `verif-hash` |

**Why this is safe.** FinStack never acts on a webhook's contents. A webhook only says which payment, refund or payout to look at, and FinStack asks the provider for its real state before moving money (ADR 0012). A rebuilt webhook is therefore exactly as trustworthy as a real one.

**Behaviour:**

- **Each event is delivered once.** It's keyed by record and status, so a later status change is a new event. On start, existing events are only noted, so nothing old floods FinStack. `--replay` sends them anyway.
- **Failed deliveries are retried** on later polls, up to 5 times. A provider error is reported once, not on every poll.
- **Test keys only.** Live keys are refused.
- It's a separate entry point (`dist/cli/finstack.js`, the `finstack` bin), and does not start the Nest application.

**Alternative rejected: a tunnel helper.** It would deliver the providers' real webhooks with their exact payloads. But it needs `cloudflared` installed, and because the address changes every run, Paystack and Flutterwave would still need the new URL pasted into their dashboards each session. That's the step this tool exists to remove.

## Consequences

- One command, nothing to configure beyond the keys already in `.env`. It works offline from the internet's point of view, since it only makes outbound calls.
- **It doesn't test providers' exact webhook payloads.** Stripe's are real; Paystack's and Flutterwave's are rebuilt. Payload formats are covered instead by tests built from real deliveries. Testing with a real Flutterwave account found its older default format this way (ADR 0030). To check a provider's payloads, use a tunnel occasionally.
- Events arrive within the polling interval (3 seconds by default), not instantly.
- Paystack and Flutterwave refunds aren't listened for: they settle through FinStack's scheduled refund re-check (ADR 0014).
- The listener's webhooks are verified in tests by FinStack's real adapters, so a change to an adapter's signature or parsing that the listener doesn't follow fails the build.
