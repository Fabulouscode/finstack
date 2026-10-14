# ADR 0032: Action proposals (agents propose, people approve)

- **Status:** Accepted
- **Date:** 2026-10-15

## Context

AI agents are starting to act on money: paying suppliers, settling invoices, fixing a payment that went wrong. An agent can read FinStack well, but letting it move money directly means a wrong answer, a prompt injection in an invoice it reads, or a stolen agent key turns straight into a payment. Asking it to "be careful" is not a control.

What we want is the agent's speed for the work (finding what needs paying, checking it, writing it up) with a person's judgement on the money, and a record of both.

## Decision

**An agent can only propose.** An action proposal (`POST /v1/organizations/:id/proposals`) records what to do (for now, a payout to a saved destination), a one-line summary, the agent's reasoning and its evidence. It moves nothing.

**Only a person can decide.** `POST …/proposals/:id/approve` and `…/reject` need `proposals:decide`, which no API key can hold: `proposals:decide` isn't in `API_KEY_SCOPES`, and the decision routes don't accept API keys at all. So a key, even one with `payouts:create`, can't approve its own proposal.

**Approval runs the normal path, once.** Approving calls `PayoutsService.request` with the Idempotency-Key `proposal:<id>`, so every existing rule applies (balance, limits, fees, destination cooling-off, the ledger) and a retry after a crash returns the same payout. The proposal row is locked while it runs, so two people approving at the same moment produce one payout and one `409`.

**Every step is recorded.** The audit log has `proposal.created` (attributed to the key or the person), `proposal.approved` (with the payout it created, or why it failed) and `proposal.rejected`.

| Status | Meaning |
| --- | --- |
| `pending` | Waiting for a decision; expires after 24 hours |
| `executed` | Approved, and the payout was created (see `result.payoutId`) |
| `failed` | Approved, but the payout was refused (e.g. insufficient balance); nothing moved |
| `rejected` | A person said no |
| `expired` | Nobody decided in time; ask the agent again |

An outage while approving (a `5xx`) leaves the proposal `pending`, so it can simply be approved again.

## Consequences

- An agent's key needs only `proposals:create` (and read scopes). Losing it lets an attacker suggest payouts, not make them.
- Destinations are checked when the proposal is made, not only on approval, so an agent can't point a payout at another organization's account.
- People still have to read what they approve. The summary, reasoning and evidence are there to make that quick, not to make it unnecessary.
- New kinds (a refund, retrying a stuck payout) are added as new `kind` values that call their existing service the same way.
