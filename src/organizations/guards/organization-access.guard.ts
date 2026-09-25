import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OrgPermission, roleHasPermission } from '../organization-permissions';
import { OrganizationStatus } from '../organization.entity';
import {
  OrganizationNotFoundException,
  OrganizationPermissionDeniedException,
  OrganizationSuspendedException,
} from '../organizations.errors';
import { OrganizationsService } from '../organizations.service';
import { ORG_PERMISSION_KEY, OrganizationRequest } from './organization-access';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Authorises organization-scoped routes (`/organizations/:organizationId/...`):
 * the user must be a member whose role grants the route's permission.
 * Non-members get 404, so organization ids can't be probed.
 */
@Injectable()
export class OrganizationAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly organizations: OrganizationsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.get<OrgPermission | undefined>(
      ORG_PERMISSION_KEY,
      context.getHandler(),
    );
    if (!permission) {
      return true;
    }

    const request = context.switchToHttp().getRequest<OrganizationRequest>();
    const param = request.params.organizationId;
    const organizationId = typeof param === 'string' ? param : undefined;
    if (!organizationId || !UUID.test(organizationId) || !request.user) {
      throw new OrganizationNotFoundException();
    }

    const membership = await this.organizations.findMembership(
      organizationId,
      request.user.id,
    );
    if (!membership) {
      throw new OrganizationNotFoundException();
    }
    const organization = await this.organizations.get(organizationId);
    if (
      organization.status !== OrganizationStatus.Active &&
      permission !== OrgPermission.ReadOrganization
    ) {
      throw new OrganizationSuspendedException();
    }
    if (!roleHasPermission(membership.role, permission)) {
      throw new OrganizationPermissionDeniedException(permission);
    }

    request.organizationAccess = { organizationId, role: membership.role };
    return true;
  }
}
