import { UserRole } from '../users/user.entity';

/**
 * What platform staff may do. Roles are fixed bundles of these; admin
 * endpoints declare the one they need with @RequirePermission().
 */
export enum PlatformPermission {
  ReadOverview = 'overview:read',
  ReadUsers = 'users:read',
  ManageUsers = 'users:manage',
  ReadOrganizations = 'organizations:read',
  ManageOrganizations = 'organizations:manage',
  ReadWallets = 'wallets:read',
  ManageWallets = 'wallets:manage',
  ReadAuditLogs = 'audit:read',
  ReadPayouts = 'payouts:read',
  ManagePayouts = 'payouts:manage',
  ManageRefunds = 'refunds:manage',
  ManagePayments = 'payments:manage',
  ManageReconciliation = 'reconciliation:manage',
  ManageProviderWebhooks = 'provider_webhooks:manage',
  ManageFxRates = 'fx:manage',
  ManageFees = 'fees:manage',
  ManageLimits = 'limits:manage',
  ManageRoles = 'roles:manage',
}

const P = PlatformPermission;

/** Looking, not touching: enough for customer support. */
const SUPPORT = [
  P.ReadOverview,
  P.ReadUsers,
  P.ReadOrganizations,
  P.ReadWallets,
  P.ReadAuditLogs,
  P.ReadPayouts,
];

export const PLATFORM_ROLE_PERMISSIONS: Readonly<
  Record<UserRole, readonly PlatformPermission[]>
> = {
  [UserRole.User]: [],
  [UserRole.Support]: SUPPORT,
  /** Stops bad actors: suspensions, freezes, limits, payouts. */
  [UserRole.Risk]: [
    ...SUPPORT,
    P.ManageUsers,
    P.ManageOrganizations,
    P.ManageWallets,
    P.ManageLimits,
    P.ManagePayouts,
  ],
  /** Moves and prices money: refunds, releases, reconciliation, fees, FX. */
  [UserRole.Finance]: [
    ...SUPPORT,
    P.ManageRefunds,
    P.ManagePayments,
    P.ManageReconciliation,
    P.ManageProviderWebhooks,
    P.ManageFxRates,
    P.ManageFees,
    P.ManagePayouts,
  ],
  [UserRole.Admin]: Object.values(PlatformPermission),
};

export function roleHasPlatformPermission(
  role: UserRole,
  permission: PlatformPermission,
): boolean {
  return PLATFORM_ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
