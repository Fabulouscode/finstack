# ADR 0017: Audit logs

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

Financial systems must answer "who did this, when, and from where?" for sensitive changes, for security investigations, compliance reviews and customer disputes. Application logs can't answer it reliably: they are rotated, unstructured, and not tied to the database change they describe.

## Decision

- **An `audit_logs` table** holds one row per action:
  - the actor (`user`, `api_key` or `system`) and the organization, when relevant
  - the action as a dotted verb from a fixed vocabulary (`AuditAction`)
  - the target type and id
  - `metadata`, for example before and after values
  - the request id and client IP
- **Written in the same database transaction as the change**, via `AuditService.record(manager, entry)`. An entry exists only if the change committed, and a committed change always has its entry.
- **Append-only, enforced by the database:** a trigger rejects `UPDATE` and `DELETE`, as the ledger does.
- **The actor comes from the request context.** The auth guard puts the authenticated user or API key into `RequestContext` (AsyncLocalStorage), next to the request id and IP. Services don't need an extra parameter, and anything outside a request (workers, jobs) is recorded as `system`.
- **No foreign keys.** The trail is history: it must not block changes to the rows it mentions, or disappear with them.
- **No secrets in metadata.** API keys are logged by id and prefix, never by the secret.

### What is audited

| Area | Actions |
| --- | --- |
| Organizations | `organization.created`, `organization.renamed`, `organization.ownership_transferred` |
| Members | `member.added`, `member.role_changed`, `member.removed` |
| API keys | `api_key.created`, `api_key.revoked` |
| Wallets | `wallet.created`, `wallet.primary_changed` |
| Admin operations | `refund.requested`, `refund.retried`, `fx.rate_set`, `webhook.replayed` |
| Security | `auth.refresh_token_reuse_detected` (the session is revoked) |

Money movements themselves are not duplicated here. The ledger and transactions are already their immutable record. The audit log covers the decisions and configuration changes around them.

### Access

- `GET /v1/admin/audit-logs`: platform admins, with filters for organization, actor, action and target.
- `GET /v1/organizations/:id/audit-logs`: requires the new `audit_logs:read` permission, which owners and admins have. It is not grantable to API keys.

## Consequences

- Adding an audited action means adding it to `AuditAction` and calling `record` inside the transaction.
- The table grows without bound. Retention (for example archiving old partitions to cold storage) is an operator decision. When it's needed, time-based partitioning fits the trigger model, because old partitions can be detached rather than deleted.
- Failed attempts, such as denied permissions or wrong passwords, are not audited here. They belong in security logs and metrics, where volume is expected.
