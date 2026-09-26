import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../users/user.entity';
import { InsufficientRoleException } from '../auth.errors';
import { AuthenticatedRequest } from '../authenticated-user';
import { PLATFORM_PERMISSION_KEY } from '../decorators/require-permission.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import {
  PlatformPermission,
  roleHasPlatformPermission,
} from '../platform-permissions';

/**
 * Enforces @RequirePermission() (platform permissions, via the caller's
 * role) and @Roles(). Runs after JwtAuthGuard; routes with neither pass.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const permission = this.reflector.getAllAndOverride<
      PlatformPermission | undefined
    >(PLATFORM_PERMISSION_KEY, [context.getHandler(), context.getClass()]);
    if (permission) {
      const user = context
        .switchToHttp()
        .getRequest<AuthenticatedRequest>().user;
      if (!user || !roleHasPlatformPermission(user.role, permission)) {
        throw new InsufficientRoleException(permission);
      }
      return true;
    }

    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!roles || roles.length === 0) {
      return true;
    }

    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user || !roles.includes(user.role)) {
      throw new InsufficientRoleException();
    }
    return true;
  }
}
