# Security policy

FinStack moves money, so security reports are taken seriously and handled first.

## Reporting a vulnerability

**Please don't open a public issue.** Report privately through GitHub: go to the repository's **Security** tab and choose **Report a vulnerability** (private vulnerability reporting).

Please include:

- what the issue is and where (file, endpoint or flow)
- how to reproduce it, ideally against a local setup or the sandbox
- the impact you think it has

You'll get an acknowledgement within **3 working days**, and updates as it's investigated. Once a fix is released, you'll be credited in the release notes, unless you'd rather not be.

## What counts

Anything that could let someone:

- move, create or destroy money they shouldn't (ledger, wallets, payments, payouts, refunds, fees, limits)
- read or change another user's or organization's data
- bypass authentication, authorization, idempotency or webhook signature checks
- make FinStack call internal network addresses (SSRF)
- read stored secrets (API keys, webhook signing secrets, tokens)

## Supported versions

Security fixes go into the latest release. FinStack is a starter kit: if you run a fork, watch this repository's releases and apply fixes to your copy.

## Running FinStack safely

The README and the ADRs in `docs/adr/` describe the production settings. At minimum, set strong values for `JWT_ACCESS_SECRET` and `DATA_ENCRYPTION_KEY`, keep the mock provider off outside sandbox deployments, and set `METRICS_TOKEN` before exposing `/metrics`.
