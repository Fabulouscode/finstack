/**
 * What members of an organization may do. Roles are fixed bundles of
 * permissions (RBAC); API keys carry an explicit subset as scopes.
 */
export enum OrgPermission {
  ReadOrganization = 'organization:read',
  ManageOrganization = 'organization:manage',
  ManageMembers = 'members:manage',
  ReadWallets = 'wallets:read',
  ManageWallets = 'wallets:manage',
  CreatePayments = 'payments:create',
  ReadTransactions = 'transactions:read',
  ManageApiKeys = 'api_keys:manage',
  ReadAuditLogs = 'audit_logs:read',
  CreatePayouts = 'payouts:create',
  ManagePayoutDestinations = 'payout_destinations:manage',
  ManageWebhooks = 'webhooks:manage',
}

export enum OrgRole {
  Owner = 'owner',
  Admin = 'admin',
  Member = 'member',
  Viewer = 'viewer',
}

const READ = [
  OrgPermission.ReadOrganization,
  OrgPermission.ReadWallets,
  OrgPermission.ReadTransactions,
];

export const ROLE_PERMISSIONS: Readonly<
  Record<OrgRole, readonly OrgPermission[]>
> = {
  [OrgRole.Owner]: Object.values(OrgPermission),
  [OrgRole.Admin]: [
    ...READ,
    OrgPermission.ManageMembers,
    OrgPermission.ManageWallets,
    OrgPermission.CreatePayments,
    OrgPermission.ManageApiKeys,
    OrgPermission.ReadAuditLogs,
    OrgPermission.CreatePayouts,
    OrgPermission.ManagePayoutDestinations,
    OrgPermission.ManageWebhooks,
  ],
  [OrgRole.Member]: [...READ, OrgPermission.CreatePayments],
  [OrgRole.Viewer]: READ,
};

export function roleHasPermission(
  role: OrgRole,
  permission: OrgPermission,
): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Roles that can be granted through the members API (ownership is transferred, not granted). */
export const ASSIGNABLE_ROLES = [
  OrgRole.Admin,
  OrgRole.Member,
  OrgRole.Viewer,
] as const;
