import { SetMetadata } from '@nestjs/common';
import { AuthenticatedRequest } from '../../auth/authenticated-user';
import { OrgPermission, OrgRole } from '../organization-permissions';

export const ORG_PERMISSION_KEY = 'finstack:org-permission';

/**
 * Requires the caller to hold `permission` (or any one of several) in the
 * organization named by the `:organizationId` route parameter. Use with
 * OrganizationAccessGuard.
 */
export const RequireOrgPermission = (
  ...permissions: [OrgPermission, ...OrgPermission[]]
): MethodDecorator => SetMetadata(ORG_PERMISSION_KEY, permissions);

/** Resolved by OrganizationAccessGuard and available to handlers. */
export interface OrganizationAccess {
  organizationId: string;
  /** Present when acting as a member (JWT). */
  role?: OrgRole;
  /** Present when acting through an API key. */
  apiKeyId?: string;
}

export interface OrganizationRequest extends AuthenticatedRequest {
  organizationAccess?: OrganizationAccess;
}
