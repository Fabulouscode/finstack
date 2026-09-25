# ADR 0015: Organizations, permissions and API keys

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

FinStack must serve consumer products (a user owns their money) and B2B products (a business owns the money, and several people and servers act on its behalf). B2B needs three things: an organization entity, role-based permissions for its members, and credentials for server-to-server calls that aren't a person's login.

## Decision

### Organizations and roles

- `organizations` and `organization_members`. The creator becomes the **owner**. **Exactly one owner** per organization is enforced by a partial unique index, and ownership is transferred (demote, then promote, in one transaction), never granted through the roles API.
- **Roles are fixed bundles of permissions** in code (`ROLE_PERMISSIONS`):

| Role | Permissions |
| --- | --- |
| owner | everything |
| admin | read, members:manage, wallets:manage, payments:create, api_keys:manage (not organization:manage) |
| member | read, payments:create |
| viewer | read (organization, wallets, transactions) |

- Organization-scoped routes (`/organizations/:organizationId/...`) declare their permission with `@RequireOrgPermission(...)`, enforced by `OrganizationAccessGuard`.
- **Non-members get 404, not 403**, so organization ids can't be probed. Suspended organizations are read-only.
- Platform admins (`users.role = admin`) get no implicit access to organization data.

### API keys

- **Format** `fsk_{test|live}_{8 hex}_{43 chars}`: recognisable if leaked, and the environment is visible. Only a **SHA-256 hash** is stored; the key is shown once. The prefix is a non-secret identifier.
- **Bound to one organization** and limited to **scopes**, a subset of permissions. Keys can never hold management permissions (members, keys, organization), and a member can't grant scopes beyond their own role.
- **Revocation, optional expiry** and coarse `last_used_at` tracking (at most one write per key per minute). A key of a suspended organization stops working.
- **Secure by default:** `X-API-Key` is accepted **only on routes marked `@AllowApiKey()`**; everywhere else it's rejected (`401 API_KEY_NOT_ALLOWED`). Key management itself requires a signed-in member.

## Consequences

- Adding an organization feature is one decorator per route, and exposing it to servers is one more.
- A 256-bit random key doesn't need a slow password hash: SHA-256 makes lookups O(1) and leaks nothing useful.
- Roles are code, not data: changing what "admin" means is a code change and a review, which is appropriate for a financial system. Products that need custom roles can move `ROLE_PERMISSIONS` into tables later.
- Invitations (for people without an account yet) are not included; members are added by the email of an existing user.
